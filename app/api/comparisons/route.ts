import { getComparisonsWithFallback } from '@/lib/repositories/comparison-source';
import {
  parseComparisonFilters,
  queryComparisons,
} from '@/lib/comparison-query';

export async function GET(request: Request) {
  const filters = parseComparisonFilters(
    new URL(request.url).searchParams,
    100,
  );
  const source = await getComparisonsWithFallback();
  const results = queryComparisons(source.comparisons, filters);
  const comparisons = results.products;

  return Response.json(
    {
      data: comparisons,
      meta: {
        count: comparisons.length,
        total: results.total,
        page: results.filters.page,
        pageSize: filters.limit,
        totalPages: results.totalPages,
        currency: 'NZD',
        cadence: 'weekly',
        retainedHistorySnapshots: 1,
        source: source.source,
        updatedAt: source.updatedAt,
      },
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
