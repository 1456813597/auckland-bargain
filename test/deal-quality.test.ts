/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  historicalDiscountEvidence,
  isStrongDeal,
  promotionLabelForDiscount,
} from '../lib/deal-quality';
import type { Deal } from '../lib/deals';

function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'retailer-product',
    name: 'Test product',
    size: '1 ea',
    brand: 'Test',
    category: 'Pantry',
    retailer: 'Woolworths',
    store: 'Test store',
    price: 5,
    regularPrice: 10,
    average90d: 10,
    low90d: 5,
    score: 0,
    promotion: 'Special',
    memberOnly: false,
    color: '#000000',
    history: [{ date: 'Today', price: 5 }],
    ...overrides,
  };
}

describe('strong-deal qualification', () => {
  it('keeps Woolworths half-price offers and rejects small specials', () => {
    assert.equal(isStrongDeal(deal()), true);
    assert.equal(
      isStrongDeal(deal({ price: 8, regularPrice: 10, low90d: 8 })),
      false,
    );
  });

  it("does not treat PAK'nSAVE Extra Low as discount evidence by itself", () => {
    assert.equal(
      isStrongDeal(
        deal({
          retailer: "PAK'nSAVE",
          price: 8,
          regularPrice: 8,
          average90d: 8,
          low90d: 8,
          promotion: "PAK'nSAVE Extra Low",
        }),
      ),
      false,
    );
  });

  it("keeps a PAK'nSAVE product at a proven historical low", () => {
    const candidate = deal({
      retailer: "PAK'nSAVE",
      price: 6,
      regularPrice: 6,
      average90d: 8.4,
      low90d: 6,
      history: [
        { date: 'Jun', price: 8 },
        { date: 'Jul', price: 9 },
        { date: 'Aug', price: 8 },
        { date: 'Today', price: 6 },
      ],
    });

    assert.deepEqual(historicalDiscountEvidence(candidate), {
      baseline: 8,
      discountPercent: 25,
    });
    assert.equal(isStrongDeal(candidate), true);
  });

  it('uses shopper-facing half-price labels with a rounding tolerance', () => {
    assert.equal(promotionLabelForDiscount(48), 'Half price');
    assert.equal(promotionLabelForDiscount(52), 'Half price');
    assert.equal(promotionLabelForDiscount(53), 'Better than half price');
    assert.equal(promotionLabelForDiscount(47), null);
  });
});
