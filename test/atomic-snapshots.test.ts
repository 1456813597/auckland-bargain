/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

describe('atomic weekly snapshots in Postgres', () => {
  let db: PGlite;

  before(async () => {
    db = await PGlite.create();
    await db.exec(
      'create role anon; create role authenticated; create role service_role bypassrls;',
    );
    const migrations = (await readdir('supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of migrations) {
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
    }
  });
  after(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      truncate retailers, collection_runs restart identity cascade;
      insert into retailers (slug, name) values ('test', 'Test'), ('other', 'Other');
      insert into stores (retailer_id, source_store_id, name, city)
        values (1, 'north', 'North', 'Auckland'), (1, 'south', 'South', 'Dunedin');
      insert into retailer_products (retailer_id, source_product_id, source_name)
        values (1, 'a', 'Apples'), (1, 'b', 'Bananas'), (2, 'x', 'Foreign product');
    `);
  });

  async function claim(store = 'north') {
    const result = await db.query<{ id: number | null }>(
      "select claim_collection_run('test', $1) as id",
      [store],
    );
    assert.ok(result.rows[0].id);
    return result.rows[0].id;
  }
  function offer(product: number, price: number, date: string) {
    return {
      retailer_product_id: product,
      regular_price_cents: price,
      collected_at: date,
      content_hash: `price-${price}`,
    };
  }
  async function stage(run: number, offers: ReturnType<typeof offer>[]) {
    await db.query('select stage_collection_offers($1, $2::jsonb)', [
      run,
      JSON.stringify(offers),
    ]);
  }
  async function finalize(run: number, count: number) {
    await db.query('select finalize_collection_run($1, $2)', [run, count]);
  }
  async function publish(date: string, price: number, store = 'north') {
    const run = await claim(store);
    await stage(run, [offer(1, price, date)]);
    await finalize(run, 1);
    return run;
  }
  async function prices() {
    return (
      await db.query<{ price: number }>(
        'select regular_price_cents as price from current_offers where active order by store_id, retailer_product_id',
      )
    ).rows.map((row) => row.price);
  }
  async function history(storeId = 1) {
    return (
      await db.query<{ price: number; week: string }>(
        'select effective_price_cents as price, week_start::text as week from offer_history where store_id = $1 order by week_start',
        [storeId],
      )
    ).rows;
  }

  it('executes every migration and exposes the required readiness and permissions', async () => {
    const result = await db.query<{
      ready: { ready: boolean; atomicWeeklySnapshots: boolean };
    }>('select database_readiness() as ready');
    assert.equal(result.rows[0].ready.ready, true);
    assert.equal(result.rows[0].ready.atomicWeeklySnapshots, true);
    const permissions = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('anon', 'stage_collection_offers(bigint,jsonb)', 'execute') as allowed",
    );
    assert.equal(permissions.rows[0].allowed, false);
  });

  it('keeps old prices and history unchanged until all expected batches commit', async () => {
    await publish('2026-08-31T00:00:00Z', 500);
    const run = await claim();
    await stage(run, [offer(1, 300, '2026-09-07T00:00:00Z')]);
    assert.deepEqual(await prices(), [500]);
    await assert.rejects(finalize(run, 2), /Expected 2 offers but staged 1/);
    assert.deepEqual(await prices(), [500]);
    assert.deepEqual(await history(), [{ price: 500, week: '2026-08-31' }]);
    await stage(run, [offer(2, 200, '2026-09-07T00:00:00Z')]);
    await finalize(run, 2);
    assert.deepEqual(await prices(), [300, 200]);
    await finalize(run, 2);
    assert.equal((await history()).length, 3);
  });

  it('retains one previous week through retries and unchanged weekly prices', async () => {
    await publish('2026-08-31T00:00:00Z', 500);
    await publish('2026-09-07T00:00:00Z', 400);
    await publish('2026-09-10T00:00:00Z', 350);
    assert.deepEqual(await history(), [
      { price: 500, week: '2026-08-31' },
      { price: 350, week: '2026-09-07' },
    ]);
    await publish('2026-09-14T00:00:00Z', 350);
    assert.deepEqual(await history(), [
      { price: 350, week: '2026-09-07' },
      { price: 350, week: '2026-09-14' },
    ]);
  });

  it('uses Auckland week boundaries on both sides of daylight saving', async () => {
    await publish('2026-09-06T11:59:59Z', 500);
    await publish('2026-09-06T12:00:00Z', 400);
    assert.deepEqual(
      (await history()).map((row) => row.week),
      ['2026-08-31', '2026-09-07'],
    );
    await publish('2026-09-27T10:59:59Z', 300);
    await publish('2026-09-27T11:00:00Z', 200);
    assert.deepEqual(
      (await history()).map((row) => row.week),
      ['2026-09-21', '2026-09-28'],
    );
  });

  it('clears failed staging and fences failed or expired workers', async () => {
    await publish('2026-08-31T00:00:00Z', 500);
    const failed = await claim();
    await stage(failed, [offer(1, 300, '2026-09-07T00:00:00Z')]);
    await db.query(
      "update collection_runs set status = 'failed' where id = $1",
      [failed],
    );
    assert.equal(
      (await db.query('select * from collection_offer_staging')).rows.length,
      0,
    );
    await assert.rejects(finalize(failed, 1), /active lease/);
    const expired = await claim();
    await stage(expired, [offer(1, 300, '2026-09-07T00:00:00Z')]);
    await db.query(
      "update collection_runs set started_at = now() - interval '16 minutes' where id = $1",
      [expired],
    );
    await claim();
    await assert.rejects(
      stage(expired, [offer(1, 100, '2026-09-07T00:00:00Z')]),
      /active lease/,
    );
    assert.deepEqual(await prices(), [500]);
    assert.equal((await history()).length, 1);
  });

  it('does not record missing-item deactivation as another price observation', async () => {
    await publish('2026-08-31T00:00:00Z', 500);
    const run = await claim();
    await stage(run, [offer(2, 300, '2026-09-07T00:00:00Z')]);
    await finalize(run, 1);
    assert.deepEqual(await prices(), [300]);
    assert.deepEqual(await history(), [
      { price: 500, week: '2026-08-31' },
      { price: 300, week: '2026-09-07' },
    ]);
  });

  it('keeps store histories separate and rejects foreign products or older snapshots', async () => {
    await publish('2026-09-07T00:00:00Z', 500);
    await publish('2026-09-07T00:00:00Z', 800, 'south');
    assert.deepEqual(await prices(), [500, 800]);
    assert.deepEqual(await history(2), [{ price: 800, week: '2026-09-07' }]);
    const run = await claim();
    await assert.rejects(
      stage(run, [offer(3, 300, '2026-09-07T00:00:00Z')]),
      /another retailer/,
    );
    await stage(run, [offer(1, 300, '2026-08-31T00:00:00Z')]);
    await assert.rejects(finalize(run, 1), /older collection/);
    assert.deepEqual(await prices(), [500, 800]);
  });

  it('rejects an older disjoint catalogue that would deactivate newer offers', async () => {
    await publish('2026-09-07T00:00:00Z', 500);
    const run = await claim();
    await stage(run, [offer(2, 300, '2026-08-31T00:00:00Z')]);
    await assert.rejects(finalize(run, 1), /older collection/);
    assert.deepEqual(await prices(), [500]);
  });

  it('rolls back prices, history and deactivation if a late publication step fails', async () => {
    await publish('2026-08-31T00:00:00Z', 500);
    const run = await claim();
    await stage(run, [offer(2, 300, '2026-09-07T00:00:00Z')]);
    await db.exec(`
      create function test_fail_finalization() returns trigger language plpgsql as $$
      begin
        if new.status = 'succeeded' then raise exception 'Injected publication failure'; end if;
        return new;
      end;
      $$;
      create trigger test_fail_finalization before update of status on collection_runs
        for each row execute function test_fail_finalization();
    `);
    try {
      await assert.rejects(finalize(run, 1), /Injected publication failure/);
      assert.deepEqual(await prices(), [500]);
      assert.deepEqual(await history(), [{ price: 500, week: '2026-08-31' }]);
      assert.equal(
        (await db.query('select * from collection_offer_staging')).rows.length,
        1,
      );
    } finally {
      await db.exec(
        'drop trigger test_fail_finalization on collection_runs; drop function test_fail_finalization();',
      );
    }
    await finalize(run, 1);
    assert.deepEqual(await prices(), [300]);
  });
});
