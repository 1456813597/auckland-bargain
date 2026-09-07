/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaknsaveCollector } from '../lib/collectors/paknsave';
import { NewWorldCollector } from '../lib/collectors/newworld';
import {
  FreshChoiceCollector,
  SuperValueCollector,
} from '../lib/collectors/myfoodlink';

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? new URL(input.url) : new URL(input);
}

test('Foodstuffs discovery separates banners, excludes closed/offline stores and preserves each store region', async () => {
  for (const [Collector, banner] of [
    [PaknsaveCollector, 'PNS'],
    [NewWorldCollector, 'MNW'],
  ] as const) {
    const transport: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/user/get-current-user')
        return Response.json({ access_token: 'test' });
      if (url.pathname === '/v1/edge/store')
        return Response.json({
          stores: [
            {
              id: 'north',
              name: 'North',
              banner,
              region: 'NI',
              physicalAddress: { cityName: 'Auckland' },
            },
            {
              id: 'south',
              name: 'South',
              banner,
              region: 'SI',
              physicalAddress: { cityName: 'Dunedin' },
            },
            { id: 'unknown-city', name: 'Unknown city', banner, region: 'SI' },
            { id: 'closed', name: 'Closed', banner, physicalActive: false },
            { id: 'offline', name: 'Offline', banner, onlineActive: false },
            { id: 'other', name: 'Other banner', banner: 'OTHER' },
          ],
        });
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init?.body as string) as {
        sortOrder: string;
        storeId: string;
        algoliaQuery: { facets: string[] };
      };
      assert.equal(body.storeId, 'south');
      assert.equal(body.sortOrder, 'SI_POPULARITY_ASC');
      assert.deepEqual(body.algoliaQuery.facets, ['category0SI']);
      return Response.json({
        totalHits: 1,
        totalPages: 1,
        products: [{ productId: '1-EA-000', name: 'Milk 2L', price: 500 }],
      });
    };
    const collector = new Collector({
      fetch: transport,
      city: 'Must not overwrite directory cities',
    });
    const stores = await collector.getAllStores();
    assert.deepEqual(
      stores.map(({ sourceStoreId, city }) => ({ sourceStoreId, city })),
      [
        { sourceStoreId: 'north', city: 'Auckland' },
        { sourceStoreId: 'south', city: 'Dunedin' },
        { sourceStoreId: 'unknown-city', city: 'New Zealand' },
      ],
    );
    assert.equal((await collector.collectSpecials(stores[1])).offers.length, 1);
  }
});

test('Foodstuffs store discovery refuses duplicate identities or unknown island context', async () => {
  for (const stores of [
    [
      { id: 'a', name: 'A', banner: 'PNS', region: 'NI' },
      { id: 'a', name: 'B', banner: 'PNS', region: 'NI' },
    ],
    [{ id: 'a', name: 'A', banner: 'PNS', region: 'UNKNOWN' }],
    [],
  ]) {
    const collector = new PaknsaveCollector({
      fetch: async (input) =>
        requestUrl(input).pathname === '/api/user/get-current-user'
          ? Response.json({ access_token: 'test' })
          : Response.json({ stores }),
    });
    await assert.rejects(
      collector.getAllStores(),
      /duplicate|unknown|no active/,
    );
  }
});

test('custom MyFoodLink storefronts do not inherit the sample store city or street address', async () => {
  for (const Collector of [FreshChoiceCollector, SuperValueCollector]) {
    const collector = new Collector({
      storeOrigin: 'https://custom.test',
      fetch: async () =>
        new Response(
          '<script>window.cmsDataLayer = [{"mfl_shop_update":{"shop":{"id":"custom-id","name":"Custom store"}}}];</script>',
        ),
    });
    const [store] = await collector.getStores();
    assert.equal(store.city, 'New Zealand');
    assert.ok(!store.address);
  }
});
