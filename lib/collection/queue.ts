import { getDatabase, type Database } from '../../db/client';
import { ingestOffers } from '../ingestion/database';
import { nzWeekStart } from '../weekly-history';
import {
  collectRegisteredStore,
  assertRegisteredCollection,
} from './registered-collector';
import {
  parseStoreRegistry,
  retailerDefinitions,
  type RegisteredRetailer,
  type RegisteredStore,
  type StoreRegistry,
} from './store-registry';

export type QueueDatabase = Pick<Database, 'rpc'>;
export type QueuedCollection = {
  jobId: number;
  runId: number;
  attempt: number;
  weekStart: string;
  configVersion: number;
  store: RegisteredStore;
};

function positiveId(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Queue returned an invalid ${name}.`);
  return value;
}

export function parseQueuedCollection(value: unknown): QueuedCollection {
  if (!value || typeof value !== 'object')
    throw new Error('Queue returned an invalid claim.');
  const claim = value as Record<string, unknown>;
  const [store] = parseStoreRegistry({
    schemaVersion: 1,
    stores: [claim.store],
  }).stores;
  if (
    typeof claim.weekStart !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(claim.weekStart) ||
    nzWeekStart(`${claim.weekStart}T12:00:00Z`) !== claim.weekStart
  )
    throw new Error('Queue returned an invalid NZ week.');
  const attempt = positiveId(claim.attempt, 'attempt');
  if (attempt > 3) throw new Error('Queue returned too many attempts.');
  return {
    jobId: positiveId(claim.jobId, 'job id'),
    runId: positiveId(claim.runId, 'run id'),
    configVersion: positiveId(claim.configVersion, 'configuration version'),
    attempt,
    weekStart: claim.weekStart,
    store,
  };
}

async function rpc(
  database: QueueDatabase,
  name: string,
  parameters: Record<string, unknown> = {},
): Promise<unknown> {
  const { data, error } = await database.rpc(name, parameters);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

export async function syncCollectionTargets(
  registry: StoreRegistry,
  database: Pick<Database, 'from'> = getDatabase(),
) {
  // Validate the entire input before the first write. This is an upsert, not a
  // deletion/replacement of targets managed outside this manifest.
  const targets = parseStoreRegistry(registry).stores.map((store) => ({
    id: store.id,
    retailer_slug: store.retailer,
    source_store_id: store.sourceStoreId,
    name: store.name,
    city: store.city,
    address: store.address ?? null,
    store_origin: store.storeOrigin ?? null,
    cookie_env: store.cookieEnv ?? null,
    scope: store.scope,
    enabled: store.enabled,
    access_status: store.access.status,
    access_reference: store.access.reference ?? null,
    access_expires_at: store.access.expiresAt ?? null,
  }));
  for (let offset = 0; offset < targets.length; offset += 250) {
    const { error } = await database
      .from('collection_targets')
      .upsert(targets.slice(offset, offset + 250), { onConflict: 'id' });
    if (error)
      throw new Error(
        `Sync collection targets: ${error.message}. Previous successful batches may already be applied; rerunning is safe.`,
      );
  }
  return { synced: targets.length };
}

export async function enqueueWeeklyCollections(
  database: QueueDatabase = getDatabase(),
  retailer?: RegisteredRetailer,
) {
  return rpc(database, 'enqueue_weekly_collection_jobs', {
    p_retailer_slug: retailer ?? null,
  });
}

export async function getCollectionQueueStatus(
  database: QueueDatabase = getDatabase(),
) {
  return rpc(database, 'collection_queue_status');
}

const websites: Record<RegisteredRetailer, string> = {
  woolworths: 'https://www.woolworths.co.nz/',
  paknsave: 'https://www.paknsave.co.nz/',
  newworld: 'https://www.newworld.co.nz/',
  foursquare: 'https://www.foursquare.co.nz/',
  freshchoice: 'https://www.freshchoice.co.nz/',
  supervalue: 'https://www.supervalue.co.nz/',
};

export async function processOneCollectionJob(
  options: {
    database?: QueueDatabase;
    environment?: Record<string, string | undefined>;
    retailer?: RegisteredRetailer;
    collect?: typeof collectRegisteredStore;
    ingest?: typeof ingestOffers;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const raw = await rpc(database, 'claim_collection_job', {
    p_retailer_slug: options.retailer ?? null,
  });
  if (raw === null) return { status: 'idle' as const };
  // An invalid database claim is never sent to an upstream source. If its
  // identity cannot be safely decoded, the lease reaper recovers the job.
  const job = parseQueuedCollection(raw);
  const identity = {
    jobId: job.jobId,
    runId: job.runId,
    targetId: job.store.id,
    attempt: job.attempt,
  };
  try {
    const valid = await rpc(database, 'collection_job_access_valid', {
      p_job_id: job.jobId,
      p_run_id: job.runId,
    });
    if (valid !== true)
      throw new Error(
        'Job lease, target configuration or source access changed before execution.',
      );
    const collection = await (options.collect ?? collectRegisteredStore)(
      job.store,
      { environment: options.environment ?? process.env },
    );
    assertRegisteredCollection(job.store, collection);
    if (
      collection.offers.some(
        (offer) => nzWeekStart(offer.collectedAt) !== job.weekStart,
      )
    )
      throw new Error('Collected observations belong to another NZ week.');
    await (options.ingest ?? ingestOffers)({
      runId: job.runId,
      retailer: {
        slug: job.store.retailer,
        name: retailerDefinitions[job.store.retailer].name,
        website: websites[job.store.retailer],
      },
      store: collection.store,
      offers: collection.offers,
    });
    // The DB outcome trigger commits job success with the prices; there is no
    // second "ack" request that could lose a completed job after a crash.
    return {
      ...identity,
      status: 'succeeded' as const,
      offers: collection.offers.length,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Collection failed';
    const status = await rpc(database, 'fail_collection_job', {
      p_job_id: job.jobId,
      p_run_id: job.runId,
      p_error: message.slice(0, 2000),
    });
    if (status === 'succeeded')
      return {
        ...identity,
        status: 'succeeded' as const,
        recoveredCommittedResult: true,
      };
    if (status !== 'retry' && status !== 'failed' && status !== 'cancelled')
      throw new Error('Queue returned an invalid failure outcome.');
    return { ...identity, status, error: message };
  }
}

export type CollectionJobOutcome = Awaited<
  ReturnType<typeof processOneCollectionJob>
>;

// One scheduled invocation must not try to collect a national registry: it is
// bounded by both a job count and a claim deadline that leaves the platform's
// remaining time to the job already in flight. Anything still queued, plus any
// job killed mid-flight, is picked up by the next invocation once the database
// lease reaper releases it.
export const collectionDrainDefaults = {
  limit: 3,
  maxLimit: 10,
  claimDeadlineMs: 120_000,
} as const;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
) {
  if (value === undefined || value === '') return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

// A container this project runs itself has no serverless time limit, so the
// bounds that used to be dictated by the platform are configuration.
export function drainSettings(
  environment: Record<string, string | undefined> = process.env,
) {
  const maxLimit = boundedInteger(
    environment.COLLECTION_JOB_MAX_LIMIT,
    collectionDrainDefaults.maxLimit,
    'COLLECTION_JOB_MAX_LIMIT',
    1_000,
  );
  return {
    maxLimit,
    limit: boundedInteger(
      environment.COLLECTION_JOB_LIMIT,
      Math.min(collectionDrainDefaults.limit, maxLimit),
      'COLLECTION_JOB_LIMIT',
      maxLimit,
    ),
    claimDeadlineMs: boundedInteger(
      environment.COLLECTION_CLAIM_DEADLINE_MS,
      collectionDrainDefaults.claimDeadlineMs,
      'COLLECTION_CLAIM_DEADLINE_MS',
      86_400_000,
    ),
  };
}

export function parseDrainLimit(
  value: string | null,
  settings = drainSettings(),
) {
  if (value === null) return settings.limit;
  // Reject anything that is not exactly an integer rather than silently
  // reinterpreting "2.5" or "3 stores" as a different amount of collection.
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > settings.maxLimit)
    throw new Error(`Limit must be between 1 and ${settings.maxLimit}.`);
  return parsed;
}

export async function drainCollectionQueue(
  options: {
    database?: QueueDatabase;
    environment?: Record<string, string | undefined>;
    retailer?: RegisteredRetailer;
    limit?: number;
    claimDeadlineMs?: number;
    now?: () => number;
    process?: typeof processOneCollectionJob;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const settings = drainSettings(options.environment);
  const limit = options.limit ?? settings.limit;
  const claimDeadlineMs = options.claimDeadlineMs ?? settings.claimDeadlineMs;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const runJob = options.process ?? processOneCollectionJob;
  // Enqueueing is idempotent per store, scope and NZ week, so repeated
  // invocations through the week only add newly eligible stores.
  const enqueued = await enqueueWeeklyCollections(database, options.retailer);
  const processed: CollectionJobOutcome[] = [];
  let stoppedBy: 'limit' | 'deadline' | 'idle' | 'error' = 'limit';
  let error: string | undefined;
  while (processed.length < limit) {
    if (now() - startedAt >= claimDeadlineMs) {
      stoppedBy = 'deadline';
      break;
    }
    let outcome: CollectionJobOutcome;
    try {
      outcome = await runJob({
        database,
        environment: options.environment,
        retailer: options.retailer,
      });
    } catch (cause) {
      // A queue protocol failure stops this invocation instead of spinning, and
      // never discards the outcomes already committed by earlier jobs.
      stoppedBy = 'error';
      error = cause instanceof Error ? cause.message : 'Queue request failed.';
      break;
    }
    if (outcome.status === 'idle') {
      stoppedBy = 'idle';
      break;
    }
    processed.push(outcome);
  }
  let queue: unknown;
  try {
    queue = await getCollectionQueueStatus(database);
  } catch (cause) {
    queue = {
      error: cause instanceof Error ? cause.message : 'Queue status failed.',
    };
  }
  return {
    ok:
      error === undefined &&
      processed.every((outcome) => outcome.status === 'succeeded'),
    enqueued,
    processed,
    stoppedBy,
    queue,
    ...(error ? { error } : {}),
  };
}
