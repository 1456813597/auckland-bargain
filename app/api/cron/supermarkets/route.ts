import { isSupabaseConfigured } from '@/db/supabase';
import { FourSquareCollector } from '@/lib/collectors/foursquare';
import {
  FreshChoiceCollector,
  SuperValueCollector,
} from '@/lib/collectors/myfoodlink';
import { NewWorldCollector } from '@/lib/collectors/newworld';
import { PaknsaveCollector } from '@/lib/collectors/paknsave';
import {
  collectForComparison,
  collectionScope,
  type CompleteRetailerCollector,
} from '@/lib/collectors/comparison-collection';
import { isAuthorizedCronRequest } from '@/lib/http/cron-auth';
import {
  CollectionAlreadyRunningError,
  createCollectionRun,
  ingestOffers,
  markCollectionRunFailed,
  type RetailerIdentity,
} from '@/lib/ingestion/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectRetailer(
  collector: CompleteRetailerCollector,
  retailer: RetailerIdentity,
  trigger: 'vercel-cron' | 'manual',
) {
  let runId: number | undefined;
  try {
    const scope = collectionScope(collector);
    const [store] = await collector.getStores();
    if (!store) throw new Error(`${retailer.name} returned no matching store.`);
    runId = await createCollectionRun(
      collector.retailerSlug,
      store.sourceStoreId,
      { trigger, group: 'weekly-supermarkets', scope },
    );
    const collection = await collectForComparison(collector, store, scope);
    const persisted = await ingestOffers({
      runId,
      retailer,
      store: collection.store,
      offers: collection.offers,
    });
    return {
      ok: true as const,
      retailer: retailer.slug,
      ...persisted,
      store: collection.store,
      pagesCollected: collection.pagesCollected,
      totalItemsReported: collection.totalItemsReported,
      scope: collection.scope,
      unpricedItems: collection.unpricedItems ?? 0,
      collectedAt: collection.offers[0]?.collectedAt.toISOString(),
    };
  } catch (error) {
    if (runId !== undefined) {
      try {
        await markCollectionRunFailed(runId, error);
      } catch (statusError) {
        console.error(
          `Could not record failed ${retailer.name} run`,
          statusError,
        );
      }
    }
    throw error;
  }
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  if (!isSupabaseConfigured()) {
    return Response.json(
      { error: 'Supabase is not configured on the server.' },
      { status: 503 },
    );
  }

  const trigger =
    request.headers.get('user-agent') === 'vercel-cron/1.0'
      ? 'vercel-cron'
      : 'manual';
  const jobs: Array<{
    collector: CompleteRetailerCollector;
    retailer: RetailerIdentity;
  }> = [
    {
      collector: new PaknsaveCollector({
        storeId: process.env.PAKNSAVE_STORE_ID,
        storeQuery: process.env.PAKNSAVE_STORE_QUERY ?? 'Royal Oak',
        city: process.env.PAKNSAVE_STORE_CITY,
        maxPages: positiveInteger(process.env.PAKNSAVE_MAX_PAGES, 20),
      }),
      retailer: {
        slug: 'paknsave',
        name: "PAK'nSAVE",
        website: 'https://www.paknsave.co.nz/',
      },
    },
    {
      collector: new NewWorldCollector({
        storeId: process.env.NEWWORLD_STORE_ID,
        storeQuery: process.env.NEWWORLD_STORE_QUERY ?? 'Metro Queen St',
        city: process.env.NEWWORLD_STORE_CITY,
        maxPages: positiveInteger(process.env.NEWWORLD_MAX_PAGES, 20),
      }),
      retailer: {
        slug: 'newworld',
        name: 'New World',
        website: 'https://www.newworld.co.nz/',
      },
    },
    {
      collector: new FourSquareCollector({
        storeId: process.env.FOURSQUARE_STORE_ID,
        storeQuery: process.env.FOURSQUARE_STORE_QUERY ?? 'Lancaster',
        city: process.env.FOURSQUARE_STORE_CITY,
        maxPages: positiveInteger(process.env.FOURSQUARE_MAX_PAGES, 10),
      }),
      retailer: {
        slug: 'foursquare',
        name: 'Four Square',
        website: 'https://www.foursquare.co.nz/',
      },
    },
    {
      collector: new FreshChoiceCollector({
        storeOrigin: process.env.FRESHCHOICE_STORE_ORIGIN,
        city: process.env.FRESHCHOICE_STORE_CITY,
        address: process.env.FRESHCHOICE_STORE_ADDRESS,
        maxPages: positiveInteger(process.env.FRESHCHOICE_MAX_PAGES, 80),
      }),
      retailer: {
        slug: 'freshchoice',
        name: 'FreshChoice',
        website: 'https://www.freshchoice.co.nz/',
      },
    },
    {
      collector: new SuperValueCollector({
        storeOrigin: process.env.SUPERVALUE_STORE_ORIGIN,
        city: process.env.SUPERVALUE_STORE_CITY,
        address: process.env.SUPERVALUE_STORE_ADDRESS,
        maxPages: positiveInteger(process.env.SUPERVALUE_MAX_PAGES, 60),
      }),
      retailer: {
        slug: 'supervalue',
        name: 'SuperValue',
        website: 'https://www.supervalue.co.nz/',
      },
    },
  ];

  const results: PromiseSettledResult<
    Awaited<ReturnType<typeof collectRetailer>>
  >[] = [];
  const requestedRetailer = new URL(request.url).searchParams.get('retailer');
  const selectedJobs = requestedRetailer
    ? jobs.filter((job) => job.retailer.slug === requestedRetailer)
    : jobs;
  if (!selectedJobs.length)
    return Response.json({ error: 'Unknown retailer.' }, { status: 400 });
  // Keep matching deterministic: later banners see canonical products created
  // by earlier banners in the same weekly run. Each collector has its own retry
  // policy, so one upstream failure is recorded without losing other snapshots.
  for (const job of selectedJobs) {
    try {
      results.push({
        status: 'fulfilled',
        value: await collectRetailer(job.collector, job.retailer, trigger),
      });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      if (!(failure.reason instanceof CollectionAlreadyRunningError)) {
        console.error('Weekly supermarket collection failed', failure.reason);
      }
    }
    return Response.json(
      {
        ok: false,
        error:
          'One or more supermarket collections failed. Check function logs.',
        results: results.map((result) =>
          result.status === 'fulfilled'
            ? result.value
            : {
                ok: false,
                error:
                  result.reason instanceof CollectionAlreadyRunningError
                    ? result.reason.message
                    : 'Collection failed',
              },
        ),
      },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    results: results.map((result) =>
      result.status === 'fulfilled' ? result.value : null,
    ),
  });
}
