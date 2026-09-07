/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { reconcileProductMatches } from '../lib/matching/supabase';
import type { RawOffer } from '../lib/collectors/types';

function offer(id: string): RawOffer {
  return {
    sourceProductId: id,
    sourceName: 'Salted Butter',
    brand: 'Anchor',
    size: '500g',
    category: 'Dairy',
    gtin: null,
    imageUrl: null,
    sourceUrl: 'https://store.test/butter',
    regularPriceCents: 500,
    promoPriceCents: null,
    memberPriceCents: null,
    promotionType: null,
    promotionText: null,
    validUntil: null,
    collectedAt: new Date('2026-09-06T00:00:00Z'),
  };
}

test('pages through capped candidates and does not reuse a canonical product within one retailer run', async () => {
  const canonical = Array.from({ length: 3 }, (_, index) => ({
    id: index + 1,
    slug: `candidate-${index}`,
    display_name: index === 2 ? 'Salted Butter' : 'Unsalted Butter',
    normalized_name: 'butter',
    brand: 'Anchor',
    normalized_brand: 'anchor',
    size: '500g',
    category: 'Dairy',
    gtin: null,
    matching_measure: 'mass:500:1',
    matching_tokens: ['butter'],
  }));
  const matches: Array<{
    retailer_product_id: number;
    canonical_product_id: number;
  }> = [];
  const cursors: number[] = [];
  let seedSlug = '';
  const supabase = createClient('https://matching.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname.endsWith('/retailers'))
          return Response.json({ id: 1 });
        if (url.pathname.endsWith('/canonical_products')) {
          if (init?.method === 'POST') {
            seedSlug = (
              JSON.parse(init.body as string) as Array<{ slug: string }>
            )[0].slug;
            return Response.json([]);
          }
          if (url.searchParams.has('slug'))
            return Response.json([{ id: 100, slug: seedSlug }]);
          const cursor = Number(
            url.searchParams.get('id')?.replace('gt.', '') ?? 0,
          );
          cursors.push(cursor);
          // Simulate a configured API row cap smaller than the requested limit.
          return Response.json(
            canonical.filter((row) => row.id > cursor).slice(0, 2),
          );
        }
        if (url.pathname.endsWith('/product_matches')) {
          if (init?.method === 'POST') {
            assert.equal(typeof init.body, 'string');
            matches.push(
              ...(JSON.parse(init.body as string) as typeof matches),
            );
          }
          return Response.json([]);
        }
        if (url.pathname.endsWith('/product_match_reviews'))
          return Response.json([]);
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    },
  });
  const result = await reconcileProductMatches({
    supabase,
    retailerSlug: 'test',
    productIds: new Map([
      ['a', 10],
      ['b', 11],
    ]),
    offers: [offer('a'), offer('b')],
  });
  assert.equal(result.matched, 2);
  assert.ok(cursors.includes(2));
  assert.deepEqual(
    matches.map((match) => match.canonical_product_id),
    [3, 100],
  );
});

test('seeds and accepts a large first catalogue in bounded batch writes', async () => {
  const seeds = new Map<string, number>();
  const writeSizes: number[] = [];
  const supabase = createClient('https://matching.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === 'POST') {
          const rows = JSON.parse(init.body as string) as Array<{
            slug?: string;
          }>;
          writeSizes.push(rows.length);
          if (url.pathname.endsWith('/canonical_products')) {
            for (const row of rows)
              if (row.slug && !seeds.has(row.slug))
                seeds.set(row.slug, seeds.size + 1);
          }
          return Response.json([]);
        }
        if (url.searchParams.has('slug')) {
          const slugs = url.searchParams
            .get('slug')!
            .slice(4, -1)
            .split(',')
            .map((slug) => slug.replaceAll('"', ''));
          return Response.json(
            slugs.map((slug) => ({ slug, id: seeds.get(slug) })),
          );
        }
        return Response.json([]);
      },
    },
  });
  const offers = Array.from({ length: 501 }, (_, index) =>
    offer(String(index)),
  );
  const result = await reconcileProductMatches({
    supabase,
    retailerSlug: 'test',
    productIds: new Map(
      offers.map((item, index) => [item.sourceProductId, index + 1]),
    ),
    offers,
  });
  assert.equal(result.matched, 501);
  assert.equal(seeds.size, 501);
  assert.equal(writeSizes.length, 17);
  assert.ok(Math.max(...writeSizes) <= 100);
});

test('batches existing product IDs instead of constructing an oversized URL', async () => {
  const batchSizes: number[] = [];
  const supabase = createClient('https://matching.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.ok(url.pathname.endsWith('/product_matches'));
        const ids = (url.searchParams.get('retailer_product_id') ?? '')
          .slice(4, -1)
          .split(',')
          .map(Number);
        batchSizes.push(ids.length);
        return Response.json(ids.map((id) => ({ retailer_product_id: id })));
      },
    },
  });
  const offers = Array.from({ length: 1001 }, (_, index) =>
    offer(String(index)),
  );
  const result = await reconcileProductMatches({
    supabase,
    retailerSlug: 'test',
    productIds: new Map(
      offers.map((item, index) => [item.sourceProductId, index + 1]),
    ),
    offers,
  });
  assert.equal(result.matched, 0);
  assert.equal(batchSizes.length, 11);
  assert.ok(Math.max(...batchSizes) <= 100);
});
