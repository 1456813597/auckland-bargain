/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { RawOffer } from '../lib/collectors/types';
import {
  mirrorOfferImages,
  monthlyUploadBudget,
  productImagePath,
  seedProductImageIndex,
  type BlobClient,
  type MirrorDatabase,
} from '../lib/storage/product-images';

const environment = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test' };

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

function fakeDatabase(
  grant: (requested: number, limit: number) => number = (requested) =>
    requested,
) {
  const stored = new Map<string, StoredRow>();
  const selects: string[][] = [];
  const claims: { requested: number; limit: number }[] = [];
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
    rpc: (name: string, parameters: Record<string, number>) => {
      assert.equal(name, 'claim_blob_upload_slots');
      claims.push({
        requested: parameters.p_requested,
        limit: parameters.p_monthly_limit,
      });
      return Promise.resolve({
        data: grant(parameters.p_requested, parameters.p_monthly_limit),
        error: null,
      });
    },
  };
  return {
    database: database as unknown as MirrorDatabase,
    stored,
    selects,
    claims,
  };
}

function fakeBlob() {
  const puts: string[] = [];
  const heads: string[] = [];
  const blob: BlobClient = {
    put: (pathname) => {
      puts.push(pathname);
      return Promise.resolve({
        url: `https://store.public.blob.vercel-storage.com/${pathname}`,
      });
    },
    head: (pathname) => {
      heads.push(pathname);
      return Promise.resolve({
        url: `https://store.public.blob.vercel-storage.com/${pathname}`,
      });
    },
  };
  return { blob, puts, heads };
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

test('an image already recorded in the index costs no blob operation', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const pathname = productImagePath('paknsave', offers[0]);
  const { database, stored, claims } = fakeDatabase();
  stored.set(pathname, {
    pathname,
    blob_url: `https://store.public.blob.vercel-storage.com/${pathname}`,
    status: 'mirrored',
    retry_after: null,
  });
  const { blob, puts, heads } = fakeBlob();
  const { fetchImage, requested } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment,
    fetchImage,
  });

  assert.equal(
    mirrored[0].imageUrl,
    `https://store.public.blob.vercel-storage.com/${pathname}`,
  );
  assert.deepEqual([puts, heads, requested, claims], [[], [], [], []]);
});

test('a second store sharing the product pays nothing after the first upload', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, claims } = fakeDatabase();
  const { blob, puts } = fakeBlob();
  const { fetchImage } = fakeFetch();
  const run = () =>
    mirrorOfferImages('paknsave', offers, {
      database,
      blob,
      environment,
      fetchImage,
    });

  const first = await run();
  const second = await run();

  assert.equal(puts.length, 1);
  assert.equal(claims.length, 1);
  assert.equal(second[0].imageUrl, first[0].imageUrl);
});

test('an image that cannot be fetched is not retried within its retry window', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, stored, claims } = fakeDatabase();
  const { blob, puts } = fakeBlob();
  let attempts = 0;
  const fetchImage = (() => {
    attempts += 1;
    return Promise.resolve(new Response('missing', { status: 404 }));
  }) as unknown as typeof fetch;

  const options = { database, blob, environment, fetchImage };
  const first = await mirrorOfferImages('paknsave', offers, options);
  const second = await mirrorOfferImages('paknsave', offers, options);

  assert.equal(attempts, 1);
  assert.deepEqual([puts.length, claims.length], [0, 1]);
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
    blob_url: null,
    status: 'failed',
    retry_after: '2026-01-01T00:00:00.000Z',
  });
  const { blob, puts } = fakeBlob();
  const { fetchImage } = fakeFetch();

  await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment,
    fetchImage,
    now: () => new Date('2026-09-07T00:00:00.000Z'),
  });

  assert.equal(puts.length, 1);
});

test('one run never claims more budget than it can spend', async () => {
  const offers = Array.from({ length: 120 }, (_, index) =>
    offer(`p${index}`, `https://cdn.example/${index}.jpg`),
  );
  const { database, claims } = fakeDatabase();
  const { blob, puts } = fakeBlob();
  const { fetchImage } = fakeFetch();

  await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment,
    fetchImage,
  });

  assert.deepEqual(claims, [{ requested: 48, limit: 8_000 }]);
  assert.equal(puts.length, 48);
});

test('an exhausted monthly budget keeps retailer URLs instead of uploading', async () => {
  const offers = [
    offer('a', 'https://cdn.example/a.jpg'),
    offer('b', 'https://cdn.example/b.jpg'),
  ];
  const { database, claims } = fakeDatabase(() => 1);
  const { blob, puts } = fakeBlob();
  const { fetchImage } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment,
    fetchImage,
  });

  assert.deepEqual(claims, [{ requested: 2, limit: 8_000 }]);
  assert.equal(puts.length, 1);
  assert.equal(mirrored[1].imageUrl, 'https://cdn.example/b.jpg');
});

