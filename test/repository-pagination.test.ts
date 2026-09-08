/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../db/client';
import { readCurrentRows, readOfferHistory } from '../lib/repositories/deals';

// The Supabase client's own generics are far deeper than the narrow `Database`
// contract the repositories use, so the fixtures are cast at the boundary.
const asDatabase = (client: unknown) => client as Database;

test('current prices and multi-store history survive an API cap below the requested page size', async () => {
  const supabase = createClient('https://repository.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const current = url.pathname.endsWith('/current_deals');
        const key = current ? 'offer_id' : 'id';
        const cursor = Number(
          url.searchParams.get(key)?.replace('gt.', '') ?? 0,
        );
        assert.equal(
          url.searchParams.has('observed_at'),
          false,
          'retained history must not disappear after an arbitrary 90-day cutoff',
        );
        const rows = Array.from({ length: current ? 5 : 12 }, (_, index) => ({
          [key]: index + 1,
          retailer_product_id: 1,
          store_id: Math.ceil((index + 1) / 2),
          observed_at: '2025-01-01T00:00:00Z',
        }));
        return Response.json(
          rows.filter((row) => Number(row[key]) > cursor).slice(0, 2),
        );
      },
    },
  });
  assert.equal((await readCurrentRows(asDatabase(supabase))).length, 5);
  const history = await readOfferHistory(asDatabase(supabase), [1]);
  assert.equal(history.length, 12);
  assert.equal(new Set(history.map((point) => point.store_id)).size, 6);
});

test('repository fails closed if a server ignores the pagination cursor', async () => {
  const supabase = createClient('https://repository.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async () => Response.json([{ offer_id: 1 }]) },
  });
  await assert.rejects(
    readCurrentRows(asDatabase(supabase)),
    /did not advance/,
  );
});
