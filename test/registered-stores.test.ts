/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  parseStoreRegistry,
  planStoreCollections,
  type RegisteredStore,
} from '../lib/collection/store-registry';
import {
  collectRegisteredStore,
  createRegisteredCollector,
} from '../lib/collection/registered-collector';
import { refreshRegisteredStores } from '../lib/collection/registered-refresh';
import type { CompleteCollection } from '../lib/collectors/types';
import type {
  LocalDealsSnapshot,
  LocalRetailerSnapshot,
} from '../lib/local-deals';

const now = new Date('2026-09-07T00:00:00Z');
function target(id = 'north'): RegisteredStore {
  return {
    id,
    retailer: 'freshchoice',
    sourceStoreId: id,
    name: `FreshChoice ${id}`,
    city: 'Auckland',
    storeOrigin: `https://${id}.store.freshchoice.co.nz`,
    enabled: true,
    scope: 'catalogue',
    access: {
      status: 'approved',
      reference: 'TEST-ONLY permission fixture; not a real source licence',
    },
  };
}
const registry = (...stores: RegisteredStore[]) => ({
  schemaVersion: 1 as const,
  stores,
});
function metadata(
  store: RegisteredStore,
  collectedAt = '2026-08-31T00:00:00Z',
): LocalRetailerSnapshot {
  return {
    slug: store.retailer,
    name: 'FreshChoice',
    store,
    scope: store.scope,
    dealCount: 1,
    collectedAt,
  };
}
function collection(store: RegisteredStore): CompleteCollection {
  return {
    store,
    scope: store.scope,
    pagesCollected: 1,
    totalItemsReported: 1,
    offers: [
      {
        sourceProductId: 'milk',
        sourceName: 'Anchor Milk 2L',
        brand: 'Anchor',
        category: 'Dairy',
        size: '2L',
        gtin: null,
        imageUrl: null,
        sourceUrl: `${store.storeOrigin}/lines/milk`,
        regularPriceCents: 500,
        promoPriceCents: null,
        memberPriceCents: null,
        promotionType: null,
        promotionText: null,
        validUntil: null,
        collectedAt: now,
      },
    ],
  };
}
const empty = (): LocalDealsSnapshot => ({
  schemaVersion: 1,
  generatedAt: null,
  retailers: [],
  deals: [],
});

test('bundled store registry is explicit, known-snapshot coverage with all access pending', async () => {
  const data = parseStoreRegistry(
    JSON.parse(
      await readFile(new URL('../data/stores.json', import.meta.url), 'utf8'),
    ) as unknown,
  );
  assert.equal(data.stores.length, 6);
  assert.ok(data.stores.every((store) => store.access.status === 'pending'));
  assert.ok(
    planStoreCollections(data, [], now).every(
      (job) =>
        job.status === 'blocked' && job.reasons.includes('access-pending'),
    ),
  );
});

test('registry rejects duplicate targets, ambiguous fields, secrets and unsupported connection origins', () => {
  assert.equal(
    parseStoreRegistry(registry(target())).stores[0].storeOrigin,
    'https://north.store.freshchoice.co.nz',
  );
  assert.throws(
    () => parseStoreRegistry(registry(target(), target())),
    /unique/,
  );
  assert.throws(
    () =>
      parseStoreRegistry(
        registry(target(), { ...target('other'), sourceStoreId: 'north' }),
      ),
    /Duplicate source/,
  );
  assert.throws(
    () =>
      parseStoreRegistry(
        registry(target(), {
          ...target('other'),
          storeOrigin: target().storeOrigin,
        }),
      ),
    /Duplicate storefront/,
  );
  const invalid: unknown[] = [
    { ...target(), retailer: '__proto__' },
    { ...target(), scope: ['catalogue'] },
    { ...target(), access: { status: ['approved'], reference: 'test' } },
    { ...target(), access: { status: 'approved' } },
    {
      ...target(),
      access: {
        status: 'approved',
        reference: 'test',
        expiresAt: '2026-02-30T00:00:00Z',
      },
    },
    { ...target(), cookie: 'a-secret' },
    { ...target(), cookieEnv: 'SUPABASE_SECRET_KEY' },
    { ...target(), sourceStoreId: 'store\nheader' },
  ];
  for (const store of invalid)
    assert.throws(() =>
      parseStoreRegistry({ schemaVersion: 1, stores: [store] }),
    );
  for (const storeOrigin of [
    'http://north.store.freshchoice.co.nz',
    'https://127.0.0.1',
    'https://north.store.freshchoice.co.nz.attacker.test',
    'https://north.store.supervalue.co.nz',
    'https://u:p@north.store.freshchoice.co.nz',
    'https://north.store.freshchoice.co.nz/specials',
    'https://north.store.freshchoice.co.nz?token=secret',
  ])
    assert.throws(() =>
      parseStoreRegistry(registry({ ...target(), storeOrigin })),
    );
});

