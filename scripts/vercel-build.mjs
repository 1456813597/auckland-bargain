import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const npmCli = process.env.npm_execpath;
const legacyBaselineMigration = '20260830110000';

function fail(message) {
  console.error(`[vercel-build] ${message}`);
  process.exit(1);
}

function run(label, command, args) {
  console.log(`\n[vercel-build] ${label}`);
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runNpm(label, args) {
  if (!npmCli) {
    fail('npm_execpath is missing. Run this build through npm run build:vercel.');
  }

  run(label, process.execPath, [npmCli, ...args]);
}

function runSupabase(label, args) {
  runNpm(label, ['exec', '--', 'supabase', ...args]);
}

function findHttpMigrationRoute(directory) {
  if (!existsSync(directory)) {
    return undefined;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = findHttpMigrationRoute(entryPath);
      if (match) {
        return match;
      }
      continue;
    }

    const normalizedPath = entryPath.replaceAll('\\', '/').toLowerCase();
    if (/\/apply-migration\/route\.[^/]+$/.test(normalizedPath)) {
      return entryPath;
    }
  }

  return undefined;
}

function requireEnvironmentVariables(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(
      `Missing Vercel Production environment variable(s): ${missing.join(', ')}`,
    );
  }
}

const migrationRoute = findHttpMigrationRoute(path.resolve('app/api'));
if (migrationRoute) {
  fail(`Database migrations must not be exposed over HTTP: ${migrationRoute}`);
}

runNpm('Run tests', ['test']);
runNpm('Run type checking', ['run', 'typecheck']);
runNpm('Run lint', ['run', 'lint']);

if (process.env.VERCEL_ENV === 'production') {
  requireEnvironmentVariables(['POSTGRES_URL_NON_POOLING']);
  const productionDatabaseUrl = process.env.POSTGRES_URL_NON_POOLING;

  if (process.env.SUPABASE_BASELINE_MIGRATION) {
    if (process.env.SUPABASE_BASELINE_MIGRATION !== legacyBaselineMigration) {
      fail(
        `Unsupported Supabase baseline migration: ${process.env.SUPABASE_BASELINE_MIGRATION}`,
      );
    }

    runSupabase(`Mark legacy migration ${legacyBaselineMigration} as applied`, [
      'migration',
      'repair',
      '--status',
      'applied',
      legacyBaselineMigration,
      '--db-url',
      productionDatabaseUrl,
    ]);
  }

  runSupabase('Show migration history', [
    'migration',
    'list',
    '--db-url',
    productionDatabaseUrl,
  ]);
  runSupabase('Apply production migrations', [
    'db',
    'push',
    '--db-url',
    productionDatabaseUrl,
  ]);
  runSupabase('Verify no migrations remain pending', [
    'db',
    'push',
    '--dry-run',
    '--db-url',
    productionDatabaseUrl,
  ]);
  runNpm('Verify production readiness', ['run', 'release:ready']);
} else {
  console.log(
    '\n[vercel-build] Skipping production database migration and readiness checks.',
  );
}

runNpm('Create Next.js production build', ['run', 'build']);
