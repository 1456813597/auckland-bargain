import type { SqlExecutor } from './rest';

type PoolLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
};

function sslConfiguration(environment: Record<string, string | undefined>) {
  const mode = environment.DATABASE_SSL?.trim().toLowerCase();
  // Unset means "whatever the connection string says", which is how a Supabase
  // pooler URL (`?sslmode=require`) and a plain local socket both stay correct.
  if (!mode) return undefined;
  if (['disable', 'off', 'false'].includes(mode)) return false as const;
  if (['require', 'allow', 'prefer', 'true'].includes(mode)) {
    return { rejectUnauthorized: false };
  }
  if (['verify', 'verify-full', 'verify-ca'].includes(mode)) {
    return {
      rejectUnauthorized: true,
      ca: environment.DATABASE_SSL_CA || undefined,
    };
  }
  throw new Error(
    `Unsupported DATABASE_SSL value: ${environment.DATABASE_SSL}`,
  );
}

export function postgresConnectionString(
  environment: Record<string, string | undefined> = process.env,
) {
  return (
    environment.DATABASE_URL ||
    environment.POSTGRES_URL ||
    environment.POSTGRES_URL_NON_POOLING ||
    undefined
  );
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The pool is created on first query so a Supabase-only deployment never loads
// the driver, and a build without any database configured never connects.
export function createPoolExecutor(
  environment: Record<string, string | undefined> = process.env,
): SqlExecutor & { close(): Promise<void> } {
  let pool: Promise<PoolLike> | undefined;

  async function connect() {
    const connectionString = postgresConnectionString(environment);
    if (!connectionString) {
      throw new Error(
        'Postgres is not configured. Set DATABASE_URL to a connection string.',
      );
    }
    const { default: pg } = await import('pg');
    return new pg.Pool({
      connectionString,
      ssl: sslConfiguration(environment),
      max: positiveInteger(environment.DATABASE_POOL_MAX, 10),
      idleTimeoutMillis: positiveInteger(
        environment.DATABASE_POOL_IDLE_MS,
        30_000,
      ),
      connectionTimeoutMillis: positiveInteger(
        environment.DATABASE_CONNECT_TIMEOUT_MS,
        15_000,
      ),
      application_name: 'auckland-bargain',
    }) as unknown as PoolLike;
  }

  return {
    async query<Row>(text: string, values: unknown[] = []) {
      pool ??= connect();
      const result = await (await pool).query(text, values);
      return { rows: result.rows as Row[] };
    },
    async close() {
      if (!pool) return;
      const active = await pool;
      pool = undefined;
      await active.end();
    },
  };
}
