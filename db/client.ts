import { createClient } from '@supabase/supabase-js';

import { createPoolExecutor, postgresConnectionString } from './postgres/pool';
import {
  PostgresRestClient,
  type DatabaseError,
  type DatabaseResult,
  type DatabaseRow,
} from './postgres/rest';

export type { DatabaseError, DatabaseResult, DatabaseRow };

type Rows = DatabaseResult<DatabaseRow[] | null>;

export interface FilteredQuery extends PromiseLike<Rows> {
  eq(column: string, value: unknown): FilteredQuery;
  gt(column: string, value: unknown): FilteredQuery;
  in(column: string, values: readonly unknown[]): FilteredQuery;
  overlaps(column: string, values: readonly unknown[]): FilteredQuery;
  order(column: string, options?: { ascending?: boolean }): FilteredQuery;
  limit(count: number): FilteredQuery;
  single(): PromiseLike<DatabaseResult<DatabaseRow | null>>;
}

export interface WrittenRows extends PromiseLike<Rows> {
  select(columns?: string): WrittenRows;
  single(): PromiseLike<DatabaseResult<DatabaseRow | null>>;
}

export interface UpdatedRows extends PromiseLike<DatabaseResult<null>> {
  eq(column: string, value: unknown): UpdatedRows;
}

export interface TableQuery {
  select(columns?: string): FilteredQuery;
  update(values: DatabaseRow): UpdatedRows;
  upsert(
    values: DatabaseRow | DatabaseRow[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): WrittenRows;
}

// The subset of the Supabase client this application uses. Both drivers below
// answer exactly this, so no call site knows which one is connected.
export interface Database {
  from(table: string): TableQuery;
  rpc(
    name: string,
    parameters?: Record<string, unknown>,
  ): PromiseLike<DatabaseResult<unknown>>;
}

export type DatabaseDriver = 'postgres' | 'supabase';

function supabaseCredentials(environment: Record<string, string | undefined>) {
  const url = environment.SUPABASE_URL;
  const secretKey =
    environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  return url && secretKey ? { url, secretKey } : undefined;
}

export function databaseDriver(
  environment: Record<string, string | undefined> = process.env,
): DatabaseDriver | undefined {
  const requested = environment.DATABASE_DRIVER?.trim().toLowerCase();
  if (requested === 'postgres' || requested === 'supabase') return requested;
  if (requested) {
    throw new Error(`Unsupported DATABASE_DRIVER value: ${requested}`);
  }
  // A direct connection string is the more specific configuration, so a server
  // that has both keeps talking to its own Postgres.
  if (postgresConnectionString(environment)) return 'postgres';
  return supabaseCredentials(environment) ? 'supabase' : undefined;
}

export function isDatabaseConfigured(
  environment: Record<string, string | undefined> = process.env,
) {
  const driver = databaseDriver(environment);
  if (driver === 'postgres')
    return Boolean(postgresConnectionString(environment));
  if (driver === 'supabase') return Boolean(supabaseCredentials(environment));
  return false;
}

let client: Database | undefined;

export function getDatabase(): Database {
  if (client) return client;

  const driver = databaseDriver();
  if (driver === 'postgres') {
    client = new PostgresRestClient(createPoolExecutor()) as Database;
    return client;
  }

  const credentials = supabaseCredentials(process.env);
  if (driver !== 'supabase' || !credentials) {
    throw new Error(
      'No database is configured. Set DATABASE_URL for a direct Postgres connection, or SUPABASE_URL and SUPABASE_SECRET_KEY for Supabase.',
    );
  }

  // supabase-js has far richer generic types than `Database` describes; the
  // cast keeps one narrow contract for every call site instead of two.
  client = createClient(credentials.url, credentials.secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { 'X-Client-Info': 'auckland-bargain/0.1' },
    },
  }) as unknown as Database;
  return client;
}

// Tests and long-lived scripts that change the environment between runs.
export function resetDatabaseClient() {
  client = undefined;
}
