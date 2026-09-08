/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseStoreRegistry } from '../lib/collection/store-registry';
import { nzWeekStart } from '../lib/weekly-history';

type Claim = {
  jobId: number;
  runId: number;
  attempt: number;
  weekStart: string;
  configVersion: number;
  store: { id: string };
};
describe('durable store collection queue in Postgres', () => {
  let db: PGlite;
  let observedAt: string;
  before(async () => {
    db = await PGlite.create();
    await db.exec(
      'create role anon; create role authenticated; create role service_role bypassrls;',
    );
    for (const file of (await readdir('supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  });
  after(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      truncate retailers, collection_runs, collection_targets restart identity cascade;
      insert into retailers (slug, name) values ('freshchoice', 'FreshChoice');
      insert into stores (retailer_id, source_store_id, name, city) values (1, 'north', 'North', 'Auckland'), (1, 'south', 'South', 'Dunedin');
      insert into retailer_products (retailer_id, source_product_id, source_name) values (1, 'a', 'Apples'), (1, 'b', 'Bananas');
      insert into collection_targets (id, retailer_slug, source_store_id, name, city, store_origin, scope, enabled, access_status, access_reference)
      values ('north', 'freshchoice', 'north', 'North', 'Auckland', 'https://north.store.freshchoice.co.nz', 'catalogue', true, 'approved', 'TEST ONLY'),
             ('south', 'freshchoice', 'south', 'South', 'Dunedin', 'https://south.store.freshchoice.co.nz', 'catalogue', true, 'approved', 'TEST ONLY');
    `);
    observedAt = (
      await db.query<{ at: Date }>('select now() as at')
    ).rows[0].at.toISOString();
  });
  async function enqueue() {
    return (
      await db.query<{ result: { inserted: number; weekStart: string } }>(
        'select enqueue_weekly_collection_jobs() as result',
      )
    ).rows[0].result;
  }
  async function claim() {
    return (
      await db.query<{ result: Claim | null }>(
        'select claim_collection_job() as result',
      )
    ).rows[0].result;
  }
  async function northOnly() {
    await db.exec(
      "update collection_targets set enabled = false where id = 'south'",
    );
    await enqueue();
    const result = await claim();
    assert.ok(result);
    assert.equal(result.store.id, 'north');
    return result;
  }
  async function fail(job: Claim) {
    return (
      await db.query<{ status: string }>(
        'select fail_collection_job($1, $2, $3) as status',
        [job.jobId, job.runId, 'Test upstream failure'],
      )
    ).rows[0].status;
  }
  async function stage(job: Claim, date = observedAt) {
    await db.query('select stage_collection_offers($1, $2::jsonb)', [
      job.runId,
      JSON.stringify([
        {
          retailer_product_id: 1,
          regular_price_cents: 300,
          collected_at: date,
          content_hash: 'price-300',
        },
      ]),
    ]);
  }
  async function finalize(job: Claim) {
    await db.query('select finalize_collection_run($1, 1)', [job.runId]);
  }
  async function row(job: Claim) {
    return (
      await db.query<{
        status: string;
        attempts: number;
        current_run_id: number;
      }>(
        'select status, attempts, current_run_id from collection_jobs where id = $1',
        [job.jobId],
      )
    ).rows[0];
  }
  async function permitRetry() {
    await db.exec(
      "update collection_jobs set available_at = now() - interval '1 second' where status = 'retry'",
    );
  }

  it('installs restricted tables/RPCs and the queue readiness requirement', async () => {
    const ready = (
      await db.query<{
        result: { durableCollectionQueue: boolean; schemaVersion: string };
      }>('select database_readiness() as result')
    ).rows[0].result;
    assert.equal(ready.durableCollectionQueue, true);
    assert.equal(ready.schemaVersion, '20260909120000');
    for (const role of ['anon', 'authenticated']) {
      for (const signature of [
        'enqueue_weekly_collection_jobs(text)',
        'claim_collection_job(text)',
        'fail_collection_job(bigint,bigint,text)',
        'collection_queue_status()',
      ])
        assert.equal(
          (
            await db.query<{ allowed: boolean }>(
              'select has_function_privilege($1, $2, $3) as allowed',
              [role, signature, 'execute'],
            )
          ).rows[0].allowed,
          false,
        );
      assert.equal(
        (
          await db.query<{ allowed: boolean }>(
            'select has_table_privilege($1, $2, $3) as allowed',
            [role, 'collection_targets', 'select'],
          )
        ).rows[0].allowed,
        false,
      );
    }
    await db.exec('set role service_role');
    try {
      assert.equal((await enqueue()).inserted, 2);
    } finally {
      await db.exec('reset role');
    }
  });

  it('enqueues once per NZ week and claims separate stores without repeating a live lease', async () => {
    const first = await enqueue();
    assert.equal(first.inserted, 2);
    assert.equal(first.weekStart, nzWeekStart(observedAt));
    assert.equal((await enqueue()).inserted, 0);
    const one = await claim();
    const two = await claim();
    assert.ok(one && two);
    assert.notEqual(one.jobId, two.jobId);
    assert.notEqual(one.runId, two.runId);
    assert.equal(one.attempt, 1);
    assert.equal(await claim(), null);
    assert.equal(
      parseStoreRegistry({ schemaVersion: 1, stores: [one.store] }).stores
        .length,
      1,
    );
  });

  it('does not enqueue pending/expired/disabled/unsupported targets or accept empty permission references', async () => {
    await db.exec(
      "update collection_targets set access_status = 'pending' where id = 'north'; update collection_targets set access_expires_at = now() - interval '1 second' where id = 'south'",
    );
    assert.equal((await enqueue()).inserted, 0);
    assert.equal(await claim(), null);
    await assert.rejects(
      db.exec(
        "update collection_targets set access_status = 'approved', access_reference = null where id = 'north'",
      ),
      /check constraint/,
    );
    await db.exec(
      "update collection_targets set enabled = false where id = 'north'",
    );
    await db.exec(
      "insert into collection_targets (id, retailer_slug, source_store_id, name, city, scope, enabled, access_status, access_reference) values ('pns', 'paknsave', 'pns', 'PAK Test', 'Auckland', 'catalogue', true, 'approved', 'TEST ONLY')",
    );
    assert.equal((await enqueue()).inserted, 0);
    const status = (
      await db.query<{
        result: {
          targets: Record<string, number>;
          jobs: Record<string, number>;
        };
      }>('select collection_queue_status() as result')
    ).rows[0].result;
    assert.deepEqual(status.targets, {
      disabled: 1,
      'access-expired': 1,
      'catalogue-unsupported': 1,
    });
    assert.deepEqual(status.jobs, {});
  });

  it('retries with a backoff and stops after three unsuccessful attempts', async () => {
    let job = await northOnly();
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(job.attempt, attempt);
      assert.equal(await fail(job), attempt === 3 ? 'failed' : 'retry');
      assert.equal(await claim(), null);
      if (attempt < 3) {
        const minutes = (
          await db.query<{ minutes: number }>(
            'select extract(epoch from (available_at - now())) / 60 as minutes from collection_jobs where id = $1',
            [job.jobId],
          )
        ).rows[0].minutes;
        assert.ok(Number(minutes) >= 5 * 2 ** (attempt - 1) - 0.1);
        await permitRetry();
        const retry = await claim();
        assert.ok(retry);
        assert.equal(retry.jobId, job.jobId);
        assert.notEqual(retry.runId, job.runId);
        job = retry;
      }
    }
    assert.equal((await enqueue()).inserted, 0);
    assert.equal((await row(job)).attempts, 3);
  });

  it('recovers expired workers, discards partial staging and fences late callbacks from an older attempt', async () => {
    const expired = await northOnly();
    await stage(expired);
    await db.query(
      "update collection_runs set started_at = now() - interval '16 minutes' where id = $1",
      [expired.runId],
    );
    assert.equal(await claim(), null);
    assert.equal((await row(expired)).status, 'retry');
    assert.equal(
      (await db.query('select * from collection_offer_staging')).rows.length,
      0,
    );
    await assert.rejects(finalize(expired), /active lease/);
    await permitRetry();
    const next = await claim();
    assert.ok(next);
    await assert.rejects(fail(expired), /no longer current/);
    assert.equal((await row(next)).current_run_id, next.runId);
    assert.equal((await row(next)).status, 'running');
  });

  it('completes the job in the same transaction as prices and survives lost success responses', async () => {
    const job = await northOnly();
    await stage(job);
    assert.equal((await row(job)).status, 'running');
    assert.equal(
      (await db.query('select * from current_offers')).rows.length,
      0,
    );
    await finalize(job);
    assert.equal((await row(job)).status, 'succeeded');
    assert.equal(
      (await db.query('select * from offer_history')).rows.length,
      1,
    );
    assert.equal(await fail(job), 'succeeded');
    assert.equal(
      (
        await db.query<{ status: string }>(
          'select status from collection_runs where id = $1',
          [job.runId],
        )
      ).rows[0].status,
      'succeeded',
    );
    await finalize(job);
    assert.equal((await enqueue()).inserted, 0);
    assert.equal(await claim(), null);
  });

  for (const [label, change] of [
    ['revoked permission', "access_status = 'denied'"],
    ['expired permission', "access_expires_at = now() - interval '1 second'"],
    ['changed configuration', "city = 'Different City'"],
    ['disabled store', 'enabled = false'],
  ])
    it(`rolls back prices and job completion after ${label}`, async () => {
      const job = await northOnly();
      await stage(job);
      await db.exec(
        `update collection_targets set ${change} where id = 'north'`,
      );
      await assert.rejects(finalize(job), /configuration or source access/);
      assert.equal(
        (await db.query('select * from current_offers')).rows.length,
        0,
      );
      assert.equal(
        (await db.query('select * from offer_history')).rows.length,
        0,
      );
      assert.equal((await row(job)).status, 'running');
      assert.equal(await fail(job), 'retry');
    });

  it('rejects observations from a different week and cancels obsolete queued work', async () => {
    const job = await northOnly();
    const previousWeek = new Date(observedAt);
    previousWeek.setUTCDate(previousWeek.getUTCDate() - 7);
    await stage(job, previousWeek.toISOString());
    await assert.rejects(finalize(job), /different NZ week/);
    await fail(job);
    await db.exec(
      "update collection_jobs set week_start = week_start - 7 where status = 'retry'",
    );
    assert.equal((await enqueue()).inserted, 1);
    assert.equal((await row(job)).status, 'cancelled');
    const next = await claim();
    assert.ok(next);
    assert.notEqual(next.jobId, job.jobId);
    assert.equal(next.attempt, 1);
  });

  it('rejects full-catalogue downgrades and preserves versions on identical registry syncs', async () => {
    const job = await northOnly();
    await db.exec(
      "update collection_targets set name = name, config_version = 99 where id = 'north'",
    );
    assert.equal(
      (
        await db.query<{ version: number }>(
          "select config_version as version from collection_targets where id = 'north'",
        )
      ).rows[0].version,
      job.configVersion,
    );
    await stage(job);
    await finalize(job);
    await db.exec(
      "update collection_targets set scope = 'specials' where id = 'north'",
    );
    assert.equal((await enqueue()).inserted, 0);
    assert.equal(await claim(), null);
    const status = (
      await db.query<{ result: { targets: Record<string, number> } }>(
        'select collection_queue_status() as result',
      )
    ).rows[0].result;
    assert.equal(status.targets['scope-downgrade'], 1);
    await assert.rejects(
      db.exec(
        "update collection_targets set source_store_id = 'wrong' where id = 'north'",
      ),
      /identity is immutable/,
    );
  });
});
