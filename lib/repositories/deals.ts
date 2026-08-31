import { getSupabaseAdmin } from "@/db/supabase";
import type { Deal, PricePoint } from "@/lib/deals";

type CurrentDealRow = {
  retailer_product_id: number;
  store_id: number;
  source_product_id: string;
  source_name: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  image_url: string | null;
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
  effective_price_cents: number;
  observed_at: string;
};

const dateLabel = new Intl.DateTimeFormat("en-NZ", {
  day: "2-digit",
  month: "short",
  timeZone: "Pacific/Auckland",
});

function historyPoints(
  history: HistoryRow[],
  currentPriceCents: number,
  collectedAt: string,
): PricePoint[] {
  const points = history.map((point) => ({
    date: dateLabel.format(new Date(point.observed_at)),
    price: point.effective_price_cents / 100,
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
  const { data, error } = await supabase
    .from("current_deals")
    .select("*")
    .order("advertised_discount_percent", { ascending: false })
    .limit(100);

  if (error) throw new Error(`Read current deals: ${error.message}`);
  const rows = (data ?? []) as CurrentDealRow[];
  if (rows.length === 0) {
    return { deals: [] as Deal[], updatedAt: null as string | null };
  }

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
  const productIds = [...new Set(rows.map((row) => row.retailer_product_id))];
  const { data: historyData, error: historyError } = await supabase
    .from("offer_history")
    .select(
      "retailer_product_id,store_id,effective_price_cents,observed_at",
    )
    .in("retailer_product_id", productIds)
    .gte("observed_at", cutoff.toISOString())
    .order("observed_at", { ascending: true });

  if (historyError) {
    throw new Error(`Read offer history: ${historyError.message}`);
  }

  const historyByOffer = new Map<string, HistoryRow[]>();
  for (const point of (historyData ?? []) as HistoryRow[]) {
    const key = `${point.retailer_product_id}:${point.store_id}`;
    const values = historyByOffer.get(key) ?? [];
    values.push(point);
    historyByOffer.set(key, values);
  }

  const deals = rows.map((row): Deal => {
    const history = historyPoints(
      historyByOffer.get(
        `${row.retailer_product_id}:${row.store_id}`,
      ) ?? [],
      row.effective_price_cents,
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
    const advertisedDiscount = Math.max(
      0,
      Number(row.advertised_discount_percent ?? 0),
    );

    return {
      id: `woolworths-${row.source_product_id}`,
      name: row.source_name,
      size: row.size ?? "See product details",
      brand: row.brand ?? "Woolworths",
      category: row.category ?? "Other",
      retailer: row.retailer_name,
      store: row.store_name,
      price: row.effective_price_cents / 100,
      regularPrice,
      average90d,
      low90d: Math.min(...historicalPrices, row.effective_price_cents / 100),
      score: Math.min(
        99,
        Math.round(55 + advertisedDiscount * 1.2 + (history.length >= 3 ? 5 : 0)),
      ),
      promotion:
        row.promotion_text ??
        (row.promotion_type === "MEMBER_PRICE"
          ? "Member price"
          : "Woolworths special"),
      memberOnly: row.promotion_type === "MEMBER_PRICE",
      imageUrl: row.image_url ?? undefined,
      color: "#83a977",
      history,
    };
  });

  const updatedAt = rows.reduce(
    (latest, row) =>
      !latest || row.collected_at > latest ? row.collected_at : latest,
    null as string | null,
  );

  return { deals, updatedAt };
}
