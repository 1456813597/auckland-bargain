/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import {
  processOneCollectionJob,
  syncCollectionTargets,
  parseQueuedCollection,
} from '../lib/collection/queue';
import type { RegisteredStore } from '../lib/collection/store-registry';
import type { CompleteCollection } from '../lib/collectors/types';

const store: RegisteredStore = {
  id: 'test-north',
  retailer: 'freshchoice',
  sourceStoreId: 'north',
  name: 'Test North',
  city: 'Auckland',
  storeOrigin: 'https://north.store.freshchoice.co.nz',
  enabled: true,
  scope: 'catalogue',
  access: { status: 'approved', reference: 'TEST ONLY' },
};
const job = {
  jobId: 1,
  runId: 3,
  attempt: 1,
  weekStart: '2026-09-07',
  configVersion: 1,
  store,
};
function client(
  handler: (name: string, body: Record<string, unknown>) => unknown,
) {
  return createClient('https://queue.test', 'test-only', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url =
          input instanceof Request ? new URL(input.url) : new URL(input);
        assert.equal(typeof init?.body, 'string');
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        return Response.json(
          await handler(url.pathname.split('/').at(-1)!, body),
        );
      },
    },
  });
}
const collection = (): CompleteCollection => ({
  store,
  scope: 'catalogue',
  pagesCollected: 1,
  totalItemsReported: 1,
  offers: [
    {
      sourceProductId: 'milk',
      sourceName: 'Anchor Milk 2L',
      brand: 'Anchor',
      category: 'Dairy',
      size: '2L',
      gtin: null,
      imageUrl: null,
      sourceUrl: 'https://north.store.freshchoice.co.nz/lines/milk',
      regularPriceCents: 500,
      promoPriceCents: null,
      memberPriceCents: null,
      promotionType: null,
      promotionText: null,
      validUntil: null,
      collectedAt: new Date('2026-09-07T00:00:00Z'),
    },
  ],
});

test('queue worker is idle without touching sources when no eligible job exists', async () => {
  const result = await processOneCollectionJob({
    database: client((name) => {
      assert.equal(name, 'claim_collection_job');
      return null;
    }),
    collect: async () => {
      throw new Error('Must not collect');
    },
  });
  assert.deepEqual(result, { status: 'idle' });
});

test('queue worker uses the claimed run and does not send a second success acknowledgement', async () => {
  const requests: string[] = [];
  const result = await processOneCollectionJob({
    database: client((name) => {
      requests.push(name);
      return name === 'claim_collection_job' ? job : true;
    }),
    environment: {},
    collect: async (target) => {
      assert.equal(target.id, store.id);
      return collection();
    },
    ingest: async (input) => {
      assert.equal(input.runId, 3);
      assert.equal(input.retailer.slug, 'freshchoice');
      assert.equal(input.store.sourceStoreId, 'north');
      return {
        runId: 3,
        retailerId: 1,
        storeId: 1,
        offersSeen: 1,
        matchedProducts: 0,
        reviewsQueued: 0,
      };
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(requests, [
    'claim_collection_job',
    'collection_job_access_valid',
  ]);
});

test('revoked access between claim and execution prevents any source request', async () => {
  const result = await processOneCollectionJob({
    database: client((name) =>
      name === 'claim_collection_job'
        ? job
        : name === 'collection_job_access_valid'
          ? false
          : 'retry',
    ),
    collect: async () => {
      throw new Error('Source must not be called');
    },
  });
  assert.equal(result.status, 'retry');
  assert.match('error' in result ? result.error : '', /source access changed/);
});

test('queue worker records source failure and recognizes an already committed result after response loss', async () => {
  for (const outcome of ['retry', 'failed', 'succeeded']) {
    const result = await processOneCollectionJob({
      database: client((name, body) => {
        if (name === 'claim_collection_job') return job;
        if (name === 'collection_job_access_valid') return true;
        assert.equal(name, 'fail_collection_job');
        assert.equal(body.p_job_id, 1);
        assert.equal(body.p_run_id, 3);
        return outcome;
      }),
      collect: async () => collection(),
      ingest: async () => {
        throw new Error('Response connection lost');
      },
    });
    assert.equal(result.status, outcome);
    if (outcome === 'succeeded')
      assert.equal(
        'recoveredCommittedResult' in result && result.recoveredCommittedResult,
        true,
      );
  }
});

test('invalid claims, wrong-store and wrong-week data cannot reach price ingestion', async () => {
  for (const value of [
    { ...job, runId: '3' },
    { ...job, attempt: 4 },
    { ...job, weekStart: '2026-09-08' },
    { ...job, store: { ...store, storeOrigin: 'https://internal.test' } },
  ])
    assert.throws(() => parseQueuedCollection(value));
  for (const bad of [
    { ...collection(), store: { ...store, sourceStoreId: 'wrong' } },
    {
      ...collection(),
      offers: collection().offers.map((offer) => ({
        ...offer,
        collectedAt: new Date('2026-08-31T00:00:00Z'),
      })),
    },
  ]) {
    let persisted = false;
    const result = await processOneCollectionJob({
      database: client((name) =>
        name === 'claim_collection_job'
          ? job
          : name === 'collection_job_access_valid'
            ? true
            : 'retry',
      ),
      collect: async () => bad,
      ingest: async () => {
        persisted = true;
        throw new Error('Must not persist');
      },
    });
    assert.equal(result.status, 'retry');
    assert.equal(persisted, false);
  }
});

test('registry sync validates before writing, batches by 250 and only upserts explicit targets', async () => {
  const batches: number[] = [];
  const database = createClient('https://queue.test', 'test-only', {
    global: {
      fetch: async (input, init) => {
        const url =
          input instanceof Request ? new URL(input.url) : new URL(input);
        assert.equal(url.pathname, '/rest/v1/collection_targets');
        assert.equal(url.searchParams.get('on_conflict'), 'id');
        assert.equal(init?.method, 'POST');
        assert.equal(typeof init.body, 'string');
        const rows = JSON.parse(init.body as string) as Array<
          Record<string, unknown>
        >;
        batches.push(rows.length);
        assert.equal(rows[0].cookie_env, null);
        assert.equal(rows[0].access_reference, 'TEST ONLY');
        assert.equal(rows[0].config_version, undefined);
        return new Response(null, { status: 201 });
      },
    },
  });
  const stores = Array.from({ length: 501 }, (_, index) => ({
    ...store,
    id: `test-${index}`,
    sourceStoreId: `source-${index}`,
    storeOrigin: `https://store-${index}.store.freshchoice.co.nz`,
  }));
  assert.equal(
    (await syncCollectionTargets({ schemaVersion: 1, stores }, database))
      .synced,
    501,
  );
  assert.deepEqual(batches, [250, 250, 1]);
  await assert.rejects(
    syncCollectionTargets(
      {
        schemaVersion: 1,
        stores: [...stores, { ...store, cookieEnv: 'secret' }],
      },
      database,
    ),
    /Cookie configuration/,
  );
  assert.deepEqual(batches, [250, 250, 1]);
});
