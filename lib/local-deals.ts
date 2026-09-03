import bundledSnapshot from '@/data/deals.json';

import type { CollectorStore, RawOffer } from '@/lib/collectors/types';
import type { Deal, PricePoint } from '@/lib/deals';

export const LOCAL_DEALS_SCHEMA_VERSION = 1 as const;

export type LocalRetailerSnapshot = {
  slug: string;
  name: string;
  store: CollectorStore;
  dealCount: number;
  collectedAt: string;
};

export type LocalDealsSnapshot = {
  schemaVersion: typeof LOCAL_DEALS_SCHEMA_VERSION;
  generatedAt: string | null;
  retailers: LocalRetailerSnapshot[];
  deals: Deal[];
};

type OfferCollection = {
  retailerSlug: string;
  retailerName: string;
  store: CollectorStore;
  offers: RawOffer[];
};

const dateLabel = new Intl.DateTimeFormat('en-NZ', {
  day: '2-digit',
  month: 'short',
  timeZone: 'Pacific/Auckland',
});

const retailerColors: Record<string, string> = {
  paknsave: '#f4b942',
  woolworths: '#83a977',
};

function isPricePoint(value: unknown): value is PricePoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.date === 'string' &&
    typeof point.price === 'number' &&
    Number.isFinite(point.price)
  );
}

function isDeal(value: unknown): value is Deal {
  if (!value || typeof value !== 'object') return false;
  const deal = value as Record<string, unknown>;
  return (
    typeof deal.id === 'string' &&
    typeof deal.name === 'string' &&
    typeof deal.size === 'string' &&
    typeof deal.brand === 'string' &&
    typeof deal.category === 'string' &&
    typeof deal.retailer === 'string' &&
    typeof deal.store === 'string' &&
    typeof deal.price === 'number' &&
    Number.isFinite(deal.price) &&
    typeof deal.regularPrice === 'number' &&
    Number.isFinite(deal.regularPrice) &&
    typeof deal.average90d === 'number' &&
    Number.isFinite(deal.average90d) &&
    typeof deal.low90d === 'number' &&
    Number.isFinite(deal.low90d) &&
    typeof deal.score === 'number' &&
    Number.isFinite(deal.score) &&
    typeof deal.promotion === 'string' &&
    typeof deal.memberOnly === 'boolean' &&
    (deal.imageUrl === undefined || typeof deal.imageUrl === 'string') &&
    typeof deal.color === 'string' &&
    Array.isArray(deal.history) &&
    deal.history.every(isPricePoint)
  );
}

export function parseLocalDealsSnapshot(value: unknown): LocalDealsSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Local deals snapshot must be a JSON object.');
  }

  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== LOCAL_DEALS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported local deals schema version: ${String(snapshot.schemaVersion)}.`,
    );
  }
  if (
    snapshot.generatedAt !== null &&
    (typeof snapshot.generatedAt !== 'string' ||
      Number.isNaN(Date.parse(snapshot.generatedAt)))
  ) {
    throw new Error('Local deals generatedAt must be null or an ISO date.');
  }
  if (!Array.isArray(snapshot.deals) || !snapshot.deals.every(isDeal)) {
    throw new Error('Local deals snapshot contains an invalid deal.');
  }

  return {
    schemaVersion: LOCAL_DEALS_SCHEMA_VERSION,
    generatedAt: snapshot.generatedAt as string | null,
    retailers: Array.isArray(snapshot.retailers)
      ? (snapshot.retailers as LocalRetailerSnapshot[])
      : [],
    deals: snapshot.deals,
  };
}

export function getBundledLocalDeals() {
  return parseLocalDealsSnapshot(bundledSnapshot);
}

function appendHistory(
  previous: Deal | undefined,
  price: number,
  collectedAt: Date,
) {
  const nextPoint = { date: dateLabel.format(collectedAt), price };
  const history = previous?.history.slice() ?? [];
  const last = history.at(-1);

  if (last?.date === nextPoint.date) {
    history[history.length - 1] = nextPoint;
  } else if (!last || last.price !== nextPoint.price) {
    history.push(nextPoint);
  }

  return history.slice(-90);
}

export function offersToLocalDeals(
  collection: OfferCollection,
  previousDeals: Deal[] = [],
) {
  const previousById = new Map(previousDeals.map((deal) => [deal.id, deal]));

  return collection.offers.flatMap((offer): Deal[] => {
    const effectivePriceCents =
      offer.memberPriceCents ??
      offer.promoPriceCents ??
      offer.regularPriceCents;
    if (effectivePriceCents === null || effectivePriceCents <= 0) return [];

    const regularPriceCents = offer.regularPriceCents ?? effectivePriceCents;
    const price = effectivePriceCents / 100;
    const regularPrice = regularPriceCents / 100;
    const id = `${collection.retailerSlug}-${offer.sourceProductId}`;
    const history = appendHistory(
      previousById.get(id),
      price,
      offer.collectedAt,
    );
    const historicalPrices = history.map((point) => point.price);
    const average90d =
      historicalPrices.length >= 3
        ? historicalPrices.reduce((sum, value) => sum + value, 0) /
          historicalPrices.length
        : regularPrice;
    const advertisedDiscount =
      regularPriceCents > 0
        ? Math.max(
            0,
            Math.round(
              (100 * (regularPriceCents - effectivePriceCents)) /
                regularPriceCents,
            ),
          )
        : 0;

    return [
      {
        id,
        name: offer.sourceName,
        size: offer.size ?? 'See product details',
        brand: offer.brand ?? collection.retailerName,
        category: offer.category ?? 'Other',
        retailer: collection.retailerName,
        store: collection.store.name,
        price,
        regularPrice,
        average90d,
        low90d: Math.min(...historicalPrices, price),
        score: Math.min(
          99,
          Math.round(
            55 + advertisedDiscount * 1.2 + (history.length >= 3 ? 5 : 0),
          ),
        ),
        promotion:
          offer.promotionText ??
          (offer.promotionType === 'MEMBER_PRICE'
            ? 'Member price'
            : `${collection.retailerName} special`),
        memberOnly: offer.promotionType === 'MEMBER_PRICE',
        ...(offer.imageUrl ? { imageUrl: offer.imageUrl } : {}),
        color: retailerColors[collection.retailerSlug] ?? '#83a8a1',
        history,
      },
    ];
  });
}
