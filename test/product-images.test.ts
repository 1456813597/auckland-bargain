/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paknsaveProductImageUrl } from '../lib/product-images';

describe('paknsaveProductImageUrl', () => {
  it('maps a retailer product id to the official image CDN', () => {
    assert.equal(
      paknsaveProductImageUrl('5295513-EA-000'),
      'https://a.fsimg.co.nz/prod/product/retail/fan/image/500x500/5295513.png',
    );
  });

  it('does not invent a URL for a non-numeric product id', () => {
    assert.equal(paknsaveProductImageUrl('unknown-EA-000'), null);
  });
});
