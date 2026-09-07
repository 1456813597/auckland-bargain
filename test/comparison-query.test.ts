/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildProductComparisons } from '../lib/comparisons';
import {
  comparisonSearchParams,
  parseComparisonFilters,
  queryComparisons,
} from '../lib/comparison-query';
import { demoDeals, type Deal } from '../lib/deals';

function fixture() {
  return buildProductComparisons([
    {
      ...demoDeals[0],
      id: 'freshchoice-a',
      name: 'Anchor Salted Butter',
      brand: 'Anchor',
      size: '500g',
      category: 'Dairy',
      retailer: 'FreshChoice',
      storeCity: 'Auckland',
      price: 6,
      promotion: '',
      memberOnly: false,
    },
    {
      ...demoDeals[0],
      id: 'supervalue-a',
      name: 'Anchor Salted Butter',
      brand: 'Anchor',
      size: '500g',
      category: 'Dairy',
      retailer: 'SuperValue',
      storeCity: 'Milton',
      price: 4,
      promotion: '',
      memberOnly: false,
    },
  ]);
}

test('round-trips shareable filters and rejects malformed pagination', () => {
  const filters = parseComparisonFilters(
    new URLSearchParams(
      'q=butter+anchor&city=Auckland&matched=true&sort=price&page=2',
    ),
  );
  assert.deepEqual(
    parseComparisonFilters(comparisonSearchParams(filters)),
    filters,
  );
  const invalid = parseComparisonFilters(
    new URLSearchParams('page=Infinity&limit=-1&sort=unknown'),
  );
  assert.equal(invalid.page, 1);
  assert.equal(invalid.limit, 24);
  assert.equal(invalid.sort, 'coverage');
  assert.equal(
    parseComparisonFilters(new URLSearchParams('limit=999999')).limit,
    250,
  );
});

test('search supports reordered words and location scopes the actual lowest price', () => {
  const result = queryComparisons(
    fixture(),
    parseComparisonFilters(
      new URLSearchParams('q=butter+anchor&city=Auckland'),
    ),
  );
  assert.equal(result.total, 1);
  assert.equal(result.products[0].lowestPrice, 6);
  assert.equal(result.products[0].retailerCount, 1);
  assert.equal(result.products[0].possibleSaving, 0);
  assert.deepEqual(result.cities, ['Auckland', 'Milton']);
  assert.equal(
    queryComparisons(
      fixture(),
      parseComparisonFilters(new URLSearchParams('city=Auckland&matched=true')),
    ).total,
    0,
  );
});

test('pagination returns only the requested window with deterministic ordering', () => {
  const products = fixture();
  const catalogue = Array.from({ length: 60 }, (_, index) => ({
    ...products[0],
    id: `product-${String(index).padStart(2, '0')}`,
  }));
  const first = queryComparisons(
    catalogue,
    parseComparisonFilters(new URLSearchParams()),
  );
  const second = queryComparisons(
    catalogue,
    parseComparisonFilters(new URLSearchParams('page=2')),
  );
  assert.equal(first.products.length, 24);
  assert.equal(second.products.length, 24);
  assert.equal(first.totalPages, 3);
  assert.equal(
    new Set(
      [...first.products, ...second.products].map((product) => product.id),
    ).size,
    48,
  );
  assert.equal(
    queryComparisons(
      catalogue,
      parseComparisonFilters(new URLSearchParams('page=999')),
    ).filters.page,
    3,
  );
  assert.equal(
    queryComparisons(
      catalogue,
      parseComparisonFilters(new URLSearchParams('q=not-a-product')),
    ).total,
    0,
  );
});

test('full bundled catalogue keeps the homepage props below 200 KB', async () => {
  const snapshot = JSON.parse(await readFile('data/deals.json', 'utf8')) as {
    deals: Deal[];
  };
  const products = buildProductComparisons(snapshot.deals);
  const result = queryComparisons(
    products,
    parseComparisonFilters(new URLSearchParams()),
  );
  assert.ok(result.products.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 200_000);
  assert.equal(result.totalProducts, products.length);
});
