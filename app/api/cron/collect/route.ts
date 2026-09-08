import { isDatabaseConfigured } from '@/db/client';
import {
  drainCollectionQueue,
  drainSettings,
  parseDrainLimit,
} from '@/lib/collection/queue';
import {
  retailerDefinitions,
  type RegisteredRetailer,
} from '@/lib/collection/store-registry';
import { isAuthorizedCronRequest } from '@/lib/http/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Registry-driven weekly collection. Unlike the per-banner routes, the stores
// here come from `collection_targets`, so a store only runs while its recorded
// source permission is approved and unexpired. Schedule this often enough that
// backed-off retries still land inside the same NZ week; an invocation with
// nothing eligible costs three database calls and requests no supermarket.
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json(
      { error: 'Supabase is not configured on the server.' },
      { status: 503 },
    );
  }

  const parameters = new URL(request.url).searchParams;
  const requestedRetailer = parameters.get('retailer');
  if (
    requestedRetailer !== null &&
    !Object.hasOwn(retailerDefinitions, requestedRetailer)
  )
    return Response.json({ error: 'Unknown retailer.' }, { status: 400 });
  let limit: number;
  try {
    limit = parseDrainLimit(parameters.get('limit'), drainSettings());
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Invalid limit.',
      },
      { status: 400 },
    );
  }

  const result = await drainCollectionQueue({
    limit,
    retailer: (requestedRetailer as RegisteredRetailer | null) ?? undefined,
  });
  if (!result.ok) {
    console.error('Weekly queue collection did not fully succeed', {
      stoppedBy: result.stoppedBy,
      error: 'error' in result ? result.error : undefined,
    });
    return Response.json(result, { status: 500 });
  }
  return Response.json(result);
}
