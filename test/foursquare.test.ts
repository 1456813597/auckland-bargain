/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FourSquareCollector,
  parseFourSquarePage,
} from '../lib/collectors/foursquare';

function flightHtml() {
  const data = [
    '$',
    '$L2b',
    null,
    {
      allStoresProps: [
        {
          title: 'Four Square Lancaster',
          url: '/auckland/lancaster',
          storeId: '{LANCASTER}',
          contactDetails: {
            address: '209 Beach Haven Road, Beach Haven, Auckland 0626',
            region: 'Upper North Island',
          },
        },
        {
          title: 'Four Square Britomart',
          url: '/auckland/britomart',
          storeId: '{BRITOMART}',
          contactDetails: {
            address: '17 Galway Street, Auckland CBD, Auckland 1010',
            region: 'Upper North Island',
          },
        },
      ],
      store: {
        store_id: '{LANCASTER}',
        title: 'Four Square Lancaster',
        url: '/auckland/lancaster',
        contact_details: {
          address: '209 Beach Haven Road, Beach Haven, Auckland 0626',
          region: 'Upper North Island',
        },
      },
      mappedProducts: [
        {
          id: 'potatoes-id',
          department: 'Fruit & Vegetables',
          endDate: '06 Sep 2026',
          heading: 'Vivaldi Gold Washed Potatoes 2kg',
          image: { src: 'https://images.test/potatoes.png' },
          pricing: { per: 'ea', price: 6.99, multibuy: null },
          specialType: 'Special',
        },
        {
          id: 'cat-food-id',
          department: 'Pet Food',
          endDate: '06 Sep 2026',
          heading: 'Dine Cat Food Pouches 85g',
          image: { src: 'https://images.test/cat-food.png' },
          pricing: { per: 'ea', price: 3, multibuy: 2 },
          specialType: 'Special',
        },
      ],
      paginationProps: {
        numPages: 1,
        showingInfo: { totalItems: 2 },
      },
    },
  ];
  const payload = `28:${JSON.stringify(data)}\n`;
  return `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
}

describe('FourSquareCollector', () => {
  it('decodes Next Flight data and normalizes multi-buy unit prices', () => {
    const parsed = parseFourSquarePage(flightHtml(), {
      origin: 'https://foursquare.test',
      collectedAt: new Date('2026-09-05T00:00:00Z'),
    });

    assert.equal(parsed.stores.length, 2);
    assert.equal(parsed.selectedStore?.store_id, '{LANCASTER}');
    assert.equal(parsed.offers.length, 2);
    assert.equal(parsed.offers[0]?.promoPriceCents, 699);
    assert.equal(parsed.offers[0]?.size, '2kg');
    assert.equal(parsed.offers[1]?.promoPriceCents, 150);
    assert.equal(parsed.offers[1]?.size, '85g');
    assert.equal(parsed.offers[1]?.promotionText, '2 for $3.00');
  });

  it('enumerates the directory and collects a complete selected store', async () => {
    let requests = 0;
    const collector = new FourSquareCollector({
      origin: 'https://foursquare.test',
      storeQuery: 'Lancaster',
      fetch: async () => {
        requests += 1;
        return new Response(flightHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      pageDelayMs: 0,
      sleep: async () => undefined,
    });

    const stores = await collector.getAllStores();
    const [selected] = await collector.getStores();
    const result = await collector.collectSpecials(selected);

    assert.equal(requests, 1);
    assert.equal(stores.length, 2);
    assert.equal(selected?.sourceStoreId, '{LANCASTER}');
    assert.equal(result.offers.length, 2);
    assert.equal(result.totalItemsReported, 2);
  });
});
