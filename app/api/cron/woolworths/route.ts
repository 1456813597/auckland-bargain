import { isSupabaseConfigured } from '@/db/supabase';
import { WoolworthsCollector } from '@/lib/collectors/woolworths';
import {
  CollectionAlreadyRunningError,
  createCollectionRun,
  ingestOffers,
  markCollectionRunFailed,
} from '@/lib/ingestion/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(
    secret && request.headers.get('authorization') === `Bearer ${secret}`,
  );
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isSupabaseConfigured()) {
    return Response.json(
      { error: 'Supabase is not configured on the server.' },
      { status: 503 },
    );
  }

  const collector = new WoolworthsCollector({
    cookie: process.env.WOOLWORTHS_COOKIE,
    city: process.env.WOOLWORTHS_STORE_CITY ?? 'Auckland',
    maxPages: positiveInteger(process.env.WOOLWORTHS_MAX_PAGES, 60),
    pageSize: positiveInteger(process.env.WOOLWORTHS_PAGE_SIZE, 100),
  });

  let runId: number | undefined;

  try {
    const [store] = await collector.getStores();
    runId = await createCollectionRun(
      collector.retailerSlug,
      store.sourceStoreId,
      {
        trigger:
          request.headers.get('user-agent') === 'vercel-cron/1.0'
            ? 'vercel-cron'
            : 'manual',
      },
    );

    const collection = await collector.collectSpecials(store);
    const persisted = await ingestOffers({
      runId,
      retailer: {
        slug: collector.retailerSlug,
        name: 'Woolworths',
        website: 'https://www.woolworths.co.nz/',
      },
      store: collection.store,
      offers: collection.offers,
    });

    return Response.json({
      ok: true,
      ...persisted,
      store: collection.store,
      pagesCollected: collection.pagesCollected,
      totalItemsReported: collection.totalItemsReported,
      collectedAt: collection.offers[0]?.collectedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof CollectionAlreadyRunningError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: 409 },
      );
    }

    if (runId !== undefined) {
      try {
        await markCollectionRunFailed(runId, error);
      } catch (statusError) {
        console.error('Could not record failed Woolworths run', statusError);
      }
    }
    console.error('Woolworths collection failed', error);
    return Response.json(
      {
        ok: false,
        runId,
        error: 'Woolworths collection failed. Check the Vercel function logs.',
      },
      { status: 500 },
    );
  }
}
