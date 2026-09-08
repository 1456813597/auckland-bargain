/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../db/client';
import { PostgresRestClient, type SqlExecutor } from '../db/postgres/rest';

// Every call shape the application makes through the Supabase client, answered
// by the direct-Postgres driver against the real migrated schema. This is what
// makes "Supabase or a Postgres you installed yourself" a supported choice
// rather than a hope.
describe('the direct Postgres driver', () => {
  let pglite: PGlite;
  let database: Database;

  before(async () => {
    pglite = await PGlite.create();
    await pglite.exec(
      'create role anon; create role authenticated; create role service_role bypassrls;',
    );
    for (const file of (await readdir('supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await pglite.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
    database = new PostgresRestClient(
      pglite as unknown as SqlExecutor,
    ) as unknown as Database;
  });

  after(async () => {
    await pglite?.close();
  });

  beforeEach(async () => {
    await pglite.exec(`
      truncate retailers, canonical_products, collection_runs restart identity cascade;
      insert into retailers (slug, name, website)
      values ('paknsave', 'PAK''nSAVE', 'https://www.paknsave.co.nz/'),
             ('newworld', 'New World', 'https://www.newworld.co.nz/');
      insert into stores (retailer_id, source_store_id, name, city)
      values (1, 'royal-oak', 'Royal Oak', 'Auckland');
      insert into retailer_products (retailer_id, source_product_id, source_name, brand)
      values (1, 'p-1', 'Anchor Butter 500g', 'Anchor'),
             (2, 'p-2', 'Anchor Butter 500g', 'Anchor');
      insert into canonical_products
        (slug, display_name, normalized_name, brand, normalized_brand, matching_measure, matching_tokens)
      values ('anchor-butter-500g', 'Anchor Butter 500g', 'anchor butter', 'Anchor', 'anchor', 'mass:500:1', array['anchor', 'butter']),
             ('mainland-cheese-1kg', 'Mainland Cheese 1kg', 'mainland cheese', 'Mainland', 'mainland', 'mass:1000:1', array['mainland', 'cheese']);
    `);
  });

  it('filters, orders and limits a select', async () => {
    const { data, error } = await database
      .from('canonical_products')
      .select('id,slug')
      .gt('id', 0)
      .order('id', { ascending: false })
      .limit(1);

    assert.equal(error, null);
    assert.deepEqual(data, [{ id: 2, slug: 'mainland-cheese-1kg' }]);
  });

  it('reads a single row and reports when there is not exactly one', async () => {
    const found = await database
      .from('retailers')
      .select('id')
      .eq('slug', 'paknsave')
      .single();
    assert.deepEqual(found, { data: { id: 1 }, error: null });

    const missing = await database
      .from('retailers')
      .select('id')
      .eq('slug', 'nowhere')
      .single();
    assert.equal(missing.data, null);
    assert.match(missing.error?.message ?? '', /multiple \(or no\) rows/);
  });

  it('matches in() and overlaps(), including on empty input', async () => {
    const byBrand = await database
      .from('canonical_products')
      .select('slug')
      .in('normalized_brand', ['anchor', 'nothing']);
    assert.deepEqual(byBrand.data, [{ slug: 'anchor-butter-500g' }]);

    const byToken = await database
      .from('canonical_products')
      .select('slug')
      .overlaps('matching_tokens', ['cheese', 'unused']);
    assert.deepEqual(byToken.data, [{ slug: 'mainland-cheese-1kg' }]);

    const empty = await database
      .from('canonical_products')
      .select('slug')
      .in('normalized_brand', []);
    assert.deepEqual([empty.data, empty.error], [[], null]);
  });

  it('filters through an embedded relationship', async () => {
    await pglite.exec(`
      insert into product_matches
        (retailer_product_id, canonical_product_id, match_method, confidence)
      values (1, 1, 'attributes', 0.9), (2, 1, 'attributes', 0.9);
    `);

    const { data, error } = await database
      .from('product_matches')
      .select('canonical_product_id,retailer_products!inner(retailer_id)')
      .eq('status', 'accepted')
      .eq('retailer_products.retailer_id', 2)
      .in('canonical_product_id', [1, 2]);

    assert.equal(error, null);
    assert.deepEqual(data, [
      { canonical_product_id: 1, retailer_products: { retailer_id: 2 } },
    ]);
  });

  it('upserts, returns the affected rows and updates on conflict', async () => {
    const inserted = await database
      .from('retailers')
      .upsert(
        {
          slug: 'foursquare',
          name: 'Four Square',
          website: 'https://www.foursquare.co.nz/',
        },
        { onConflict: 'slug' },
      )
      .select('id')
      .single();
    assert.equal(inserted.error, null);
    assert.ok(Number(inserted.data?.id) > 0);

    const updated = await database
      .from('retailers')
      .upsert(
        {
          slug: 'foursquare',
          name: 'Four Square NZ',
          website: 'https://www.foursquare.co.nz/',
        },
        { onConflict: 'slug' },
      )
      .select('id,name')
      .single();
    assert.equal(updated.data?.id, inserted.data?.id);
    assert.equal(updated.data?.name, 'Four Square NZ');
  });

  it('leaves a conflicting row alone when duplicates are ignored', async () => {
    const { error } = await database.from('canonical_products').upsert(
      [
        {
          slug: 'anchor-butter-500g',
          display_name: 'Replaced',
          normalized_name: 'replaced',
        },
      ],
      { onConflict: 'slug', ignoreDuplicates: true },
    );
    assert.equal(error, null);

    const { data } = await database
      .from('canonical_products')
      .select('display_name')
      .eq('slug', 'anchor-butter-500g');
    assert.deepEqual(data, [{ display_name: 'Anchor Butter 500g' }]);
  });

  it('updates only the rows its filters select', async () => {
    const runId = Number(
      (
        await database.rpc('claim_collection_run', {
          p_retailer_slug: 'paknsave',
          p_store_source_id: 'royal-oak',
          p_metadata: { trigger: 'scheduler' },
        })
      ).data,
    );
    assert.ok(runId > 0);

    const { error } = await database
      .from('collection_runs')
      .update({
        status: 'failed',
        finished_at: new Date('2026-09-09T00:00:00.000Z').toISOString(),
        error_message: 'upstream refused',
      })
      .eq('id', runId)
      .eq('status', 'running');
    assert.equal(error, null);

    const { rows } = await pglite.query<{
      status: string;
      error_message: string;
    }>('select status, error_message from collection_runs where id = $1', [
      runId,
    ]);
    assert.deepEqual(rows, [
      { status: 'failed', error_message: 'upstream refused' },
    ]);
  });

  it('calls functions by name with their declared argument types', async () => {
    const readiness = await database.rpc('database_readiness');
    assert.equal(readiness.error, null);
    assert.equal(
      (readiness.data as { schemaVersion: string }).schemaVersion,
      '20260909120000',
    );

    const usage = await database.rpc('product_image_store_bytes');
    assert.equal(Number(usage.data), 0);

    const claimed = await database.rpc('claim_collection_run', {
      p_retailer_slug: 'paknsave',
      p_store_source_id: 'royal-oak',
      p_metadata: { trigger: 'manual', group: 'weekly-supermarkets' },
    });
    const runId = Number(claimed.data);
    assert.ok(runId > 0);

    // A jsonb argument survives the round trip as jsonb, not as a string.
    const { rows } = await pglite.query<{ trigger: string }>(
      "select metadata->>'trigger' as trigger from collection_runs where id = $1",
      [runId],
    );
    assert.deepEqual(rows, [{ trigger: 'manual' }]);

    // A second claim for the same store returns null rather than a second run.
    const again = await database.rpc('claim_collection_run', {
      p_retailer_slug: 'paknsave',
      p_store_source_id: 'royal-oak',
      p_metadata: {},
    });
    assert.deepEqual([again.data, again.error], [null, null]);
  });

  it('stages and finalizes offers through the same functions the app calls', async () => {
    const runId = Number(
      (
        await database.rpc('claim_collection_run', {
          p_retailer_slug: 'paknsave',
          p_store_source_id: 'royal-oak',
          p_metadata: {},
        })
      ).data,
    );

    const staged = await database.rpc('stage_collection_offers', {
      p_run_id: runId,
      p_offers: [
        {
          retailer_product_id: 1,
          regular_price_cents: 799,
          promo_price_cents: 699,
          member_price_cents: null,
          promotion_type: 'special',
          promotion_text: 'Save $1',
          valid_until: null,
          collected_at: '2026-09-09T00:00:00.000Z',
          content_hash: 'a'.repeat(64),
        },
      ],
    });
    assert.equal(staged.error, null);

    const finalized = await database.rpc('finalize_collection_run', {
      p_run_id: runId,
      p_offers_seen: 1,
    });
    assert.equal(finalized.error, null);

    const { data } = await database
      .from('current_deals')
      .select('*')
      .gt('offer_id', 0)
      .order('offer_id', { ascending: true })
      .limit(500);
    assert.equal(data?.length, 1);
    assert.equal(data?.[0].effective_price_cents, 699);
  });

  it('reports a database error instead of throwing', async () => {
    const { data, error } = await database
      .from('canonical_products')
      .select('id')
      .eq('column_that_does_not_exist', 1);
    assert.equal(data, null);
    assert.ok(error?.message);

    const rpc = await database.rpc('function_that_does_not_exist');
    assert.equal(rpc.data, null);
    assert.ok(rpc.error?.message);
  });

  it('refuses identifiers it cannot safely quote', () => {
    assert.throws(
      () => database.from('retailers; drop table retailers'),
      /Unsupported SQL identifier/,
    );
  });
});
