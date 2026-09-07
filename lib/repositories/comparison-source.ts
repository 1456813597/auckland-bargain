import { buildProductComparisons } from '@/lib/comparisons';
import { getOffersWithFallback } from '@/lib/repositories/deal-source';

let cached:
  | { key: string; comparisons: ReturnType<typeof buildProductComparisons> }
  | undefined;

export async function getComparisonsWithFallback() {
  const source = await getOffersWithFallback();
  if (source.source === 'database') {
    // Accepted matches may be curated without changing a price timestamp.
    // These rows already carry canonical IDs, so grouping them is inexpensive.
    return {
      comparisons: buildProductComparisons(source.deals),
      source: source.source,
      updatedAt: source.updatedAt,
    };
  }
  // Bundled snapshots are immutable until the build's timestamp changes.
  // Keep only the current catalogue, never an unbounded query cache.
  const key = `${source.source}:${source.updatedAt ?? 'demo'}:${source.deals.length}`;
  if (!cached || cached.key !== key) {
    cached = { key, comparisons: buildProductComparisons(source.deals) };
  }
  return {
    comparisons: cached.comparisons,
    source: source.source,
    updatedAt: source.updatedAt,
  };
}
