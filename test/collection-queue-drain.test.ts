/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionDrainDefaults,
  drainCollectionQueue,
  parseDrainLimit,
  type CollectionJobOutcome,
  type QueueDatabase,
} from '../lib/collection/queue';

type RpcHandler = (
  name: string,
  parameters: Record<string, unknown>,
) => unknown;

function database(handler: RpcHandler, calls: string[] = []): QueueDatabase {
  return {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push(name);
      return { data: handler(name, parameters), error: null };
    },
  } as unknown as QueueDatabase;
}

const queueRpc: RpcHandler = (name) =>
  name === 'enqueue_weekly_collection_jobs'
    ? { weekStart: '2026-09-07', inserted: 2 }
    : { weekStart: '2026-09-07', jobs: {} };

function succeeded(jobId: number): CollectionJobOutcome {
  return {
    jobId,
    runId: jobId,
    targetId: `store-${jobId}`,
    attempt: 1,
    status: 'succeeded',
    offers: 10,
  };
}

test('one invocation claims at most its job limit and reports the remaining queue', async () => {
  const started: number[] = [];
  const result = await drainCollectionQueue({
    database: database(queueRpc),
    limit: 2,
    process: async () => {
      started.push(started.length);
      return succeeded(started.length);
    },
  });
  assert.equal(started.length, 2);
  assert.equal(result.stoppedBy, 'limit');
  assert.equal(result.ok, true);
  assert.deepEqual(result.enqueued, { weekStart: '2026-09-07', inserted: 2 });
  assert.deepEqual(result.queue, { weekStart: '2026-09-07', jobs: {} });
});

test('the claim deadline stops before starting a job the platform cannot finish', async () => {
  let clock = 0;
  let claims = 0;
  const result = await drainCollectionQueue({
    database: database(queueRpc),
    limit: 5,
    claimDeadlineMs: 100,
    now: () => clock,
    process: async () => {
      claims++;
      clock += 60;
      return succeeded(claims);
    },
  });
  // Two jobs fit inside the deadline; the third is left queued rather than
  // claimed and killed mid-collection when the function times out.
  assert.equal(claims, 2);
  assert.equal(result.stoppedBy, 'deadline');
  assert.equal(result.ok, true);
});

test('an empty queue idles without requesting a supermarket', async () => {
  const result = await drainCollectionQueue({
    database: database(queueRpc),
    process: async () => ({ status: 'idle' as const }),
  });
  assert.equal(result.stoppedBy, 'idle');
  assert.deepEqual(result.processed, []);
  assert.equal(result.ok, true);
});

test('a retried or failed job marks the invocation unsuccessful without hiding it', async () => {
  for (const status of ['retry', 'failed', 'cancelled'] as const) {
    const result = await drainCollectionQueue({
      database: database(queueRpc),
      limit: 1,
      process: async () => ({
        jobId: 1,
        runId: 1,
        targetId: 'store-1',
        attempt: 1,
        status,
        error: 'upstream refused',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.processed.length, 1);
    assert.equal(result.processed[0].status, status);
  }
});

test('a queue protocol failure stops the loop and keeps the committed outcomes', async () => {
  const calls: string[] = [];
  let attempts = 0;
  const result = await drainCollectionQueue({
    database: database(queueRpc, calls),
    limit: 5,
    process: async () => {
      attempts++;
      if (attempts > 1) throw new Error('Queue returned an invalid claim.');
      return succeeded(1);
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.stoppedBy, 'error');
  assert.equal(result.ok, false);
  assert.equal(result.processed.length, 1);
  assert.match(String(result.error ?? ''), /invalid claim/);
  // Status is still reported so an operator can see what is left behind.
  assert.deepEqual(calls, [
    'enqueue_weekly_collection_jobs',
    'collection_queue_status',
  ]);
});

test('an unreadable queue status never discards a successful collection', async () => {
  const result = await drainCollectionQueue({
    database: database((name) => {
      if (name === 'collection_queue_status')
        throw new Error('status unavailable');
      return { weekStart: '2026-09-07', inserted: 0 };
    }),
    limit: 1,
    process: async () => succeeded(1),
  });
  assert.equal(result.ok, true);
  assert.equal(result.processed.length, 1);
  assert.deepEqual(result.queue, { error: 'status unavailable' });
});

test('drain limits are bounded and reject unusable values', () => {
  assert.equal(parseDrainLimit(null), collectionDrainDefaults.limit);
  assert.equal(parseDrainLimit('1'), 1);
  assert.equal(
    parseDrainLimit(String(collectionDrainDefaults.maxLimit)),
    collectionDrainDefaults.maxLimit,
  );
  for (const value of [
    '0',
    '-1',
    'all',
    '',
    '2.5',
    String(collectionDrainDefaults.maxLimit + 1),
  ])
    assert.throws(() => parseDrainLimit(value));
});
