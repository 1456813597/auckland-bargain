import { isSupabaseConfigured } from '@/db/supabase';
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
    try {
      const database = await getCurrentDeals();
      return { ...database, source: 'database' };
    } catch (error) {
      console.warn(
        'Could not read deals from Supabase; using fallback data.',
        error,
      );
    }
  }

  try {
    const local = getBundledLocalDeals();
    if (local.deals.length > 0) {
      return {
        deals: local.deals,
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
