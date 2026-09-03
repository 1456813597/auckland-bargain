import { isSupabaseConfigured } from '@/db/supabase';
import { dealEvidencePercent, isStrongDeal } from '@/lib/deal-quality';
import { demoDeals, type Deal } from '@/lib/deals';
import { getBundledLocalDeals } from '@/lib/local-deals';
import { getCurrentDeals } from '@/lib/repositories/deals';

export type DealSource = 'database' | 'local-json' | 'demo';

export type DealsResult = {
  deals: Deal[];
  updatedAt: string | null;
  source: DealSource;
};

export async function getDealsWithFallback(): Promise<DealsResult> {
  if (isSupabaseConfigured()) {
    const database = await getCurrentDeals();
    return { ...database, source: 'database' };
  }

  try {
    const local = getBundledLocalDeals();
    if (local.deals.length > 0) {
      return {
        deals: local.deals
          .filter(isStrongDeal)
          .sort(
            (left, right) =>
              dealEvidencePercent(right) - dealEvidencePercent(left) ||
              right.score - left.score ||
              left.name.localeCompare(right.name),
          )
          .slice(0, 100),
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