test('a zero budget mirrors nothing but still serves indexed images', async () => {
  const offers = [
    offer('a', 'https://cdn.example/a.jpg'),
    offer('b', 'https://cdn.example/b.jpg'),
  ];
  const { database, stored } = fakeDatabase(() => 0);
  const known = productImagePath('paknsave', offers[0]);
  stored.set(known, {
    pathname: known,
    blob_url: `https://store.public.blob.vercel-storage.com/${known}`,
    status: 'mirrored',
    retry_after: null,
  });
  const { blob, puts } = fakeBlob();
  const { fetchImage } = fakeFetch();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment: { ...environment, PRODUCT_IMAGE_MIRROR_MONTHLY_UPLOADS: '0' },
    fetchImage,
  });

  assert.equal(puts.length, 0);
  assert.equal(
    mirrored[0].imageUrl,
    `https://store.public.blob.vercel-storage.com/${known}`,
  );
  assert.equal(mirrored[1].imageUrl, 'https://cdn.example/b.jpg');
});

test('the mirror can be switched off without unlinking the blob store', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const { database, selects } = fakeDatabase();
  const { blob, puts } = fakeBlob();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment: { ...environment, PRODUCT_IMAGE_MIRROR: 'off' },
  });

  assert.deepEqual([selects.length, puts.length], [0, 0]);
  assert.equal(mirrored[0].imageUrl, 'https://cdn.example/a.jpg');
});

test('an unreadable index serves retailer URLs instead of re-uploading', async () => {
  const offers = [offer('a', 'https://cdn.example/a.jpg')];
  const database = {
    from: () => ({
      select: () => ({
        in: () =>
          Promise.resolve({ data: null, error: { message: 'unavailable' } }),
      }),
    }),
    rpc: () => assert.fail('Budget must not be claimed without the index.'),
  } as unknown as MirrorDatabase;
  const { blob, puts } = fakeBlob();

  const mirrored = await mirrorOfferImages('paknsave', offers, {
    database,
    blob,
    environment,
  });

  assert.equal(puts.length, 0);
  assert.equal(mirrored[0].imageUrl, 'https://cdn.example/a.jpg');
});

test('offers without an image never reach the index or the blob store', async () => {
  const { database, selects } = fakeDatabase();
  const { blob, puts } = fakeBlob();

  const mirrored = await mirrorOfferImages('paknsave', [offer('a', null)], {
    database,
    blob,
    environment,
  });

  assert.deepEqual([selects.length, puts.length], [0, 0]);
  assert.equal(mirrored[0].imageUrl, null);
});

test('a monthly upload budget must be an exact non-negative integer', () => {
  assert.equal(monthlyUploadBudget({}), 8_000);
  assert.equal(
    monthlyUploadBudget({ PRODUCT_IMAGE_MIRROR_MONTHLY_UPLOADS: '12' }),
    12,
  );
  for (const value of ['-1', '1.5', '8_000', '12 uploads', '1000001']) {
    assert.throws(
      () =>
        monthlyUploadBudget({ PRODUCT_IMAGE_MIRROR_MONTHLY_UPLOADS: value }),
      /must be an integer/,
    );
  }
});

test('seeding adopts existing blobs and previews before it writes', async () => {
  const { database, stored } = fakeDatabase();
  const pages = [
    {
      blobs: [
        {
          pathname: 'product-images/paknsave/a-0123456789abcdef.jpg',
          url: 'https://store.public.blob.vercel-storage.com/product-images/paknsave/a-0123456789abcdef.jpg',
        },
      ],
      cursor: 'next',
      hasMore: true,
    },
    {
      blobs: [
        {
          pathname: 'product-images/woolworths/b-0123456789abcdef.png',
          url: 'https://store.public.blob.vercel-storage.com/product-images/woolworths/b-0123456789abcdef.png',
        },
      ],
      hasMore: false,
    },
  ];
  const list = (options: { cursor?: string }) =>
    Promise.resolve(pages[options.cursor ? 1 : 0]);

  const preview = await seedProductImageIndex({ database, list });
  assert.deepEqual(
    [preview.mode, preview.listPages, preview.adopted, preview.written],
    ['preview', 2, 2, 0],
  );
  assert.equal(stored.size, 0);

  const executed = await seedProductImageIndex({
    database,
    list,
    execute: true,
  });
  assert.deepEqual([executed.mode, executed.written], ['execute', 2]);
  assert.equal(
    stored.get('product-images/woolworths/b-0123456789abcdef.png')
      ?.retailer_slug,
    'woolworths',
  );
});

describe('blob upload budget in Postgres', () => {
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

  async function claim(requested: number, limit: number) {
    return (
      await db.query<{ granted: number }>(
        'select claim_blob_upload_slots($1, $2) as granted',
        [requested, limit],
      )
    ).rows[0].granted;
  }

  it('grants only what is left of the monthly limit', async () => {
    assert.equal(await claim(40, 100), 40);
    assert.equal(await claim(80, 100), 60);
    assert.equal(await claim(10, 100), 0);
    const { rows } = await db.query<{ uploads: number }>(
      'select uploads from blob_upload_budget',
    );
    assert.deepEqual(rows, [{ uploads: 100 }]);
  });

  it('rejects negative requests and limits', async () => {
    await assert.rejects(() => claim(-1, 100), /must not be negative/);
    await assert.rejects(() => claim(1, -1), /must not be negative/);
  });

  it('reports the mirror index in database readiness', async () => {
    const { rows } = await db.query<{
      result: { productImageMirrorIndex: boolean; schemaVersion: string };
    }>('select database_readiness() as result');
    assert.equal(rows[0].result.productImageMirrorIndex, true);
    assert.equal(rows[0].result.schemaVersion, '20260907140000');
  });
});
