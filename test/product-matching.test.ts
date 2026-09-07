/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductComparisons } from '../lib/comparisons';
import type { Deal } from '../lib/deals';
import {
  AUTO_MATCH_THRESHOLD,
  canonicalProductSlug,
  parseProductMeasure,
  scoreProductMatch,
} from '../lib/product-matching';

test('normalizes equivalent metric pack sizes', () => {
  assert.deepEqual(parseProductMeasure('500g'), {
    dimension: 'mass',
    total: 500,
    packCount: 1,
  });
  assert.deepEqual(parseProductMeasure('0.5 kg'), {
    dimension: 'mass',
    total: 500,
    packCount: 1,
  });
  assert.deepEqual(parseProductMeasure('6 x 250ml'), {
    dimension: 'volume',
    total: 1_500,
    packCount: 6,
  });
  assert.equal(parseProductMeasure('130g-190g'), null);
});

test('builds readable canonical slugs without repeating brand or pack size', () => {
  assert.equal(
    canonicalProductSlug({
      id: '1',
      sourceName: 'Magnum Ice Cream Classic 4 Pack',
      brand: 'Magnum',
      size: '4 Pack',
    }),
    'magnum-ice-cream-classic-4-pack',
  );
});

test('automatically matches reordered supermarket product names', () => {
  const match = scoreProductMatch(
    {
      id: 'woolworths-1',
      sourceName: 'Anchor butter salted 500g',
      brand: 'Anchor',
      size: '500g',
      category: 'Dairy & eggs',
      retailerSlug: 'woolworths',
    },
    {
      id: 'paknsave-1',
      sourceName: 'Anchor Salted Butter',
      brand: 'Anchor',
      size: '0.5kg',
      category: 'Dairy and chilled',
      retailerSlug: 'paknsave',
    },
  );

  assert.equal(match.decision, 'auto');
  assert.ok(match.score >= 0.86);
  assert.ok(match.reasons.includes('Pack size agrees'));
});

test('rejects products with different pack sizes', () => {
  const match = scoreProductMatch(
    {
      id: '1',
      sourceName: 'Ecostore laundry liquid',
      brand: 'Ecostore',
      size: '1L',
    },
    {
      id: '2',
      sourceName: 'Ecostore laundry liquid',
      brand: 'Ecostore',
      size: '2L',
    },
  );
  assert.equal(match.decision, 'reject');
});

test('does not auto-match missing quantities, ranges or shrinkflation sizes', () => {
  const identity = {
    id: '1',
    sourceName: 'Breakfast Cereal',
    brand: 'Same brand',
    category: 'Cereal',
  };
  assert.notEqual(
    scoreProductMatch(identity, { ...identity, id: '2' }).decision,
    'auto',
  );
  assert.equal(parseProductMeasure('130g-190g', 'Cereal 130g'), null);
  assert.equal(
    scoreProductMatch(
      { ...identity, size: '500g' },
      { ...identity, id: '2', size: '495g' },
    ).decision,
    'reject',
  );
});

test('rejects protected product variants', () => {
  const match = scoreProductMatch(
    {
      id: '1',
      sourceName: 'Anchor salted butter',
      brand: 'Anchor',
      size: '500g',
    },
    {
      id: '2',
      sourceName: 'Anchor unsalted butter',
      brand: 'Anchor',
      size: '500g',
    },
  );
  assert.equal(match.decision, 'reject');
  assert.match(match.reasons.join(' '), /Variant conflict/);
});

test('dedicated pack counts take priority over wearer weight ranges', () => {
  assert.deepEqual(parseProductMeasure('36pk', 'Nappies size 4 10-15kg'), {
    dimension: 'count',
    total: 36,
    packCount: 36,
  });
  const match = scoreProductMatch(
    {
      id: '1',
      sourceName: 'Ultra Dry Nappies For Boys Size 4 10-15kg',
      brand: 'Huggies',
      size: '36pk',
    },
    {
      id: '2',
      sourceName: 'Ultra Dry Nappies For Boys Size 4 10-15kg',
      brand: 'Huggies',
      size: '72pk',
    },
  );
  assert.equal(match.decision, 'reject');
});

