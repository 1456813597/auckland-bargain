/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePriceObservations } from '../lib/comparison-history';
import { buildProductComparisons } from '../lib/comparisons';
import { comparisonForCity } from '../lib/comparison-query';
import { demoDeals, type Deal } from '../lib/deals';

test('does not invent a prior price for new coverage', () => {
  assert.equal(comparePriceObservations([]), null);
  assert.equal(
    comparePriceObservations([{ offerPrice: 4, previousPrice: null }]),
    null,
  );
});

test('a new cheaper store does not look like a reduction at existing stores', () => {
  assert.deepEqual(
    comparePriceObservations([
      { offerPrice: 4, previousPrice: null },
      { offerPrice: 7, previousPrice: 7 },
      { offerPrice: 8, previousPrice: 9 },
    ]),
    {
      previousLowestPrice: 7,
      currentLowestPrice: 7,
      change: 0,
      offerCount: 2,
    },
  );
});

test('compares observed minima of the same cohort with cent precision', () => {
  const history = comparePriceObservations([
    { offerPrice: 5.99, previousPrice: 6.99 },
    { offerPrice: 6.49, previousPrice: 6.49 },
  ]);
  assert.equal(history?.change, -0.5);
  assert.equal(history?.offerCount, 2);
});

test('product aggregation and locality filtering use the same observation cohort', () => {
  const offer = (
    id: string,
    city: string,
    price: number,
    previousPrice: number | null,
  ): Deal => ({
    ...demoDeals[0],
    id,
    canonicalId: 'test-observation-cohort',
    price,
    promotion: '',
    storeCity: city,
    history: [
      ...(previousPrice === null
        ? []
        : [
            {
              date: 'Prior',
              price: previousPrice,
              observedAt: '2026-07-01T00:00:00Z',
            },
          ]),
      { date: 'Latest', price, observedAt: '2026-09-06T00:00:00Z' },
    ],
  });
  const [product] = buildProductComparisons([
    offer('freshchoice-existing', 'Auckland', 7, 7),
    offer('newworld-new', 'Auckland', 4, null),
    offer('supervalue-existing', 'Milton', 5, 6),
  ]);
  assert.equal(product.lowestPrice, 4);
  assert.equal(product.weeklyChange, -1);
  const local = comparisonForCity(product, 'Auckland');
  assert.equal(local?.lowestPrice, 4);
  assert.equal(local?.weeklyChange, 0);
  assert.equal(comparePriceObservations(local!.offers)?.offerCount, 1);
});