test('Woolworths registry stores only scoped credential variable names, not values', () => {
  const store = {
    ...target(),
    retailer: 'woolworths' as const,
    storeOrigin: undefined,
    scope: 'specials' as const,
    cookieEnv: 'WOOLWORTHS_COOKIE_NORTH',
  };
  assert.equal(
    parseStoreRegistry(registry(store)).stores[0].cookieEnv,
    'WOOLWORTHS_COOKIE_NORTH',
  );
  for (const cookieEnv of [undefined, 'SUPABASE_SECRET_KEY', 'session=secret'])
    assert.throws(() => parseStoreRegistry(registry({ ...store, cookieEnv })));
  assert.deepEqual(planStoreCollections(registry(store), [], now)[0].reasons, [
    'credential-missing',
  ]);
  const plan = planStoreCollections(registry(store), [], now, {
    WOOLWORTHS_COOKIE_NORTH: 'TEST_SECRET',
  });
  assert.equal(plan[0].status, 'due');
  assert.ok(!JSON.stringify(plan).includes('TEST_SECRET'));
});

test('weekly plans isolate stores, legacy specials and complete-catalogue upgrades', () => {
  const north = target();
  const south = target('south');
  const previous = [metadata(north, now.toISOString()), metadata(south)];
  const plan = planStoreCollections(registry(south, north), previous, now);
  assert.deepEqual(
    plan.map(({ id, status }) => ({ id, status })),
    [
      { id: 'north', status: 'current' },
      { id: 'south', status: 'due' },
    ],
  );
  assert.notEqual(plan[0].jobKey, plan[1].jobKey);
  assert.equal(
    plan[0].jobKey,
    planStoreCollections(
      registry(north),
      [],
      new Date('2026-09-08T00:00:00Z'),
    )[0].jobKey,
  );
  assert.notEqual(
    plan[0].jobKey,
    planStoreCollections(
      registry(north),
      [],
      new Date('2026-09-14T00:00:00Z'),
    )[0].jobKey,
  );
  assert.equal(
    planStoreCollections(
      registry(north),
      [{ ...metadata(north, now.toISOString()), scope: undefined }],
      now,
    )[0].status,
    'due',
  );
  assert.deepEqual(
    planStoreCollections(
      registry({ ...north, scope: 'specials' }),
      previous,
      now,
    )[0].reasons,
    ['scope-downgrade'],
  );
});

test('weekly planner uses NZ week boundaries through daylight saving and rejects future snapshots', () => {
  const store = target();
  for (const [instant, week] of [
    ['2026-09-27T10:59:59Z', '2026-09-21'],
    ['2026-09-27T11:00:00Z', '2026-09-28'],
  ])
    assert.equal(
      planStoreCollections(registry(store), [], new Date(instant))[0].weekStart,
      week,
    );
  assert.deepEqual(
    planStoreCollections(
      registry(store),
      [metadata(store, '2026-09-08T00:00:00Z')],
      now,
    )[0].reasons,
    ['future-snapshot'],
  );
  assert.deepEqual(
    planStoreCollections(registry(store), [metadata(store, 'bad date')], now)[0]
      .reasons,
    ['invalid-snapshot-date'],
  );
  assert.equal(
    planStoreCollections(registry({ ...store, enabled: false }), [], now)[0]
      .status,
    'disabled',
  );
});

test('pending, denied, expired and unsupported jobs fail before constructing a source client', async () => {
  let created = 0;
  const createCollector: typeof createRegisteredCollector = () => {
    created++;
    throw new Error('Must not construct');
  };
  for (const store of [
    { ...target(), access: { status: 'pending' as const } },
    { ...target(), access: { status: 'denied' as const } },
    { ...target(), enabled: false },
    {
      ...target(),
      access: { ...target().access, expiresAt: now.toISOString() },
    },
    { ...target(), retailer: 'paknsave' as const, storeOrigin: undefined },
  ])
    await assert.rejects(
      collectRegisteredStore(store, { environment: {}, now, createCollector }),
      /No source requested/,
    );
  assert.equal(created, 0);
});

