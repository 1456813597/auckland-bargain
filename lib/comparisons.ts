import { dealOfferPrice, type Deal } from '@/lib/deals';
import { comparePriceObservations } from '@/lib/comparison-history';
import {
  offerStoreKey,
  retailerProductKey,
  retailerSlugForDeal,
} from '@/lib/offer-identity';
export { retailerSlugForDeal } from '@/lib/offer-identity';
import {
  canonicalProductSlug,
  normalizeProductText,
  normalizedBrand,
  productBlockingTokens,
  productMeasureKey,
  scoreProductMatch,
  type ProductIdentity,
} from '@/lib/product-matching';

export type ComparisonOffer = Deal & {
  offerPrice: number;
  previousPrice: number | null;
  weeklyChange: number | null;
  retailerSlug: string;
};

export type ProductComparison = {
  id: string;
  name: string;
  brand: string;
  size: string;
  category: string;
  imageUrl?: string;
  offers: ComparisonOffer[];
  lowestPrice: number;
  highestPrice: number;
  retailerCount: number;
  possibleSaving: number;
  weeklyChange: number | null;
  matchConfidence: number;
  matchMethod: 'gtin' | 'attributes' | 'seed' | 'manual';
  updatedAt: string | null;
};

type WorkingGroup = {
  id: string;
  identity: ProductIdentity;
  identities: ProductIdentity[];
  deals: Deal[];
  storeKeys: Set<string>;
  confidence: number;
  matchMethod: ProductComparison['matchMethod'];
};

function measureKey(identity: ProductIdentity) {
  return productMeasureKey(identity) ?? 'unmeasured';
}

function matchingBucket(identity: ProductIdentity) {
  return `${normalizedBrand(identity.brand) || 'unbranded'}|${measureKey(identity)}`;
}

function addToIndex(
  index: Map<string, WorkingGroup[]>,
  key: string,
  group: WorkingGroup,
) {
  const groups = index.get(key);
  if (groups) groups.push(group);
  else index.set(key, [group]);
}

function identityForDeal(deal: Deal): ProductIdentity {
  return {
    id: deal.id,
    sourceName: deal.name,
    brand: deal.brand,
    size: deal.size,
    category: deal.category,
    gtin: deal.gtin,
    retailerSlug: retailerSlugForDeal(deal),
  };
}

function displayName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 'Unnamed product';
  if (/[A-Z]/.test(trimmed.slice(1))) return trimmed;
  return trimmed.charAt(0).toLocaleUpperCase('en-NZ') + trimmed.slice(1);
}

function uniqueRetailerCount(deals: Deal[]) {
  return new Set(deals.map(retailerSlugForDeal)).size;
}

function offerFromDeal(deal: Deal): ComparisonOffer {
  const previousPoint = deal.history.at(-2);
  const offerPrice = dealOfferPrice(deal);
  const previousPrice = previousPoint?.price ?? null;
  return {
    ...deal,
    offerPrice,
    previousPrice,
    weeklyChange: previousPrice === null ? null : offerPrice - previousPrice,
    retailerSlug: retailerSlugForDeal(deal),
  };
}

