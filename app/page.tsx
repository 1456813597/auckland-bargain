import { ComparisonBrowser } from '@/components/comparison-browser';
import { SiteHeader } from '@/components/site-header';
import { getComparisonsWithFallback } from '@/lib/repositories/comparison-source';
import {
  parseComparisonFilters,
  queryComparisons,
} from '@/lib/comparison-query';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const source = await getComparisonsWithFallback();
  const results = queryComparisons(
    source.comparisons,
    parseComparisonFilters(params),
  );

  return (
    <>
      <SiteHeader />
      <ComparisonBrowser
        key={params.toString()}
        results={results}
        source={source.source}
        updatedAt={source.updatedAt}
      />
    </>
  );
}
