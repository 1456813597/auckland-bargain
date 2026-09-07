/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawOffer } from '../lib/collectors/types';
import {
  buildProductComparisons,
  retailerSlugForDeal,
} from '../lib/comparisons';
import { comparisonForCity } from '../lib/comparison-query';
import {
  offersToLocalDeals,
  mergeLocalStoreSnapshots,
  type LocalDealsSnapshot,
  type LocalRetailerSnapshot,
} from '../lib/local-deals';
import { scopedOfferId, retailerProductKey } from '../lib/offer-identity';
import type { Deal } from '../lib/deals';

function collect(
  storeId: string,
  price: number,
  previous: Deal[] = [],
  sku = 'sku',
  at = '2026-09-07T00:00:00Z',
) {
  const raw: RawOffer = {
    sourceProductId: sku,
    sourceName: 'Anchor Salted Butter',
    brand: 'Anchor',
    size: '500g',
    category: 'Dairy',
    gtin: null,
    imageUrl: null,
    sourceUrl: 'https://example.test/products/' + sku,
    regularPriceCents: price,
    promoPriceCents: null,
    memberPriceCents: null,
    promotionType: null,
    promotionText: null,
    validUntil: null,
    collectedAt: new Date(at),
  };
  const store = {
    sourceStoreId: storeId,
    name: `Test ${storeId}`,
    city: storeId === 'north' ? 'Auckland' : 'Wellington',
  };
  const deals = offersToLocalDeals(
    { retailerSlug: 'test', retailerName: 'Test', store, offers: [raw] },
    previous,
  );
  const metadata: LocalRetailerSnapshot = {
    slug: 'test',
    name: 'Test',
    store,
    collectedAt: at,
    dealCount: deals.length,
  };
  return { metadata, deals };
}

test('quote IDs include store identity while retailer product keys stay stable', () => {
  const a = collect('north', 500).deals[0];
  const b = collect('south', 300).deals[0];
  assert.notEqual(a.id, b.id);
  assert.equal(retailerProductKey(a), retailerProductKey(b));
  assert.equal(a.id, collect('north', 450).deals[0].id);
  assert.notEqual(
    scopedOfferId('test', 'a-b', 'c'),
    scopedOfferId('test', 'a', 'b-c'),
  );
  assert.notEqual(
    scopedOfferId('test', 'sku', 'north'),
    scopedOfferId('another', 'sku', 'north'),
  );
});

test('same supermarket SKU groups across stores with separate prices and local filters', () => {
  const a = collect('north', 500).deals[0];
  const b = {
    ...collect('south', 300).deals[0],
    size: 'See product details',
    brand: '',
  };
  const products = buildProductComparisons([a, b]);
  assert.equal(products.length, 1);
  assert.equal(products[0].offers.length, 2);
  assert.equal(products[0].retailerCount, 1);
  assert.equal(products[0].lowestPrice, 3);
  assert.equal(comparisonForCity(products[0], 'Auckland')?.lowestPrice, 5);
});

test('weekly histories survive ID migration and remain isolated between stores', () => {
  const north = collect('north', 500, [], 'sku', '2026-08-31T00:00:00Z')
    .deals[0];
  const legacy = {
    ...north,
    id: 'test-sku',
    sourceProductId: undefined,
    retailerSlug: undefined,
    storeKey: undefined,
  };
  const south = collect('south', 300, [], 'sku', '2026-08-31T00:00:00Z')
    .deals[0];
  const prior = [legacy, south];
  const updatedNorth = collect('north', 450, prior).deals[0];
  const updatedSouth = collect('south', 250, prior).deals[0];
  assert.deepEqual(
    updatedNorth.history.map((p) => p.price),
    [5, 4.5],
  );
  assert.deepEqual(
    updatedSouth.history.map((p) => p.price),
    [3, 2.5],
  );
});

test('different SKUs in one store stay separate but equivalent cross-store items can match', () => {
  const a = collect('north', 500, [], 'a').deals[0];
  const b = collect('north', 400, [], 'b').deals[0];
  const c = collect('south', 350, [], 'c').deals[0];
  assert.equal(buildProductComparisons([a, b]).length, 2);
  assert.equal(buildProductComparisons([a, c]).length, 1);
});

test('duplicate observations of one store SKU keep only the latest quote', () => {
  const old = collect('north', 500, [], 'sku', '2026-08-31T00:00:00Z').deals[0];
  const current = collect('north', 450).deals[0];
  const [product] = buildProductComparisons([current, old, current]);
  assert.equal(product.offers.length, 1);
  assert.equal(product.lowestPrice, 4.5);
});

test('database store identities remain distinct even when display names coincide', () => {
  const first = {
    ...collect('north', 500).deals[0],
    sourceStoreId: undefined,
    store: 'Same label',
    storeKey: 'database:1',
  };
  const second = {
    ...first,
    id: 'test-different-quote',
    price: 4,
    storeKey: 'database:2',
  };
  assert.equal(buildProductComparisons([first, second])[0].offers.length, 2);
});

test('refreshing one store does not remove another store of the same retailer', () => {
  const north = collect('north', 500);
  const removed = collect('north', 700, [], 'removed');
  const south = collect('south', 300);
  const existing: LocalDealsSnapshot = {
    schemaVersion: 1,
    generatedAt: null,
    retailers: [north.metadata, south.metadata],
    deals: [...north.deals, ...removed.deals, ...south.deals],
  };
  const next = collect('north', 450, existing.deals);
  const merged = mergeLocalStoreSnapshots(
    existing,
    [next],
    '2026-09-07T00:00:00Z',
  );
  assert.equal(merged.deals.length, 2);
  assert.equal(merged.retailers.length, 2);
  assert.deepEqual(
    merged.deals.find((d) => d.sourceStoreId === 'south'),
    south.deals[0],
  );
  assert.ok(!merged.deals.some((d) => d.sourceProductId === 'removed'));
  assert.throws(
    () =>
      mergeLocalStoreSnapshots(existing, [next, next], '2026-09-07T00:00:00Z'),
    /same store twice/,
  );
});

test('retailer identity comes from the retailer, never a product-title ID prefix', () => {
  assert.equal(retailerSlugForDeal({ retailer: 'PAK’nSAVE' }), 'paknsave');
  assert.equal(retailerSlugForDeal({ retailer: 'New World' }), 'newworld');
  assert.equal(retailerSlugForDeal({ retailer: 'Four Square' }), 'foursquare');
  assert.equal(
    retailerSlugForDeal({
      retailer: 'Renamed display',
      retailerSlug: 'newworld',
    }),
    'newworld',
  );
});
