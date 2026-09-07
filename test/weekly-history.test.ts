/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { offersToLocalDeals } from '../lib/local-deals';
import type { RawOffer } from '../lib/collectors/types';
import type { Deal } from '../lib/deals';
import { nzWeekStart } from '../lib/weekly-history';

function observation(
  date: string,
  price: number,
  previous: Deal[] = [],
  store = 'north',
  promotionText: string | null = null,
) {
  const offer: RawOffer = {
    sourceProductId: 'product',
    sourceName: 'Test product',
    brand: null,
    size: null,
    category: null,
    gtin: null,
    imageUrl: null,
    sourceUrl: 'https://example.com/product',
    regularPriceCents: price,
    promoPriceCents: price,
    memberPriceCents: null,
    promotionType: 'SPECIAL',
    promotionText,
    validUntil: null,
    collectedAt: new Date(date),
  };
  return offersToLocalDeals(
    {
      retailerSlug: 'test',
      retailerName: 'Test',
      store: { sourceStoreId: store, name: store, city: 'Auckland' },
      offers: [offer],
    },
    previous,
  );
}

test('local history retains distinct NZ weeks through same-week reruns and year boundaries', () => {
  let deals = observation('2026-12-21T00:00:00Z', 500);
  deals = observation('2026-12-28T00:00:00Z', 400, deals);
  deals = observation('2027-01-01T00:00:00Z', 350, deals);
  assert.deepEqual(
    deals[0].history.map((point) => [point.weekStart, point.price]),
    [
      ['2026-12-21', 5],
      ['2026-12-28', 3.5],
    ],
  );
  deals = observation('2027-01-04T00:00:00Z', 350, deals);
  assert.deepEqual(
    deals[0].history.map((point) => [point.weekStart, point.price]),
    [
      ['2026-12-28', 3.5],
      ['2027-01-04', 3.5],
    ],
  );
});

test('uses NZ midnight and daylight saving for the weekly boundary', () => {
  assert.equal(nzWeekStart('2026-09-06T11:59:59Z'), '2026-08-31');
  assert.equal(nzWeekStart('2026-09-06T12:00:00Z'), '2026-09-07');
  assert.equal(nzWeekStart('2026-09-27T10:59:59Z'), '2026-09-21');
  assert.equal(nzWeekStart('2026-09-27T11:00:00Z'), '2026-09-28');
});

test('does not borrow history when the selected store changes', () => {
  const previous = observation('2026-08-31T00:00:00Z', 500);
  const current = observation('2026-09-07T00:00:00Z', 300, previous, 'south');
  assert.equal(current[0].history.length, 1);
  assert.equal(current[0].sourceStoreId, 'south');
});

test('compares multibuy observations on the same unit-price basis', () => {
  const first = observation(
    '2026-08-31T00:00:00Z',
    129,
    [],
    'north',
    '4 for $3.00',
  );
  const second = observation(
    '2026-09-07T00:00:00Z',
    129,
    first,
    'north',
    '4 for $3.00',
  );
  assert.deepEqual(
    second[0].history.map((point) => point.price),
    [0.75, 0.75],
  );
});

test('upgrades only trustworthy legacy observation dates without inventing prior weeks', () => {
  const previous = observation('2026-09-03T00:00:00Z', 500);
  previous[0].history = [
    { date: '01 Sept', price: 7 },
    { date: '03 Sept', price: 5 },
  ];
  const current = observation('2026-09-05T00:00:00Z', 400, previous);
  assert.equal(current[0].history.length, 1);
  assert.equal(current[0].history[0].price, 4);
});
