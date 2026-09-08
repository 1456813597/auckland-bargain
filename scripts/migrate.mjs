// Applies the tracked SQL migrations to any Postgres: a Supabase project (via
// its direct connection string) or a self-hosted server such as the one the
// aaPanel/Baota PostgreSQL manager installs. Plain JavaScript on purpose, so
// the production container can run it without dev dependencies.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

const MIGRATIONS_DIR = path.resolve('supabase/migrations');
// Supabase's CLI records applied migrations here. Writing the same rows keeps
// `supabase db push` and this runner from applying the same file twice.
const HISTORY_SCHEMA = 'supabase_migrations';
const HISTORY_TABLE = 'schema_migrations';
// Created by Supabase on every project; the migrations grant to them by name.
const REQUIRED_ROLES = ['anon', 'authenticated', 'service_role'];

function connectionString() {
  const value =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL;
  if (!value) {
    console.error(
      'Set DATABASE_URL (or POSTGRES_URL_NON_POOLING) to the database this should migrate.',
    );
    process.exit(1);
  }
  return value;
}

function sslOption() {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (!mode) return undefined;
  if (['disable', 'off', 'false'].includes(mode)) return false;
  if (['verify', 'verify-ca', 'verify-full'].includes(mode)) {
    return {
      rejectUnauthorized: true,
      ca: process.env.DATABASE_SSL_CA || undefined,
    };
  }
  return { rejectUnauthorized: false };
}

// The files wrap themselves in begin/commit. Running that inside another
// transaction would commit early, so the body is unwrapped and this runner's
// transaction covers both the migration and its history row.
function transactionBody(sql) {
  return sql
    .replace(/^\s*begin\s*;/i, '')
    .replace(/commit\s*;\s*$/i, '')
    .trim();
}

async function ensureRoles(client) {
  for (const role of REQUIRED_ROLES) {
    const { rows } = await client.query(
      'select 1 from pg_roles where rolname = $1',
      [role],
    );
    if (rows.length > 0) continue;
    try {
      await client.query(`create role ${role} nologin`);
      console.log(`[migrate] created missing role ${role}`);
    } catch (error) {
      // A managed database may forbid role creation while already having its
      // own equivalents; report it instead of failing every later grant.
      console.warn(`[migrate] could not create role ${role}: ${error.message}`);
    }
  }
}

async function appliedVersions(client) {
  await client.query(`create schema if not exists ${HISTORY_SCHEMA}`);
  await client.query(
    `create table if not exists ${HISTORY_SCHEMA}.${HISTORY_TABLE} (
       version text primary key,
       statements text[],
       name text
     )`,
  );
  const { rows } = await client.query(
    `select version from ${HISTORY_SCHEMA}.${HISTORY_TABLE}`,
  );
  return new Set(rows.map((row) => row.version));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: sslOption(),
    application_name: 'auckland-bargain-migrate',
  });
  await client.connect();
  try {
    await ensureRoles(client);
    const applied = await appliedVersions(client);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const pending = files.filter(
      (file) => !applied.has(file.split('_')[0] ?? file),
    );
    if (pending.length === 0) {
      console.log(`[migrate] up to date (${files.length} applied)`);
      return;
    }
    if (dryRun) {
      console.log(
        `[migrate] pending:\n${pending.map((file) => `  ${file}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }

    for (const file of pending) {
      const version = file.split('_')[0];
      const name = file.replace(/^\d+_/, '').replace(/\.sql$/, '');
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] applying ${file}`);
      await client.query('begin');
      try {
        await client.query(transactionBody(sql));
        await client.query(
          `insert into ${HISTORY_SCHEMA}.${HISTORY_TABLE} (version, name)
           values ($1, $2) on conflict (version) do nothing`,
          [version, name],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`${file}: ${error.message}`);
      }
    }
    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[migrate] ${error.message}`);
  process.exit(1);
});