test('protects egg grades, formula stages, hair shades and SPF numbers', () => {
  for (const [leftName, rightName, size] of [
    ['Free Range Size 6 Eggs', 'Free Range Size 7 Eggs', '10pk'],
    ['Infant Formula Stage 1', 'Infant Formula Stage 2', '900g'],
    ['Hair Colour 8.1', 'Hair Colour 8.2', '1pk'],
    ['Sunscreen SPF50', 'Sunscreen SPF30', '200ml'],
  ]) {
    const match = scoreProductMatch(
      { id: '1', sourceName: leftName, brand: 'Same brand', size },
      { id: '2', sourceName: rightName, brand: 'Same brand', size },
    );
    assert.equal(match.decision, 'reject', `${leftName} vs ${rightName}`);
  }
  assert.notEqual(
    scoreProductMatch(
      {
        id: '1',
        sourceName: 'Free Range Size 7 Eggs',
        brand: 'Woodland',
        size: '10pk',
      },
      {
        id: '2',
        sourceName: 'Free Range Eggs',
        brand: 'Woodland',
        size: '10pk',
      },
    ).decision,
    'auto',
  );
});

test('uses an exact GTIN ahead of retailer wording', () => {
  const match = scoreProductMatch(
    { id: '1', sourceName: 'Different retailer title', gtin: '9400012345678' },
    { id: '2', sourceName: 'Canonical product title', gtin: '9400012345678' },
  );
  assert.equal(match.method, 'gtin');
  assert.equal(match.score, 1);
  assert.equal(match.decision, 'auto');
});

test('matches equivalent unbranded produce without treating a missing brand as a conflict', () => {
  const match = scoreProductMatch(
    {
      id: 'left',
      sourceName: 'Fresh NZ Broccoli Each',
      category: 'Fresh vegetables',
      size: '1 each',
    },
    {
      id: 'right',
      sourceName: 'Fresh NZ Broccoli Each',
      category: 'Fresh vegetables',
      size: '1 each',
    },
  );

  assert.equal(match.decision, 'auto');
  assert.ok(match.score >= AUTO_MATCH_THRESHOLD);
});

test('matches common singular and plural wording differences', () => {
  const match = scoreProductMatch(
    {
      id: 'left',
      sourceName: 'Cadbury Chocolate Favourites',
      brand: 'Cadbury',
      category: 'Chocolate',
      size: '470g',
    },
    {
      id: 'right',
      sourceName: 'Favourites Chocolates',
      brand: 'Cadbury',
      category: 'Chocolate',
      size: '470g',
    },
  );

  assert.equal(match.decision, 'auto');
  assert.ok(match.score >= AUTO_MATCH_THRESHOLD);
});

function deal(overrides: Partial<Deal>): Deal {
  return {
    id: 'retailer-product',
    name: 'Anchor Salted Butter',
    size: '500g',
    brand: 'Anchor',
    category: 'Dairy',
    retailer: 'Woolworths',
    store: 'Woolworths Glenfield',
    price: 6.49,
    regularPrice: 7.49,
    average90d: 6.99,
    low90d: 5.99,
    score: 80,
    promotion: 'Weekly special',
    memberOnly: false,
    color: '#059669',
    history: [
      { date: 'Last week', price: 6.99 },
      { date: 'This week', price: 6.49 },
    ],
    ...overrides,
  };
}

test('groups one standard product into retailer offers sorted by price', () => {
  const comparisons = buildProductComparisons([
    deal({ id: 'woolworths-1' }),
    deal({
      id: 'paknsave-2',
      retailer: "PAK'nSAVE",
      store: "PAK'nSAVE Royal Oak",
      name: 'Anchor butter salted',
      price: 5.99,
    }),
  ]);

  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].retailerCount, 2);
  assert.equal(comparisons[0].lowestPrice, 5.99);
  assert.equal(comparisons[0].offers[0].retailer, "PAK'nSAVE");
});

test('matches brandless retailer records without inventing a retailer brand', () => {
  const comparisons = buildProductComparisons([
    deal({
      id: 'freshchoice-1',
      retailer: 'FreshChoice',
      store: 'FreshChoice Epsom',
      name: 'Bluebird Potato Chips Thick Cut Ready Salted 150g',
      brand: '',
      size: '150g',
    }),
    deal({
      id: 'supervalue-1',
      retailer: 'SuperValue',
      store: 'SuperValue Milton',
      name: 'Bluebird Thick Cut Potato Chips Ready Salted 150g',
      brand: '',
      size: '150g',
    }),
  ]);

  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].retailerCount, 2);
  assert.equal(comparisons[0].brand, 'Brand not listed');
});
