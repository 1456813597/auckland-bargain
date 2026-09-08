/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// The scheduler container replaced `vercel.json`'s cron list. Rendering it here
// keeps a broken schedule from being discovered a week after a deployment.
const ENTRYPOINT = 'docker/scheduler/entrypoint.sh';
const hasJq = spawnSync('sh', ['-c', 'command -v jq']).status === 0;

async function render(
  environment: Record<string, string> = {},
): Promise<{ status: number; crontab: string; output: string; state: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'auckland-cron-'));
  const crontab = path.join(directory, 'crontab');
  const state = path.join(directory, 'state');
  const result = spawnSync('sh', [ENTRYPOINT, '--render-only'], {
    encoding: 'utf8',
    // Deliberately minimal: a developer's own CRON_* variables must not decide
    // what this renders.
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      CRON_SECRET: 'test-secret-value',
      CRON_JOBS_FILE: 'deploy/cron-jobs.json',
      SCHEDULER_STATE_DIR: state,
      SCHEDULER_CRONTAB: crontab,
      ...environment,
    },
  });
  let rendered = '';
  try {
    rendered = await readFile(crontab, 'utf8');
  } catch {
    rendered = '';
  }
  return {
    status: result.status ?? 1,
    crontab: rendered,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    state,
  };
}

describe(
  'the scheduler crontab',
  { skip: hasJq ? false : 'jq is required' },
  () => {
    it('renders every job from the tracked table', async () => {
      const { status, crontab } = await render();
      assert.equal(status, 0);
      const lines = crontab.trim().split('\n');
      assert.equal(lines.length, 7);
      assert.equal(
        lines[0],
        "0 * * * * /usr/local/bin/run-collection-job 'queue' '/api/cron/collect'",
      );
      // Quoted, because crond runs each line through `sh -c` where `?` globs.
      assert.ok(
        lines.some((line) =>
          line.endsWith(
            "'supervalue' '/api/cron/supermarkets?retailer=supervalue'",
          ),
        ),
      );
    });

    it('takes a schedule from the environment', async () => {
      const { crontab } = await render({
        CRON_COLLECT_SCHEDULE: '*/15 * * * *',
      });
      assert.ok(
        crontab.includes(
          "*/15 * * * * /usr/local/bin/run-collection-job 'queue' '/api/cron/collect'",
        ),
      );
    });

    it('drops a job switched off, and says so', async () => {
      const { status, crontab, output } = await render({
        CRON_WOOLWORTHS_SCHEDULE: 'off',
      });
      assert.equal(status, 0);
      assert.equal(crontab.trim().split('\n').length, 6);
      assert.ok(!crontab.includes('/api/cron/woolworths'));
      assert.match(output, /woolworths disabled by CRON_WOOLWORTHS_SCHEDULE/);
    });

    it('refuses to start on a malformed schedule or an unknown timezone', async () => {
      const malformed = await render({ CRON_COLLECT_SCHEDULE: 'every hour' });
      assert.equal(malformed.status, 1);
      assert.match(malformed.output, /not a five-field cron expression/);

      const timezone = await render({ CRON_TZ: 'Mars/Olympus_Mons' });
      assert.equal(timezone.status, 1);
      assert.match(timezone.output, /unknown CRON_TZ/);
    });

    it('refuses to start without the shared secret', async () => {
      const { status, output } = await render({ CRON_SECRET: '' });
      assert.equal(status, 1);
      assert.match(output, /CRON_SECRET is required/);
    });

    it('logs one parsable JSON line per run and fails on an unreachable app', async () => {
      const { state } = await render({ APP_URL: 'http://127.0.0.1:1' });
      // Nothing is listening on port 1; curl reports 000, which must still come
      // out of the log as valid JSON rather than as a bare number.
      const result = spawnSync(
        'sh',
        ['docker/scheduler/run-job.sh', 'queue', '/api/cron/collect'],
        {
          encoding: 'utf8',
          env: {
            NODE_ENV: 'test',
            PATH: process.env.PATH ?? '',
            SCHEDULER_STATE_DIR: state,
          },
        },
      );
      assert.equal(result.status, 1);
      const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
      const logged = JSON.parse(line) as {
        job: string;
        status: string;
        path: string;
      };
      assert.deepEqual(
        [logged.job, logged.path, logged.status],
        ['queue', '/api/cron/collect', '000'],
      );
    });

    it('keeps the secret in a file only the scheduler user can read', async () => {
      const { state } = await render();
      const file = path.join(state, 'env');
      const contents = await readFile(file, 'utf8');
      assert.match(contents, /CRON_SECRET='test-secret-value'/);
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode & 0o077, 0);
    });
  },
);
