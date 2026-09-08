/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { RawOffer } from '../lib/collectors/types';
import {
  createFilesystemImageStore,
  type ImageStore,
} from '../lib/storage/image-store';
import {
  adoptStoredImages,
  imageStoreByteLimit,
  mirrorOfferImages,
  productImagePath,
  type MirrorDatabase,
} from '../lib/storage/product-images';

const environment: Record<string, string | undefined> = {};

function offer(sourceProductId: string, imageUrl: string | null): RawOffer {
  return {
    sourceProductId,
    sourceName: `Product ${sourceProductId}`,
    brand: null,
    category: null,
    size: null,
    gtin: null,
    imageUrl,
    sourceUrl: `https://retailer.example/${sourceProductId}`,
    regularPriceCents: 500,
    promoPriceCents: null,
    memberPriceCents: null,
    promotionType: null,
    promotionText: null,
    validUntil: null,
    collectedAt: new Date('2026-09-07T00:00:00.000Z'),
  };
}

type StoredRow = Record<string, unknown> & { pathname: string };

function fakeDatabase(usedBytes = 0) {
  const stored = new Map<string, StoredRow>();
  const selects: string[][] = [];
  const usageReads: number[] = [];
  const database = {
    from(table: string) {
      assert.equal(table, 'product_image_mirrors');
      return {
        select: () => ({
          in: (_column: string, values: string[]) => {
            selects.push(values);
            return Promise.resolve({
              data: values.flatMap((value) => {
                const row = stored.get(value);
                return row ? [row] : [];
              }),
              error: null,
            });
          },
        }),
        upsert: (rows: StoredRow[]) => {
          for (const row of rows) stored.set(row.pathname, row);
          return Promise.resolve({ error: null });
        },
      };
    },
    rpc: (name: string) => {
      assert.equal(name, 'product_image_store_bytes');
      usageReads.push(usedBytes);
      return Promise.resolve({ data: usedBytes, error: null });
    },
  };
  return {
    database: database as unknown as MirrorDatabase,
    stored,
    selects,
    usageReads,
  };
}

function fakeStore() {
  const written = new Map<string, number>();
  const puts: string[] = [];
  const heads: string[] = [];
  const store: ImageStore = {
    head: (pathname) => {
      heads.push(pathname);
      const byteSize = written.get(pathname);
      return Promise.resolve(
        byteSize === undefined ? null : { url: `/${pathname}`, byteSize },
      );
    },
    put: (pathname, body) => {
      puts.push(pathname);
      written.set(pathname, body.byteLength);
      return Promise.resolve({
        url: `/${pathname}`,
        byteSize: body.byteLength,
      });
    },
  };
  return { store, puts, heads, written };
}

function fakeFetch() {
  const requested: string[] = [];
  const fetchImage = ((url: string) => {
    requested.push(url);
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImage, requested };
}

test('an image already recorded in the index is never touched again', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const pathname = productImagePath('paknsave', offers[0]);
  const { database, stored, usageReads } = fakeDatabase();
  stored.set(pathname, {
    pathname,
    stored_url: `/${pathname}`,
    status: 'mirrored',
    retry_after: null,
  });
  const { store, puts, heads } = fakeStore();
  const { fetchImage, requested } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment,
    fetchImage,
  });

  assert.equal(mirrored[0].imageUrl, `/${pathname}`);
  assert.deepEqual([puts, heads, requested, usageReads], [[], [], [], []]);
});

test('a second store sharing the product downloads nothing more', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database } = fakeDatabase();
  const { store, puts } = fakeStore();
  const { fetchImage, requested } = fakeFetch();
  const run = () =>
    mirrorOfferImages('paknsave', offers, {
      database,
      store,
      environment,
      fetchImage,
    });

  const first = await run();
  const second = await run();

  assert.deepEqual([puts.length, requested.length], [1, 1]);
  assert.equal(second[0].imageUrl, first[0].imageUrl);
});

test('a file already on disk is adopted without downloading it again', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const pathname = productImagePath('paknsave', offers[0]);
  const { database, stored } = fakeDatabase();
  const { store, puts, written } = fakeStore();
  written.set(pathname, 1_024);
  const { fetchImage, requested } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment,
    fetchImage,
  });

  assert.deepEqual([puts.length, requested.length], [0, 0]);
  assert.equal(mirrored[0].imageUrl, `/${pathname}`);
  assert.equal(stored.get(pathname)?.byte_size, 1_024);
});

test('an image that cannot be fetched is not retried within its retry window', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, stored } = fakeDatabase();
  const { store, puts } = fakeStore();
  let attempts = 0;
  const fetchImage = (() => {
    attempts += 1;
    return Promise.resolve(new Response('missing', { status: 404 }));
  }) as unknown as typeof fetch;

  const options = { database, store, environment, fetchImage };
  const first = await mirrorOfferImages('paknsave', offers, options);
  const second = await mirrorOfferImages('paknsave', offers, options);

  assert.equal(attempts, 1);
  assert.equal(puts.length, 0);
  assert.equal(first[0].imageUrl, 'https://cdn.example/a.jpg');
  assert.equal(second[0].imageUrl, 'https://cdn.example/a.jpg');
  const row = stored.get(productImagePath('paknsave', offers[0]))!;
  assert.equal(row.status, 'failed');
  assert.ok(typeof row.retry_after === 'string');
});