function comparisonFromGroup(group: WorkingGroup): ProductComparison {
  const offers = group.deals
    .map(offerFromDeal)
    .sort(
      (left, right) =>
        left.offerPrice - right.offerPrice ||
        left.retailer.localeCompare(right.retailer, 'en-NZ'),
    );
  const currentPrices = offers.map((offer) => offer.offerPrice);
  const lowestPrice = Math.min(...currentPrices);
  const history = comparePriceObservations(offers);
  const preferred =
    group.deals.find((deal) => deal.canonicalId === group.id) ?? group.deals[0];

  return {
    id: group.id,
    name: displayName(preferred.name),
    brand: preferred.brand.trim()
      ? displayName(preferred.brand)
      : 'Brand not listed',
    size: preferred.size,
    category: displayName(preferred.category),
    imageUrl: group.deals.find((deal) => deal.imageUrl)?.imageUrl,
    offers,
    lowestPrice,
    highestPrice: Math.max(...currentPrices),
    retailerCount: uniqueRetailerCount(group.deals),
    possibleSaving: Math.max(...currentPrices) - lowestPrice,
    weeklyChange: history?.change ?? null,
    matchConfidence: group.confidence,
    matchMethod: group.matchMethod,
    updatedAt:
      group.deals
        .map((deal) => deal.collectedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
  };
}

export function buildProductComparisons(deals: Deal[]) {
  const groups: WorkingGroup[] = [];
  const groupsById = new Map<string, WorkingGroup>();
  const groupsByBucket = new Map<string, WorkingGroup[]>();
  const groupsByMeasure = new Map<string, WorkingGroup[]>();
  const groupsByGtin = new Map<string, WorkingGroup[]>();
  const groupsByTitleToken = new Map<string, WorkingGroup[]>();
  const groupsBySourceProduct = new Map<string, WorkingGroup>();

  const registerGroup = (group: WorkingGroup) => {
    groups.push(group);
    groupsById.set(group.id, group);
    for (const deal of group.deals) {
      const key = retailerProductKey(deal);
      if (key) groupsBySourceProduct.set(key, group);
    }
    addToIndex(groupsByBucket, matchingBucket(group.identity), group);
    addToIndex(groupsByMeasure, measureKey(group.identity), group);
    const gtin = normalizeProductText(group.identity.gtin);
    if (gtin) addToIndex(groupsByGtin, gtin, group);
    for (const token of productBlockingTokens(group.identity)) {
      addToIndex(groupsByTitleToken, token, group);
    }
  };

  const appendDeal = (group: WorkingGroup, deal: Deal) => {
    group.deals.push(deal);
    group.identities.push(identityForDeal(deal));
    group.storeKeys.add(offerStoreKey(deal));
    const key = retailerProductKey(deal);
    if (key) groupsBySourceProduct.set(key, group);
  };

  // Preserve one latest observation per source product and physical store.
  const uniqueOffers = new Map<string, Deal>();
  for (const deal of deals) {
    const key = JSON.stringify([
      retailerProductKey(deal) ?? deal.id,
      offerStoreKey(deal),
    ]);
    const existing = uniqueOffers.get(key);
    if (!existing || (deal.collectedAt ?? '') >= (existing.collectedAt ?? ''))
      uniqueOffers.set(key, deal);
  }
  for (const deal of uniqueOffers.values()) {
    const identity = identityForDeal(deal);
    if (deal.canonicalId) {
      const existing = groupsById.get(deal.canonicalId);
      if (existing) {
        appendDeal(existing, deal);
        existing.confidence = Math.min(
          existing.confidence,
          deal.matchConfidence ?? 1,
        );
      } else {
        registerGroup({
          id: deal.canonicalId,
          identity,
          identities: [identity],
          deals: [deal],
          storeKeys: new Set([offerStoreKey(deal)]),
          confidence: deal.matchConfidence ?? 1,
          matchMethod: deal.matchMethod ?? 'seed',
        });
      }
      continue;
    }

    const sourceKey = retailerProductKey(deal);
    const existingSource = sourceKey
      ? groupsBySourceProduct.get(sourceKey)
      : undefined;
    if (existingSource) {
      // A retailer's stable SKU identifies one product across its stores, even
      // when a store omits brand/pack metadata. Store prices remain separate.
      appendDeal(existingSource, deal);
      continue;
    }

    let best:
      | { group: WorkingGroup; score: ReturnType<typeof scoreProductMatch> }
      | undefined;
    const candidates = new Set<WorkingGroup>();
    const gtin = normalizeProductText(identity.gtin);
    if (gtin) {
      for (const group of groupsByGtin.get(gtin) ?? []) candidates.add(group);
    }
    const brand = normalizedBrand(identity.brand);
    const measure = measureKey(identity);
    if (brand || measure !== 'unmeasured') {
      for (const group of groupsByBucket.get(matchingBucket(identity)) ?? []) {
        candidates.add(group);
      }
    }
    if (!brand && measure !== 'unmeasured') {
      for (const group of groupsByMeasure.get(measure) ?? []) {
        candidates.add(group);
      }
    } else if (brand && measure !== 'unmeasured') {
      for (const group of groupsByBucket.get(`unbranded|${measure}`) ?? []) {
        candidates.add(group);
      }
    } else {
      for (const token of productBlockingTokens(identity)) {
        for (const group of groupsByTitleToken.get(token) ?? []) {
          if (!brand || !normalizedBrand(group.identity.brand)) {
            candidates.add(group);
          }
        }
      }
    }

    for (const group of candidates) {
      if (group.storeKeys.has(offerStoreKey(deal))) continue;
      const score = scoreProductMatch(identity, group.identity);
      if (
        score.decision === 'auto' &&
        (!best || score.score > best.score.score) &&
        group.identities.every(
          (member) => scoreProductMatch(identity, member).decision === 'auto',
        )
      ) {
        best = { group, score };
      }
    }

    if (best) {
      appendDeal(best.group, deal);
      best.group.confidence = Math.min(best.group.confidence, best.score.score);
      best.group.matchMethod = best.score.method;
      continue;
    }

    const baseId = canonicalProductSlug(identity);
    const id = groupsById.has(baseId) ? `${baseId}-${deal.id}` : baseId;
    registerGroup({
      id,
      identity,
      identities: [identity],
      deals: [deal],
      storeKeys: new Set([offerStoreKey(deal)]),
      confidence: 1,
      matchMethod: 'seed',
    });
  }

  return groups
    .map(comparisonFromGroup)
    .sort(
      (left, right) =>
        right.retailerCount - left.retailerCount ||
        right.possibleSaving - left.possibleSaving ||
        left.name.localeCompare(right.name, 'en-NZ'),
    );
}
