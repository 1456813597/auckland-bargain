import { isDatabaseConfigured } from '@/db/client';
import { selectStrongDeals } from '@/lib/deal-quality';
import { demoDeals, type Deal } from '@/lib/deals';
import { getBundledLocalDeals } from '@/lib/local-deals';
import { getCurrentDeals, getCurrentOffers } from '@/lib/repositories/deals';

export type DealSource = 'database' | 'local-json' | 'demo';

export type DealsResult = {
  deals: Deal[];
  updatedAt: string | null;
  source: DealSource;
};

function withSnapshotTimestamp(deals: Deal[], generatedAt: string | null) {
  if (!generatedAt) return deals;
  return deals.map((deal) =>
    deal.collectedAt ? deal : { ...deal, collectedAt: generatedAt },
  );
}

export async function getDealsWithFallback(): Promise<DealsResult> {
  if (isDatabaseConfigured()) {
    const database = await getCurrentDeals();
    return { ...database, source: 'database' };
  }

  try {
    const local = getBundledLocalDeals();
    if (local.deals.length > 0) {
      return {
        deals: selectStrongDeals(
          withSnapshotTimestamp(local.deals, local.generatedAt),
        ),
        updatedAt: local.generatedAt,
        source: 'local-json',
      };
    }
  } catch (error) {
    console.warn(
      'Could not read the local deals snapshot; using demo data.',
      error,
    );
  }

  return { deals: demoDeals, updatedAt: null, source: 'demo' };
}

export async function getOffersWithFallback(): Promise<DealsResult> {
  if (isDatabaseConfigured()) {
    const database = await getCurrentOffers();
    return { ...database, source: 'database' };
  }

  try {
    const local = getBundledLocalDeals();
    if (local.deals.length > 0) {
      return {
        deals: withSnapshotTimestamp(local.deals, local.generatedAt),
        updatedAt: local.generatedAt,
        source: 'local-json',
      };
    }
  } catch (error) {
    console.warn(
      'Could not read the local offers snapshot; using demo data.',
      error,
    );
  }

  return { deals: demoDeals, updatedAt: null, source: 'demo' };
}
