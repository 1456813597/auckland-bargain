/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RawOffer } from '../lib/collectors/types';
import {
  offersToLocalDeals,
  parseLocalDealsSnapshot,
} from '../lib/local-deals';

const collectedAt = new Date('2026-09-03T10:00:00.000Z');

function offer(overrides: Partial<RawOffer> = {}): RawOffer {
  return {
    sourceProductId: 'product-1',
    sourceName: 'Test product',
    brand: null,
    category: null,
    size: null,
    gtin: null,
    imageUrl: null,
    sourceUrl: 'https://example.com/product-1',
    regularPriceCents: 500,
    promoPriceCents: 400,
    memberPriceCents: null,
    promotionType: 'SPECIAL',
    promotionText: 'Save $1.00',
    validUntil: null,
    collectedAt,
    ...overrides,
  };
}

describe('local deals snapshot', () => {
  it('maps collected integer prices into API deals', () => {
    const [deal] = offersToLocalDeals({
      retailerSlug: 'woolworths',
      retailerName: 'Woolworths',
      store: {
        sourceStoreId: '9171',
        name: 'Woolworths Glenfield',
        city: 'Auckland',
      },
      offers: [offer()],
    });

    assert.ok(deal);
    assert.equal(deal.id, 'woolworths-product-1');
    assert.equal(deal.price, 4);
    assert.equal(deal.regularPrice, 5);
    assert.equal(deal.average90d, 5);
    assert.equal(deal.memberOnly, false);
    assert.deepEqual(deal.history, [{ date: '03 Sept', price: 4 }]);
  });

  it('prefers a member price and updates the same-day history point', () => {
    const input = {
      retailerSlug: 'paknsave',
      retailerName: "PAK'nSAVE",
      store: {
        sourceStoreId: 'royal-oak',
        name: "PAK'nSAVE Royal Oak",
        city: 'Auckland',
      },
      offers: [
        offer({
          memberPriceCents: 350,
          promotionType: 'MEMBER_PRICE',
        }),
      ],
    };
    const [first] = offersToLocalDeals(input);
    assert.ok(first);
    const [updated] = offersToLocalDeals(
      {
        ...input,
        offers: [
          offer({ memberPriceCents: 325, promotionType: 'MEMBER_PRICE' }),
        ],
      },
      [first],
    );

    assert.ok(updated);
    assert.equal(updated.price, 3.25);
    assert.equal(updated.memberOnly, true);
    assert.deepEqual(updated.history, [{ date: '03 Sept', price: 3.25 }]);
  });

  it('rejects incompatible snapshot versions', () => {
    assert.throws(
      () =>
        parseLocalDealsSnapshot({
          schemaVersion: 2,
          generatedAt: null,
          retailers: [],
          deals: [],
        }),
      /Unsupported local deals schema version/,
    );
  });
});
