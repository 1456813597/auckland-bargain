/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NewWorldCollector } from '../lib/collectors/newworld';

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

describe('NewWorldCollector', () => {
  it('selects the MNW banner and maps New World offers', async () => {
    const transport: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/user/get-current-user') {
        assert.equal(url.origin, 'https://www.newworld.test');
        return Response.json({ access_token: 'new-world-token' });
      }
      if (url.pathname === '/v1/edge/store') {
        assert.equal(url.origin, 'https://api.newworld.test');
        return Response.json({
          stores: [
            {
              id: 'queen-st-id',
              name: 'New World Metro Queen St',
              banner: 'MNW',
              onlineActive: true,
              physicalActive: true,
              region: 'NI',
              physicalAddress: { cityName: 'Auckland' },
            },
            {
              id: 'paknsave-id',
              name: "PAK'nSAVE Royal Oak",
              banner: 'PNS',
            },
          ],
        });
      }

      assert.equal(url.pathname, '/v1/edge/search/paginated/products');
      return Response.json({
        totalHits: 1,
        totalPages: 1,
        products: [
          {
            productId: '5009651-EA-000',
            name: 'Creamy Milk Chocolate Block',
            brand: "Whittaker's",
            units: '250g',
            singlePrice: { price: 659 },
          },
        ],
      });
    };
    const collector = new NewWorldCollector({
      fetch: transport,
      webOrigin: 'https://www.newworld.test',
      apiOrigin: 'https://api.newworld.test',
      pageDelayMs: 0,
      sleep: async () => undefined,
      fingerprint: 'test-fingerprint',
    });

    const [store] = await collector.getStores();
    const result = await collector.collectSpecials(store);

    assert.equal(collector.retailerSlug, 'newworld');
    assert.equal(store.sourceStoreId, 'queen-st-id');
    assert.equal(store.city, 'Auckland');
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].promotionText, 'New World special');
    assert.match(result.offers[0].sourceUrl, /5009651_ea_000nw$/);
  });
});