test('a failed image is retried once its retry window has passed', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, stored } = fakeDatabase();
  stored.set(productImagePath('paknsave', offers[0]), {
    pathname: productImagePath('paknsave', offers[0]),
    stored_url: null,
    status: 'failed',
    retry_after: '2026-01-01T00:00:00.000Z',
  });
  const { store, puts } = fakeStore();
  const { fetchImage } = fakeFetch();

  await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment,
    fetchImage,
    now: () => new Date('2026-09-07T00:00:00.000Z'),
  });

  assert.equal(puts.length, 1);
});

test('one run mirrors at most the per-run maximum', async () => {
  const offers = Array.from({ length: 120 }, (_, index) =>
    offer(`p${index}`, `https://cdn.example/${index}.jpg`),
  );
  const { database, usageReads } = fakeDatabase();
  const { store, puts } = fakeStore();
  const { fetchImage } = fakeFetch();

  await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment,
    fetchImage,
  });

  assert.equal(usageReads.length, 1);
  assert.equal(puts.length, 48);
});

test('a full store keeps retailer URLs instead of writing more files', async () => {
  const offers = [
    offer('a', 'https://cdn.example/a.jpg'),
    offer('b', 'https://cdn.example/b.jpg'),
  ];
  const { database } = fakeDatabase(9_000);
  const { store, puts } = fakeStore();
  const { fetchImage } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment: { PRODUCT_IMAGE_MIRROR_MAX_BYTES: '9000' },
    fetchImage,
  });

  assert.equal(puts.length, 0);
  assert.equal(mirrored[0].imageUrl, 'https://cdn.example/a.jpg');
  assert.equal(mirrored[1].imageUrl, 'https://cdn.example/b.jpg');
});

test('a store at its limit still serves images already indexed', async () => {
  const offers = [
    offer('a', 'https://cdn.example/a.jpg'),
    offer('b', 'https://cdn.example/b.jpg'),
  ];
  const { database, stored } = fakeDatabase(10);
  const known = productImagePath('paknsave', offers[0]);
  stored.set(known, {
    pathname: known,
    stored_url: `/${known}`,
    status: 'mirrored',
    retry_after: null,
  });
  const { store, puts } = fakeStore();
  const { fetchImage } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment: { PRODUCT_IMAGE_MIRROR_MAX_BYTES: '0' },
    fetchImage,
  });

  assert.equal(puts.length, 0);
  assert.equal(mirrored[0].imageUrl, `/${known}`);
  assert.equal(mirrored[1].imageUrl, 'https://cdn.example/b.jpg');
});

test('the mirror can be switched off without removing the stored files', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, selects } = fakeDatabase();
  const { store, puts } = fakeStore();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment: { PRODUCT_IMAGE_MIRROR: 'off' },
  });

  assert.deepEqual([selects.length, puts.length], [0, 0]);
  assert.equal(mirrored[0].imageUrl, 'https://cdn.example/a.jpg');
});

test('an unreadable index serves retailer URLs instead of re-downloading', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const database = {
    from: () => ({
      select: () => ({
        in: () =>
          Promise.resolve({ data: null, error: { message: 'unavailable' } }),
      }),
    }),
    rpc: () => assert.fail('Store usage must not be read without the index.'),
  } as unknown as MirrorDatabase;
  const { store, puts } = fakeStore();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    store,
    environment,
  });

  assert.equal(puts.length, 0);
  assert.equal(mirrored[0].imageUrl, 'https://cdn.example/a.jpg');
});

test('offers without an image never reach the index or the store', async () => {
  const { database, selects } = fakeDatabase();
  const { store, puts } = fakeStore();

  const mirrored = await mirrorOfferImages('paknsave', [offer('a', null)], {
    database,
    store,
    environment,
  });

  assert.deepEqual([selects.length, puts.length], [0, 0]);
  assert.equal(mirrored[0].imageUrl, null);
});

test('the store byte ceiling must be an exact non-negative integer', () => {
  assert.equal(imageStoreByteLimit({}), 8 * 1024 * 1024 * 1024);
  assert.equal(
    imageStoreByteLimit({ PRODUCT_IMAGE_MIRROR_MAX_BYTES: '12' }),
    12,
  );
  for (const value of ['-1', '1.5', '8_000', '12 bytes', '1099511627777']) {
    assert.throws(
      () => imageStoreByteLimit({ PRODUCT_IMAGE_MIRROR_MAX_BYTES: value }),
      /must be an integer/,
    );
  }
});

