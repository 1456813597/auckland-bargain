/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production collectors run weekly and retain one prior observation', async () => {
  const vercel = JSON.parse(await readFile('vercel.json', 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.equal(vercel.crons.length, 6);
  assert.ok(vercel.crons.every((cron) => cron.schedule.endsWith('* * 0')));
  assert.equal(new Set(vercel.crons.map((cron) => cron.path)).size, 6);
  for (const retailer of [
    'paknsave',
    'newworld',
    'foursquare',
    'freshchoice',
    'supervalue',
  ]) {
    assert.ok(
      vercel.crons.some(
        (cron) => cron.path === `/api/cron/supermarkets?retailer=${retailer}`,
      ),
    );
  }

  const weeklyRoute = await readFile(
    'app/api/cron/supermarkets/route.ts',
    'utf8',
  );
  for (const retailer of [
    'PaknsaveCollector',
    'NewWorldCollector',
    'FourSquareCollector',
    'FreshChoiceCollector',
    'SuperValueCollector',
  ]) {
    assert.match(weeklyRoute, new RegExp(retailer));
  }

  const migration = await readFile(
    'supabase/migrations/20260905120000_add_product_comparison_matching.sql',
    'utf8',
  );
  assert.match(migration, /ranked\.position > 2/);
  assert.match(
    migration,
    /Created as a new canonical product|canonical_products/,
  );
});
