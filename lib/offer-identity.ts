import { createHash } from 'node:crypto';
import type { Deal } from './deals';

export function retailerSlugForDeal(
  deal: Pick<Deal, 'retailer' | 'retailerSlug'>,
) {
  if (deal.retailerSlug?.trim()) return deal.retailerSlug;
  const slug = deal.retailer
    .toLocaleLowerCase('en-NZ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Keep the established source slugs when migrating old display-name rows.
  if (slug === 'new-world') return 'newworld';
  if (slug === 'four-square') return 'foursquare';
  return slug;
}

export function scopedOfferId(
  retailer: string,
  product: string,
  store: string,
) {
  return `${retailer}-${createHash('sha256')
    .update(JSON.stringify([retailer, product, store]))
    .digest('hex')
    .slice(0, 24)}`;
}

export function retailerProductKey(deal: Deal): string | undefined {
  const slug = retailerSlugForDeal(deal);
  if (deal.sourceProductId) return `${slug}-${deal.sourceProductId}`;
  // Before store-scoped IDs, bundled offers used retailer + source SKU.
  return deal.id.startsWith(`${slug}-`) ? deal.id : undefined;
}

export function offerStoreKey(deal: Deal) {
  return JSON.stringify([
    retailerSlugForDeal(deal),
    deal.storeKey ??
      deal.sourceStoreId ??
      JSON.stringify([deal.storeCity ?? '', deal.store]),
  ]);
}