describe('the filesystem store', () => {
  let directory: string;
  let environment: Record<string, string | undefined>;
  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'auckland-images-'));
    environment = { PRODUCT_IMAGE_DIR: directory };
  });

  it('writes, reads back and reports the size of an image', async () => {
    const store = createFilesystemImageStore(environment);
    const pathname = 'product-images/paknsave/a-0123456789abcdef.jpg';
    assert.equal(await store.head(pathname), null);

    const written = await store.put(
      pathname,
      new Uint8Array([1, 2, 3, 4]).buffer,
      { contentType: 'image/jpeg' },
    );
    assert.deepEqual(written, { url: `/${pathname}`, byteSize: 4 });
    assert.deepEqual(await store.head(pathname), written);
    assert.deepEqual(
      [
        ...(await readFile(
          path.join(directory, 'paknsave/a-0123456789abcdef.jpg'),
        )),
      ],
      [1, 2, 3, 4],
    );
    // Nothing is left behind by the write-then-rename.
    assert.deepEqual(
      (await readdir(path.join(directory, 'paknsave'))).filter((file) =>
        file.endsWith('.tmp'),
      ),
      [],
    );
  });

  it('refuses a pathname that could escape the directory', async () => {
    const store = createFilesystemImageStore(environment);
    for (const pathname of [
      'product-images/../secrets.jpg',
      'product-images/paknsave/../../etc/passwd',
      'other-prefix/paknsave/a-0123456789abcdef.jpg',
      'product-images/paknsave/a-0123456789abcdef.txt',
    ]) {
      await assert.rejects(
        () =>
          store.put(pathname, new Uint8Array([1]).buffer, {
            contentType: 'image/jpeg',
          }),
        /unsupported image pathname/i,
      );
    }
  });

  it('adopts files found on disk, previewing before it writes', async () => {
    const adoptDirectory = await mkdtemp(
      path.join(tmpdir(), 'auckland-adopt-'),
    );
    const adoptEnvironment = { PRODUCT_IMAGE_DIR: adoptDirectory };
    await mkdir(path.join(adoptDirectory, 'paknsave'), { recursive: true });
    await mkdir(path.join(adoptDirectory, 'woolworths'), { recursive: true });
    await writeFile(
      path.join(adoptDirectory, 'paknsave/a-0123456789abcdef.jpg'),
      new Uint8Array([1, 2]),
    );
    await writeFile(
      path.join(adoptDirectory, 'woolworths/b-0123456789abcdef.png'),
      new Uint8Array([1, 2, 3]),
    );
    // Not a recognised image pathname, so it is not registered.
    await writeFile(path.join(adoptDirectory, 'woolworths/notes.txt'), 'skip');

    const { database, stored } = fakeDatabase();
    const preview = await adoptStoredImages({
      database,
      environment: adoptEnvironment,
    });
    assert.deepEqual(
      [preview.mode, preview.found, preview.bytes, preview.written],
      ['preview', 2, 5, 0],
    );
    assert.equal(stored.size, 0);

    const executed = await adoptStoredImages({
      database,
      environment: adoptEnvironment,
      execute: true,
    });
    assert.deepEqual([executed.mode, executed.written], ['execute', 2]);
    assert.equal(
      stored.get('product-images/woolworths/b-0123456789abcdef.png')
        ?.retailer_slug,
      'woolworths',
    );
  });
});

describe('the product image store index in Postgres', () => {
  let db: PGlite;
  before(async () => {
    db = await PGlite.create();
    await db.exec(
      'create role anon; create role authenticated; create role service_role bypassrls;',
    );
    for (const file of (await readdir('supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  });
  after(async () => {
    await db?.close();
  });

  it('sums only the bytes of images that are actually stored', async () => {
    await db.exec(`
      insert into product_image_mirrors
        (pathname, retailer_slug, stored_url, byte_size, status, retry_after)
      values
        ('product-images/paknsave/a-0123456789abcdef.jpg', 'paknsave', '/product-images/paknsave/a-0123456789abcdef.jpg', 400, 'mirrored', null),
        ('product-images/paknsave/b-0123456789abcdef.jpg', 'paknsave', '/product-images/paknsave/b-0123456789abcdef.jpg', 600, 'mirrored', null),
        ('product-images/paknsave/c-0123456789abcdef.jpg', 'paknsave', null, null, 'failed', now());
    `);
    const { rows } = await db.query<{ bytes: string }>(
      'select product_image_store_bytes() as bytes',
    );
    assert.equal(Number(rows[0].bytes), 1_000);
  });

  it('rejects a stored URL that is neither a local path nor https', async () => {
    await assert.rejects(
      () =>
        db.exec(`
          insert into product_image_mirrors
            (pathname, retailer_slug, stored_url, status)
          values
            ('product-images/paknsave/d-0123456789abcdef.jpg', 'paknsave', 'file:///etc/passwd', 'mirrored');
        `),
      /stored_url/,
    );
  });

  it('reports the mirror index in database readiness', async () => {
    const { rows } = await db.query<{
      result: { productImageMirrorIndex: boolean; schemaVersion: string };
    }>('select database_readiness() as result');
    assert.equal(rows[0].result.productImageMirrorIndex, true);
    assert.equal(rows[0].result.schemaVersion, '20260909120000');
  });
});
