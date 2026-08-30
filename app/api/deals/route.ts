import { demoDeals, discountPercent } from "@/lib/deals";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const retailer = url.searchParams.get("retailer")?.toLowerCase();
  const category = url.searchParams.get("category")?.toLowerCase();
  const minimumDiscount = Number(url.searchParams.get("minDiscount") ?? 0);

  const deals = demoDeals.filter((deal) => {
    const searchable = `${deal.name} ${deal.brand} ${deal.store} ${deal.category}`.toLowerCase();
    return (
      (!query || searchable.includes(query)) &&
      (!retailer || deal.retailer.toLowerCase() === retailer) &&
      (!category || deal.category.toLowerCase() === category) &&
      discountPercent(deal) >= minimumDiscount
    );
  });

  return Response.json({
    data: deals,
    meta: {
      count: deals.length,
      currency: "NZD",
      timezone: "Pacific/Auckland",
      demo: true,
    },
  });
}
