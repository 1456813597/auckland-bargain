/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET } from '../app/api/cron/collect/route';

const url = 'https://example.com/api/cron/collect';

function request(path: string, secret?: string) {
  return new Request(`${url}${path}`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('the queue collection route refuses unauthenticated and misconfigured callers', async () => {
  await withEnvironment(
    {
      CRON_SECRET: 'route-test-secret',
      SUPABASE_URL: undefined,
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    },
    async () => {
      assert.equal((await GET(request(''))).status, 401);
      assert.equal((await GET(request('', 'guessed'))).status, 401);
      // Authorized, but the server has no database: the route reports that
      // instead of contacting a supermarket.
      assert.equal((await GET(request('', 'route-test-secret'))).status, 503);
    },
  );
});

test('the route fails closed when the deployment has no cron secret at all', async () => {
  await withEnvironment({ CRON_SECRET: undefined }, async () => {
    assert.equal((await GET(request('', 'anything'))).status, 401);
  });
});

test('unknown retailers and unusable limits are rejected before any queue call', async () => {
  await withEnvironment(
    {
      CRON_SECRET: 'route-test-secret',
      SUPABASE_URL: 'https://queue.test',
      SUPABASE_SECRET_KEY: 'test-only',
    },
    async () => {
      const retailer = await GET(
        request('?retailer=countdown', 'route-test-secret'),
      );
      assert.equal(retailer.status, 400);
      assert.deepEqual(await retailer.json(), { error: 'Unknown retailer.' });

      for (const limit of ['0', '99', 'all']) {
        const response = await GET(
          request(`?limit=${limit}`, 'route-test-secret'),
        );
        assert.equal(response.status, 400);
        assert.match(
          ((await response.json()) as { error: string }).error,
          /Limit must be between/,
        );
      }
    },
  );
});
