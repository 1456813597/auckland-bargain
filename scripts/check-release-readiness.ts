import path from 'node:path';
import process from 'node:process';

import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
const environmentDirectory = process.env.RELEASE_ENV_DIR
  ? path.resolve(process.env.RELEASE_ENV_DIR)
  : process.cwd();

loadEnvConfig(environmentDirectory, process.env.NODE_ENV !== 'production');

const cronSecretConfigured = (process.env.CRON_SECRET?.length ?? 0) >= 16;
const { checkDatabaseReadiness } = await import('../db/readiness');
const database = await checkDatabaseReadiness();
const result = {
  ready: cronSecretConfigured && database.ready,
  checks: {
    cronSecretConfigured,
    database: database.checks,
  },
  schemaVersion: database.schemaVersion,
  ...(!cronSecretConfigured
    ? { configurationError: 'CRON_SECRET must contain at least 16 characters.' }
    : {}),
  ...(database.error ? { databaseError: database.error } : {}),
};

if (!result.ready) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
