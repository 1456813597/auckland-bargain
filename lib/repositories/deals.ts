import { getSupabaseAdmin } from '@/db/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  advertisedDiscountPercent,
  dealEvidencePercent,
  historicalDiscountEvidence,
  PAKNSAVE_MIN_ADVERTISED_DISCOUNT,
  PAKNSAVE_MIN_HISTORICAL_DISCOUNT,
  promotionLabelForDiscount,
  selectStrongDeals,
} from '@/lib/deal-quality';
import type { Deal, PricePoint } from '@/lib/deals';
import { paknsaveProductImageUrl } from '@/lib/product-images';
import { multiBuyOffer, shopperFacingPriceCents } from '@/lib/retailer-pricing';
import { nzWeekStart } from '@/lib/weekly-history';
import { scopedOfferId } from '@/lib/offer-identity';

type CurrentDealRow = {
  offer_id: number;
  retailer_product_id: number;
  store_id: number;
  source_product_id: string;
  source_name: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  gtin: string | null;
  image_url: string | null;
  source_url: string | null;
  retailer_slug: string;
  retailer_name: string;
  store_name: string;
  city: string;
  regular_price_cents: number | null;
  effective_price_cents: number;
  promotion_type: string | null;
  promotion_text: string | null;
  advertised_discount_percent: number;
  collected_at: string;
  canonical_slug?: string | null;
  canonical_name?: string | null;
  canonical_brand?: string | null;
  canonical_size?: string | null;
  canonical_category?: string | null;
  match_confidence?: number | null;
  match_method?: 'gtin' | 'attributes' | 'seed' | 'manual' | null;
};

type HistoryRow = {
  id: number;
  retailer_product_id: number;
  store_id: number;
  regular_price_cents: number | null;
  effective_price_cents: number;
  promotion_text: string | null;
  observed_at: string;
};

const dateLabel = new Intl.DateTimeFormat('en-NZ', {
  day: '2-digit',
  month: 'short',
  timeZone: 'Pacific/Auckland',
});

function historyPoints(
  history: HistoryRow[],
  retailerSlug: string,
  currentPriceCents: number,
  collectedAt: string,
): PricePoint[] {
  const points = history
    .toSorted((left, right) =>
      left.observed_at.localeCompare(right.observed_at),
    )
    .map((point) => ({
      date: dateLabel.format(new Date(point.observed_at)),
      observedAt: point.observed_at,
      weekStart: nzWeekStart(point.observed_at),
      price:
        (multiBuyOffer(point.promotion_text)?.unitPriceCents ??
          shopperFacingPriceCents({
            retailerSlug,
            promotionText: point.promotion_text,
            regularPriceCents: point.regular_price_cents,
            effectivePriceCents: point.effective_price_cents,
          })) / 100,
    }));

  if (points.length === 0) {
    points.push({
      date: dateLabel.format(new Date(collectedAt)),
      observedAt: collectedAt,
      weekStart: nzWeekStart(collectedAt),
      price: currentPriceCents / 100,
    });
  }
  return points.slice(-2);
}

const DATABASE_PAGE_SIZE = 500;

export async function readCurrentRows(
  supabase: SupabaseClient = getSupabaseAdmin(),
) {
  const rows: CurrentDealRow[] = [];
  let cursor = 0;
  for (;;) {
    const result = await supabase
      .from('current_deals')
      .select('*')
      .gt('offer_id', cursor)
      .order('offer_id', { ascending: true })
      .limit(DATABASE_PAGE_SIZE);
    if (result.error) {
      throw new Error(`Read current offers: ${result.error.message}`);
    }
    const page = (result.data ?? []) as CurrentDealRow[];
    if (!page.length) break;
    rows.push(...page);
    const next = page.at(-1)!.offer_id;
    if (next <= cursor)
      throw new Error('Current offers pagination did not advance');
    cursor = next;
  }
  return rows;
}

export async function readOfferHistory(
  supabase: SupabaseClient,
  productIds: number[],
) {
  const batches: number[][] = [];
  for (let index = 0; index < productIds.length; index += 100)
    batches.push(productIds.slice(index, index + 100));
  const history: HistoryRow[] = [];
  for (let index = 0; index < batches.length; index += 4) {
    const pages = await Promise.all(
      batches.slice(index, index + 4).map(async (batch) => {
        const rows: HistoryRow[] = [];
        let cursor = 0;
        for (;;) {
          const { data, error } = await supabase
            .from('offer_history')
            .select(
              'id,retailer_product_id,store_id,regular_price_cents,effective_price_cents,promotion_text,observed_at',
            )
            .in('retailer_product_id', batch)
            .gt('id', cursor)
            .order('id')
            .limit(DATABASE_PAGE_SIZE);
          if (error) throw new Error(`Read offer history: ${error.message}`);
          const page = (data ?? []) as HistoryRow[];
          if (!page.length) break;
          rows.push(...page);
          const next = page.at(-1)!.id;
          if (next <= cursor)
            throw new Error('Offer history pagination did not advance');
          cursor = next;
        }
        return rows;
      }),
    );
    for (const page of pages) history.push(...page);
  }
  return history;
}

