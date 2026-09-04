import { getSupabaseAdmin } from '@/db/supabase';
import {
  advertisedDiscountPercent,
  dealEvidencePercent,
  historicalDiscountEvidence,
  PAKNSAVE_MIN_ADVERTISED_DISCOUNT,
  PAKNSAVE_MIN_HISTORICAL_DISCOUNT,
  promotionLabelForDiscount,
  selectStrongDeals,
  WOOLWORTHS_MIN_ADVERTISED_DISCOUNT,
} from '@/lib/deal-quality';
import type { Deal, PricePoint } from '@/lib/deals';
import { paknsaveProductImageUrl } from '@/lib/product-images';
import { shopperFacingPriceCents } from '@/lib/retailer-pricing';

type CurrentDealRow = {
  offer_id: number;
  retailer_product_id: number;
  store_id: number;
  source_product_id: string;
  source_name: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  image_url: string | null;
  retailer_slug: string;
  retailer_name: string;
  store_name: string;
  regular_price_cents: number | null;
  effective_price_cents: number;
  promotion_type: string | null;
  promotion_text: string | null;
  advertised_discount_percent: number;
  collected_at: string;
};

type HistoryRow = {
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
  const points = history.map((point) => ({
    date: dateLabel.format(new Date(point.observed_at)),
    price:
      shopperFacingPriceCents({
        retailerSlug,
        promotionText: point.promotion_text,
        regularPriceCents: point.regular_price_cents,
        effectivePriceCents: point.effective_price_cents,
      }) / 100,
  }));

  if (points.length === 0) {
    points.push({
      date: dateLabel.format(new Date(collectedAt)),
      price: currentPriceCents / 100,
    });
  }
  return points;
}

export async function getCurrentDeals() {
  const supabase = getSupabaseAdmin();
  const [woolworthsResult, paknsaveResult] = await Promise.all([
    supabase
      .from('current_deals')
      .select('*')
      .eq('retailer_slug', 'woolworths')
      .gte('advertised_discount_percent', WOOLWORTHS_MIN_ADVERTISED_DISCOUNT)
      .order('advertised_discount_percent', { ascending: false })
      .limit(500),
    supabase
      .from('current_deals')
      .select('*')
      .eq('retailer_slug', 'paknsave')
      .order('advertised_discount_percent', { ascending: false })
      .limit(1_000),
  ]);

  if (woolworthsResult.error) {
    throw new Error(`Read Woolworths deals: ${woolworthsResult.error.message}`);
  }
  if (paknsaveResult.error) {
    throw new Error(`Read PAK'nSAVE deals: ${paknsaveResult.error.message}`);
  }

  const rowsByOffer = new Map<number, CurrentDealRow>();
  for (const row of [
    ...(woolworthsResult.data ?? []),
    ...(paknsaveResult.data ?? []),
  ] as CurrentDealRow[]) {
    rowsByOffer.set(row.offer_id, row);
  }
  const rows = [...rowsByOffer.values()];
  if (rows.length === 0) {
    return { deals: [] as Deal[], updatedAt: null as string | null };
  }

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
  const productIds = [...new Set(rows.map((row) => row.retailer_product_id))];
  const productIdBatches: number[][] = [];
  for (let index = 0; index < productIds.length; index += 200) {
    productIdBatches.push(productIds.slice(index, index + 200));
  }
  const historyResults = await Promise.all(
    productIdBatches.map((batch) =>
      supabase
        .from('offer_history')
        .select(
          'retailer_product_id,store_id,regular_price_cents,effective_price_cents,promotion_text,observed_at',
        )
        .in('retailer_product_id', batch)
        .gte('observed_at', cutoff.toISOString())
        .order('observed_at', { ascending: true }),
    ),
  );
  const historyData: HistoryRow[] = [];
  for (const result of historyResults) {
    if (result.error) {
      throw new Error(`Read offer history: ${result.error.message}`);
    }
    historyData.push(...((result.data ?? []) as HistoryRow[]));
  }

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
      historicalPrices.length >= 3
        ? historicalPrices.reduce((sum, price) => sum + price, 0) /
          historicalPrices.length
        : regularPrice;
    const deal: Deal = {
      id: `${row.retailer_slug}-${row.source_product_id}`,
      name: row.source_name,
      size: row.size ?? 'See product details',
      brand: row.brand ?? row.retailer_name,
      category: row.category ?? 'Other',
      retailer: row.retailer_name,
      store: row.store_name,
      price: currentPriceCents / 100,
      regularPrice,
      average90d,
      low90d: Math.min(...historicalPrices, currentPriceCents / 100),
      score: 0,
      promotion:
        row.promotion_text ??
        (row.promotion_type === 'MEMBER_PRICE'
          ? 'Member price'
          : `${row.retailer_name} special`),
      memberOnly: row.promotion_type === 'MEMBER_PRICE',
      imageUrl:
        (row.retailer_slug === 'paknsave'
          ? paknsaveProductImageUrl(row.source_product_id)
          : null) ??
        row.image_url ??
        undefined,
      color: row.retailer_slug === 'paknsave' ? '#f4b942' : '#83a977',
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
        ? `${historicalEvidence.discountPercent}% below 90-day median`
        : null;
    if (evidencePromotion) deal.promotion = evidencePromotion;
    deal.score = Math.min(
      99,
      Math.round(
        55 + dealEvidencePercent(deal) * 1.2 + (history.length >= 4 ? 5 : 0),
      ),
    );
    return deal;
  });

  const strongDeals = selectStrongDeals(deals);

  const updatedAt = rows.reduce(
    (latest, row) =>
      !latest || row.collected_at > latest ? row.collected_at : latest,
    null as string | null,
  );

  return { deals: strongDeals, updatedAt };
}
