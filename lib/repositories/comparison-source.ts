import { buildProductComparisons } from '@/lib/comparisons';
import { getOffersWithFallback } from '@/lib/repositories/deal-source';

export type ComparisonSource = {
  comparisons: ReturnType<typeof buildProductComparisons>;
  source: 'database' | 'local-json' | 'demo';
  updatedAt: string | null;
};

// Prices are published once a week, but every render needs the whole catalogue:
// reading and grouping it per request costs seconds against the database, which
// is long enough that a filter click looks like it did nothing. Serve a short
// lived process snapshot instead, so only the first request after it expires
// pays for the read.
const SNAPSHOT_TTL_MS = Number(
  process.env.COMPARISON_SNAPSHOT_MS ?? 5 * 60 * 1000,
);

let snapshot:
  | { key: string; value: ComparisonSource; expiresAt: number }
  | undefined;
let inFlight: Promise<ComparisonSource> | undefined;

async function readComparisons() {
  const source = await getOffersWithFallback();
  const key = `${source.source}:${source.updatedAt ?? 'demo'}:${source.deals.length}`;
  // Bundled snapshots are immutable until the build's timestamp changes, so an
  // unchanged catalogue keeps the grouping it already has. Database rows can
  // gain accepted matches without moving a price timestamp, so they are only
  // ever trusted for the length of one expiry window.
  if (source.source !== 'database' && snapshot?.key === key) {
    return { key, value: snapshot.value };
  }
  return {
    key,
    value: {
      comparisons: buildProductComparisons(source.deals),
      source: source.source,
      updatedAt: source.updatedAt,
    } satisfies ComparisonSource,
  };
}

export async function getComparisonsWithFallback(): Promise<ComparisonSource> {
  if (snapshot && snapshot.expiresAt > Date.now()) return snapshot.value;
  // Collapse concurrent misses so a cold snapshot never starts two full reads.
  inFlight ??= readComparisons()
    .then(({ key, value }) => {
      snapshot = { key, value, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

export function resetComparisonSnapshot() {
  snapshot = undefined;
  inFlight = undefined;
}