async function getOffers(strongOnly: boolean) {
  const supabase = getSupabaseAdmin();
  const rows = await readCurrentRows();
  if (rows.length === 0) {
    return { deals: [] as Deal[], updatedAt: null as string | null };
  }

  const productIds = [...new Set(rows.map((row) => row.retailer_product_id))];
  const historyData = await readOfferHistory(supabase, productIds);

  const historyByOffer = new Map<string, HistoryRow[]>();
  for (const point of historyData) {
    const key = `${point.retailer_product_id}:${point.store_id}`;
    const values = historyByOffer.get(key) ?? [];
    values.push(point);
    historyByOffer.set(key, values);
  }

  const deals = rows.map((row): Deal => {
    const currentPriceCents = shopperFacingPriceCents({
      retailerSlug: row.retailer_slug,
      promotionText: row.promotion_text,
      regularPriceCents: row.regular_price_cents,
      effectivePriceCents: row.effective_price_cents,
    });
    const history = historyPoints(
      historyByOffer.get(`${row.retailer_product_id}:${row.store_id}`) ?? [],
      row.retailer_slug,
      currentPriceCents,
      row.collected_at,
    );
    const historicalPrices = history.map((point) => point.price);
    const regularPrice =
      (row.regular_price_cents ?? row.effective_price_cents) / 100;
    const average90d =
      historicalPrices.length >= 2
        ? historicalPrices.reduce((sum, price) => sum + price, 0) /
          historicalPrices.length
        : regularPrice;
    const deal: Deal = {
      id: scopedOfferId(
        row.retailer_slug,
        row.source_product_id,
        `database:${row.store_id}`,
      ),
      sourceProductId: row.source_product_id,
      retailerSlug: row.retailer_slug,
      canonicalId: row.canonical_slug ?? undefined,
      name: row.canonical_name ?? row.source_name,
      size: row.canonical_size ?? row.size ?? 'See product details',
      brand: row.canonical_brand ?? row.brand ?? '',
      category: row.canonical_category ?? row.category ?? 'Other',
      retailer: row.retailer_name,
      store: row.store_name,
      storeKey: `database:${row.store_id}`,
      storeCity: row.city,
      price: currentPriceCents / 100,
      regularPrice,
      average90d,
      low90d: Math.min(...historicalPrices, currentPriceCents / 100),
      score: 0,
      promotion:
        row.promotion_text ??
        (row.promotion_type === 'MEMBER_PRICE'
          ? 'Member price'
          : row.promotion_type === 'SPECIAL'
            ? `${row.retailer_name} special`
            : 'Observed price'),
      memberOnly: row.promotion_type === 'MEMBER_PRICE',
      imageUrl:
        (row.retailer_slug === 'paknsave'
          ? paknsaveProductImageUrl(row.source_product_id)
          : null) ??
        row.image_url ??
        undefined,
      sourceUrl: row.source_url ?? undefined,
      collectedAt: row.collected_at,
      gtin: row.gtin ?? undefined,
      matchConfidence: row.match_confidence ?? undefined,
      matchMethod: row.match_method ?? undefined,
      color:
        {
          foursquare: '#d71920',
          freshchoice: '#57943a',
          newworld: '#e31b23',
          paknsave: '#f4b942',
          supervalue: '#6f4b8b',
          woolworths: '#83a977',
        }[row.retailer_slug] ?? '#83a8a1',
      history,
    };
    const advertisedDiscount = advertisedDiscountPercent(deal);
    const historicalEvidence = historicalDiscountEvidence(deal);
    const isWoolworths = row.retailer_slug === 'woolworths';
    const isPaknsave = row.retailer_slug === 'paknsave';
    const evidencePromotion = isWoolworths
      ? promotionLabelForDiscount(advertisedDiscount)
      : isPaknsave &&
          advertisedDiscount < PAKNSAVE_MIN_ADVERTISED_DISCOUNT &&
          historicalEvidence &&
          historicalEvidence.discountPercent >= PAKNSAVE_MIN_HISTORICAL_DISCOUNT
        ? `${historicalEvidence.discountPercent}% below prior weekly price`
        : null;
    if (evidencePromotion) deal.promotion = evidencePromotion;
    deal.score = Math.min(
      99,
      Math.round(
        55 + dealEvidencePercent(deal) * 1.2 + (history.length >= 2 ? 5 : 0),
      ),
    );
    return deal;
  });

  const updatedAt = rows.reduce(
    (latest, row) =>
      !latest || row.collected_at > latest ? row.collected_at : latest,
    null as string | null,
  );

  return { deals: strongOnly ? selectStrongDeals(deals) : deals, updatedAt };
}

export async function getCurrentDeals() {
  return getOffers(true);
}

export async function getCurrentOffers() {
  return getOffers(false);
}
