import type { Deal } from '@/lib/deals';

export const WOOLWORTHS_MIN_ADVERTISED_DISCOUNT = 40;
export const PAKNSAVE_MIN_ADVERTISED_DISCOUNT = 30;
export const PAKNSAVE_MIN_HISTORICAL_DISCOUNT = 25;
export const MIN_PRIOR_PRICE_OBSERVATIONS = 3;
export const MIN_RESULTS_PER_RETAILER = 10;

function percentBelow(referencePrice: number, currentPrice: number) {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 0;
  return Math.max(
    0,
    Math.round(((referencePrice - currentPrice) / referencePrice) * 100),
  );
}

export function advertisedDiscountPercent(deal: Deal) {
  return percentBelow(deal.regularPrice, deal.price);
}

function median(values: number[]) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function historicalDiscountEvidence(deal: Deal) {
  const prices = deal.history
    .map((point) => point.price)
    .filter((price) => Number.isFinite(price) && price > 0);

  if (prices.at(-1) === deal.price) prices.pop();
  if (prices.length < MIN_PRIOR_PRICE_OBSERVATIONS) return null;

  const baseline = median(prices);
  return {
    baseline,
    discountPercent: percentBelow(baseline, deal.price),
  };
}

export function dealEvidencePercent(deal: Deal) {
  return Math.max(
    advertisedDiscountPercent(deal),
    historicalDiscountEvidence(deal)?.discountPercent ?? 0,
  );
}

export function isStrongDeal(deal: Deal) {
  const retailer = deal.retailer.toLocaleLowerCase('en-NZ');
  const advertised = advertisedDiscountPercent(deal);

  if (retailer.includes('woolworths')) {
    return advertised >= WOOLWORTHS_MIN_ADVERTISED_DISCOUNT;
  }

  if (retailer.includes('pak')) {
    const historical = historicalDiscountEvidence(deal);
    const isNewObservedLow = deal.price <= deal.low90d;
    return (
      advertised >= PAKNSAVE_MIN_ADVERTISED_DISCOUNT ||
      Boolean(
        historical &&
        historical.discountPercent >= PAKNSAVE_MIN_HISTORICAL_DISCOUNT &&
        isNewObservedLow,
      )
    );
  }

  return dealEvidencePercent(deal) >= PAKNSAVE_MIN_HISTORICAL_DISCOUNT;
}

export function selectStrongDeals(
  deals: Deal[],
  limit = 100,
  minimumPerRetailer = MIN_RESULTS_PER_RETAILER,
) {
  if (limit <= 0) return [];

  const ranked = deals
    .filter(isStrongDeal)
    .sort(
      (left, right) =>
        dealEvidencePercent(right) - dealEvidencePercent(left) ||
        right.score - left.score ||
        left.name.localeCompare(right.name),
    );
  const retailerKeys = [
    ...new Set(ranked.map((deal) => deal.retailer.toLocaleLowerCase('en-NZ'))),
  ];
  const reservedPerRetailer = Math.min(
    minimumPerRetailer,
    Math.floor(limit / Math.max(retailerKeys.length, 1)),
  );
  const selected = new Set<Deal>();

  for (const retailer of retailerKeys) {
    for (const deal of ranked) {
      if (deal.retailer.toLocaleLowerCase('en-NZ') !== retailer) continue;
      selected.add(deal);
      if (
        [...selected].filter(
          (candidate) =>
            candidate.retailer.toLocaleLowerCase('en-NZ') === retailer,
        ).length >= reservedPerRetailer
      ) {
        break;
      }
    }
  }

  for (const deal of ranked) {
    if (selected.size >= limit) break;
    selected.add(deal);
  }

  return ranked.filter((deal) => selected.has(deal)).slice(0, limit);
}

export function promotionLabelForDiscount(discountPercent: number) {
  if (discountPercent > 52) return 'Better than half price';
  if (discountPercent >= 48) return 'Half price';
  return null;
}
