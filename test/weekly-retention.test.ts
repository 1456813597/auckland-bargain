/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production collectors run weekly and retain one prior observation', async () => {
  const schedule = JSON.parse(
    await readFile('deploy/cron-jobs.json', 'utf8'),
  ) as {
    defaultTimezone: string;
    jobs: Array<{
      name: string;
      path: string;
      variable: string;
      schedule: string;
    }>;
  };
  // New Zealand time, because the schedule container renders this table with
  // that timezone; a UTC expression would drift by an hour twice a year.
  assert.equal(schedule.defaultTimezone, 'Pacific/Auckland');
  assert.equal(new Set(schedule.jobs.map((job) => job.path)).size, 7);
  assert.equal(new Set(schedule.jobs.map((job) => job.variable)).size, 7);
  // The registry-driven queue repeats through the week so backed-off retries
  // land inside the same NZ week; it collects each store only once regardless.
  const queue = schedule.jobs.filter((job) => job.path === '/api/cron/collect');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].schedule, '0 * * * *');
  const banners = schedule.jobs.filter(
    (job) => job.path !== '/api/cron/collect',
  );
  assert.equal(banners.length, 6);
  assert.ok(banners.every((job) => job.schedule.endsWith('* * 1')));
  for (const retailer of [
    'paknsave',
    'newworld',
    'foursquare',
    'freshchoice',
    'supervalue',
  ]) {
    assert.ok(
      schedule.jobs.some(
        (job) => job.path === `/api/cron/supermarkets?retailer=${retailer}`,
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