test('registered collection verifies identity before and after fetching catalogue data', async () => {
  let catalogueCalls = 0;
  const store = target();
  const client = (resolvedId: string, result = collection(store)) => ({
    retailerSlug: 'freshchoice',
    getStores: async () => [{ ...store, sourceStoreId: resolvedId }],
    getSpecials: async () => [],
    collectSpecials: async () => {
      throw new Error('Must not fall back');
    },
    collectCatalogue: async () => {
      catalogueCalls++;
      return result;
    },
  });
  await assert.rejects(
    collectRegisteredStore(store, {
      environment: {},
      now,
      createCollector: () => client('wrong'),
    }),
    /identity mismatch/,
  );
  assert.equal(catalogueCalls, 0);
  await assert.rejects(
    collectRegisteredStore(store, {
      environment: {},
      now,
      createCollector: () => client('north', collection(target('wrong'))),
    }),
    /identity changed/,
  );
  const result = await collectRegisteredStore(store, {
    environment: {},
    now,
    createCollector: () => client('north'),
  });
  assert.equal(result.offers.length, 1);
  assert.equal(result.scope, 'catalogue');
});

test('registered refresh checkpoints successful stores and retries only failed stores in the same week', async () => {
  const stores = registry(target(), target('south'));
  const checkpoints: LocalDealsSnapshot[] = [];
  const first = await refreshRegisteredStores({
    registry: stores,
    snapshot: empty(),
    environment: {},
    now: () => now,
    collect: async (store) => {
      if (store.id === 'south') throw new Error('Upstream unavailable');
      return collection(store);
    },
    save: async (snapshot) => {
      checkpoints.push(snapshot);
    },
  });
  assert.deepEqual(first.saved, ['north']);
  assert.deepEqual(first.failed, ['south']);
  assert.equal(checkpoints.length, 1);
  const calls: string[] = [];
  const retry = await refreshRegisteredStores({
    registry: stores,
    snapshot: first.snapshot,
    environment: {},
    now: () => now,
    collect: async (store) => {
      calls.push(store.id);
      return collection(store);
    },
    save: async (snapshot) => {
      checkpoints.push(snapshot);
    },
  });
  assert.deepEqual(calls, ['south']);
  assert.equal(retry.snapshot.deals.length, 2);
  assert.equal(retry.snapshot.retailers.length, 2);
  assert.equal(retry.snapshot.deals[0].history.length, 1);
  await refreshRegisteredStores({
    registry: stores,
    snapshot: retry.snapshot,
    environment: {},
    now: () => now,
    collect: async () => {
      throw new Error('Should already be current');
    },
    save: async () => {
      throw new Error('Should not rewrite');
    },
  });
});

test('registered refresh stops on disk failure and rejects switched-store results before saving', async () => {
  const stores = registry(target(), target('south'));
  let calls = 0;
  await assert.rejects(
    refreshRegisteredStores({
      registry: stores,
      snapshot: empty(),
      environment: {},
      now: () => now,
      collect: async (store) => {
        calls++;
        return collection(store);
      },
      save: async () => {
        throw new Error('Disk full');
      },
    }),
    /Disk full/,
  );
  assert.equal(calls, 1);
  const rejected = await refreshRegisteredStores({
    registry: registry(target()),
    snapshot: empty(),
    environment: {},
    now: () => now,
    collect: async () => collection(target('wrong')),
    save: async () => {
      throw new Error('Must not publish');
    },
  });
  assert.deepEqual(rejected.failed, ['north']);
  assert.equal(rejected.snapshot.deals.length, 0);
});

test('source permission expiry is checked again before each store, not just when planning', async () => {
  const expiresAt = '2026-09-07T00:00:01Z';
  const store = { ...target(), access: { ...target().access, expiresAt } };
  let clocks = 0;
  const result = await refreshRegisteredStores({
    registry: registry(store),
    snapshot: empty(),
    environment: {},
    now: () => (clocks++ === 0 ? now : new Date(expiresAt)),
    collect: async () => {
      throw new Error('Must not request an expired source');
    },
    save: async () => {
      throw new Error('Must not save');
    },
  });
  assert.deepEqual(result.failed, ['north']);
});
