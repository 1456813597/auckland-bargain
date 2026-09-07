import { getSupabaseAdmin, isSupabaseConfigured } from '@/db/supabase';

type ReadinessRpcResult = {
  schemaVersion?: unknown;
  currentDeals?: unknown;
  claimCollectionRun?: unknown;
  atomicWeeklySnapshots?: unknown;
  durableCollectionQueue?: unknown;
  productImageMirrorIndex?: unknown;
  ready?: unknown;
};

export type DatabaseReadiness = {
  ready: boolean;
  schemaVersion: string | null;
  checks: {
    supabaseConfigured: boolean;
    readinessFunction: boolean;
    currentDeals: boolean;
    claimCollectionRun: boolean;
    currentDealsReadable: boolean;
    atomicWeeklySnapshots: boolean;
    durableCollectionQueue: boolean;
    productImageMirrorIndex: boolean;
  };
  error?: string;
};

export async function checkDatabaseReadiness(): Promise<DatabaseReadiness> {
  if (!isSupabaseConfigured()) {
    return {
      ready: false,
      schemaVersion: null,
      checks: {
        supabaseConfigured: false,
        readinessFunction: false,
        currentDeals: false,
        claimCollectionRun: false,
        currentDealsReadable: false,
        atomicWeeklySnapshots: false,
        durableCollectionQueue: false,
        productImageMirrorIndex: false,
      },
      error: 'Supabase is not configured.',
    };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('database_readiness');
  if (error) {
    return {
      ready: false,
      schemaVersion: null,
      checks: {
        supabaseConfigured: true,
        readinessFunction: false,
        currentDeals: false,
        claimCollectionRun: false,
        currentDealsReadable: false,
        atomicWeeklySnapshots: false,
        durableCollectionQueue: false,
        productImageMirrorIndex: false,
      },
      error: `Database readiness RPC failed: ${error.message}`,
    };
  }

  const rpc = (data ?? {}) as ReadinessRpcResult;
  const currentDeals = rpc.currentDeals === true;
  const claimCollectionRun = rpc.claimCollectionRun === true;
  const atomicWeeklySnapshots = rpc.atomicWeeklySnapshots === true;
  const durableCollectionQueue = rpc.durableCollectionQueue === true;
  const productImageMirrorIndex = rpc.productImageMirrorIndex === true;
  const rpcReady = rpc.ready === true;
  const { error: dealsError } = await supabase
    .from('current_deals')
    .select('offer_id')
    .limit(1);
  const currentDealsReadable = dealsError === null;
  const ready =
    rpcReady &&
    currentDeals &&
    claimCollectionRun &&
    currentDealsReadable &&
    atomicWeeklySnapshots &&
    durableCollectionQueue &&
    productImageMirrorIndex;

  return {
    ready,
    schemaVersion:
      typeof rpc.schemaVersion === 'string' ? rpc.schemaVersion : null,
    checks: {
      supabaseConfigured: true,
      readinessFunction: true,
      currentDeals,
      claimCollectionRun,
      currentDealsReadable,
      atomicWeeklySnapshots,
      durableCollectionQueue,
      productImageMirrorIndex,
    },
    ...(dealsError
      ? { error: `Current deals readiness query failed: ${dealsError.message}` }
      : {}),
  };
}
