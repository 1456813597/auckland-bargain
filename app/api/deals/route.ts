import { discountPercent } from '@/lib/deals';
import { getDealsWithFallback } from '@/lib/repositories/deal-source';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const retailer = url.searchParams.get('retailer')?.toLowerCase();
  const category = url.searchParams.get('category')?.toLowerCase();
  const minimumDiscount = Number(url.searchParams.get('minDiscount') ?? 0);

  const source = await getDealsWithFallback();

  const deals = source.deals.filter((deal) => {
    const searchable =
      `${deal.name} ${deal.brand} ${deal.store} ${deal.category}`.toLowerCase();
    return (
      (!query || searchable.includes(query)) &&
      (!retailer || deal.retailer.toLowerCase() === retailer) &&
      (!category || deal.category.toLowerCase() === category) &&
      discountPercent(deal) >= minimumDiscount
    );
  });

  return Response.json(
    {
      data: deals,
      meta: {
        count: deals.length,
        currency: 'NZD',
        timezone: 'Pacific/Auckland',
        demo: source.source === 'demo',
        source: source.source,
        updatedAt: source.updatedAt,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
