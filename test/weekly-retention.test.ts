/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production collectors run weekly and retain one prior observation', async () => {
  const vercel = JSON.parse(await readFile('vercel.json', 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.equal(new Set(vercel.crons.map((cron) => cron.path)).size, 7);
  // The registry-driven queue repeats through the week so backed-off retries
  // land inside the same NZ week; it collects each store only once regardless.
  const queue = vercel.crons.filter(
    (cron) => cron.path === '/api/cron/collect',
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0].schedule, '0 * * * *');
  const banners = vercel.crons.filter(
    (cron) => cron.path !== '/api/cron/collect',
  );
  assert.equal(banners.length, 6);
  assert.ok(banners.every((cron) => cron.schedule.endsWith('* * 0')));
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
