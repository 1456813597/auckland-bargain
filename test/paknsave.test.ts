/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaknsaveCollector, toPaknsaveOffer } from '../lib/collectors/paknsave';

const collectedAt = new Date('2026-08-31T10:00:00.000Z');

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

describe('toPaknsaveOffer', () => {
  it('maps integer cents and the largest product image', () => {
    const offer = toPaknsaveOffer(
      {
        productId: '5009651-EA-000',
        name: 'Creamy Milk Chocolate Block',
        brand: "Whittaker's",
        units: '250g',
        categories: ['Pantry', 'Chocolate'],
        price: 659,
        productImageUrls: {
          '100': 'https://example.com/100.png',
          '500': 'https://example.com/500.png',
        },
        decalCode: '6000',
      },
      collectedAt,
    );

    assert.ok(offer);
    assert.equal(offer.sourceProductId, '5009651-EA-000');
    assert.equal(offer.regularPriceCents, 659);
    assert.equal(offer.promoPriceCents, 659);
    assert.equal(offer.promotionText, "PAK'nSAVE Extra Low");
    assert.equal(offer.imageUrl, 'https://example.com/500.png');
    assert.match(offer.sourceUrl, /5009651_ea_000$/);
  });

  it('normalizes a multibuy total to its per-item promo price', () => {
    const offer = toPaknsaveOffer(
      {
        productId: '5039956-EA-000',
        name: 'Broccoli',
        units: 'ea',
        price: 179,
        nonLoyaltyPrice: 179,
        multiBuy: { quantity: 2, price: 300 },
      },
      collectedAt,
    );

    assert.ok(offer);
    assert.equal(offer.regularPriceCents, 179);
    assert.equal(offer.promoPriceCents, 150);
    assert.equal(offer.promotionText, '2 for $3.00');
  });

  it('keeps an explicit loyalty price separate', () => {
    const offer = toPaknsaveOffer(
      {
        productId: '1-EA-000',
        name: 'Club product',
        price: 400,
        nonLoyaltyPrice: 500,
      },
      collectedAt,
    );

    assert.ok(offer);
    assert.equal(offer.regularPriceCents, 500);
    assert.equal(offer.promoPriceCents, null);
    assert.equal(offer.memberPriceCents, 400);
    assert.equal(offer.promotionType, 'MEMBER_PRICE');
  });
});

describe('PaknsaveCollector', () => {
  it('authenticates, resolves Royal Oak, and paginates specials', async () => {
    const pages: number[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/user/get-current-user') {
        assert.equal(init?.method, 'POST');
        return Response.json({
          access_token: 'test-token',
          expires_time: '2099-01-01T00:00:00.000Z',
        });
      }
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer test-token',
      );
      if (url.pathname === '/v1/edge/store') {
        return Response.json({
          stores: [
            {
              id: 'royal-oak-id',
              name: "PAK'nSAVE Royal Oak",
              banner: 'PNS',
              address: '691 Manukau Road, Royal Oak, Auckland, 1023',
              onlineActive: true,
              physicalActive: true,
              physicalAddress: { cityName: 'Auckland' },
            },
            { id: 'other', name: 'Other', banner: 'NW' },
          ],
        });
      }

      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return Response.json({
        totalHits: 2,
        numberOfPages: 2,
        products: [
          {
            productId: String(page) + '-EA-000',
            name: 'Product ' + String(page),
            price: 200 + page,
          },
        ],
      });
    };

    const collector = new PaknsaveCollector({
      fetch: transport,
      webOrigin: 'https://shop.test',
      apiOrigin: 'https://api.test',
      storeQuery: 'Royal Oak',
      pageDelayMs: 0,
      sleep: async () => undefined,
      fingerprint: 'test-fingerprint',
    });
    const [store] = await collector.getStores();
    const result = await collector.collectSpecials(store);

    assert.equal(store.sourceStoreId, 'royal-oak-id');
    assert.equal(store.city, 'Auckland');
    assert.deepEqual(pages, [0, 1]);
    assert.equal(result.pagesCollected, 2);
    assert.equal(result.offers.length, 2);
  });

  it('fails before finalizing a partial snapshot', async () => {
    const transport: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/user/get-current-user') {
        return Response.json({ access_token: 'token' });
      }
      return Response.json({
        numberOfPages: 2,
        products: [{ productId: '1-EA-000', name: 'Product', price: 100 }],
      });
    };
    const collector = new PaknsaveCollector({
      fetch: transport,
      maxPages: 1,
      pageDelayMs: 0,
      sleep: async () => undefined,
    });

    await assert.rejects(
      collector.collectSpecials({
        sourceStoreId: 'store',
        name: "PAK'nSAVE Test",
        city: 'Auckland',
      }),
      /more than the configured 1 pages/,
    );
  });
});
