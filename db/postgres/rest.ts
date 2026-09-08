/* oxlint-disable unicorn/no-thenable -- A query builder that runs when awaited is the interface being replaced; supabase-js builders are thenable in exactly the same way. */
// A small PostgREST-compatible query builder over a direct Postgres connection.
//
// The application was written against `@supabase/supabase-js`, whose builder is
// a thin client for PostgREST. Running the same code against a self-hosted
// Postgres (the aaPanel/Baota "PostgreSQL manager" install, for example) means
// answering the same calls with SQL. Only the subset this repository actually
// uses is implemented, and anything outside it throws instead of guessing.

export type DatabaseRow = Record<string, unknown>;
export type DatabaseError = { message: string };
export type DatabaseResult<Data> = { data: Data; error: DatabaseError | null };

export interface SqlExecutor {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string) {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Unsupported SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

// Dates and plain objects reach PostgREST as JSON; Postgres wants text it can
// coerce. Arrays are left alone so `in`/`overlaps` can expand them itself.
function parameterValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return value;
}

class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown) {
    this.values.push(parameterValue(value));
    return `$${this.values.length}`;
  }
}

type Filter = {
  column: string;
  operator: 'eq' | 'gt' | 'in' | 'overlaps';
  value: unknown;
};

type ForeignKey = { column: string; foreignColumn: string };

const FOREIGN_KEY_SQL = `
  select att.attname as column_name, fatt.attname as foreign_column
  from pg_constraint c
  join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
  join lateral unnest(c.confkey) with ordinality as f(attnum, ord) on f.ord = k.ord
  join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum
  join pg_attribute fatt on fatt.attrelid = c.confrelid and fatt.attnum = f.attnum
  where c.contype = 'f'
    and c.conrelid = $1::regclass
    and c.confrelid = $2::regclass
`;

// `select('a,b')` is a flat list, but `select('a,other!inner(b)')` embeds a
// related table. PostgREST resolves the relationship from the foreign key, so
// this does the same rather than hard-coding one join.
type Projection = {
  columns: string[];
  embed?: { table: string; columns: string[] };
};

function splitTopLevel(columns: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of columns) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  if (depth !== 0) throw new Error(`Unbalanced select list: ${columns}`);
  return parts;
}

function parseProjection(columns: string): Projection {
  const projection: Projection = { columns: [] };
  for (const part of splitTopLevel(columns)) {
    const embedded = /^([a-z_][a-z0-9_]*)!inner\((.+)\)$/.exec(part);
    if (embedded) {
      if (projection.embed) {
        throw new Error('Only one embedded relationship is supported.');
      }
      projection.embed = {
        table: embedded[1],
        columns: splitTopLevel(embedded[2]),
      };
      continue;
    }
    projection.columns.push(part);
  }
  return projection;
}

function renderFilters(
  filters: Filter[],
  parameters: Parameters,
  columnSql: (column: string) => string,
) {
  const clauses: string[] = [];
  for (const filter of filters) {
    const column = columnSql(filter.column);
    if (filter.operator === 'eq') {
      clauses.push(`${column} = ${parameters.add(filter.value)}`);
      continue;
    }
    if (filter.operator === 'gt') {
      clauses.push(`${column} > ${parameters.add(filter.value)}`);
      continue;
    }
    const values = filter.value as readonly unknown[];
    if (!Array.isArray(values)) {
      throw new Error(`${filter.operator} requires an array of values.`);
    }
    if (values.length === 0) {
      // PostgREST answers both with an empty result rather than an error.
      clauses.push('false');
      continue;
    }
    const placeholders = values.map((value) => parameters.add(value));
    clauses.push(
      filter.operator === 'in'
        ? `${column} in (${placeholders.join(', ')})`
        : `${column} && array[${placeholders.join(', ')}]`,
    );
  }
  return clauses;
}

function failure(error: unknown): DatabaseError {
  return {
    message: error instanceof Error ? error.message : 'Postgres query failed.',
  };
}

class SelectQuery implements PromiseLike<DatabaseResult<DatabaseRow[] | null>> {
  private readonly filters: Filter[] = [];
  private ordering?: { column: string; ascending: boolean };
  private rowLimit?: number;

  constructor(
    private readonly client: PostgresRestClient,
    private readonly table: string,
    private readonly columns: string,
  ) {}

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: 'eq', value });
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push({ column, operator: 'gt', value });
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push({ column, operator: 'in', value: values });
    return this;
  }

  overlaps(column: string, values: readonly unknown[]) {
    this.filters.push({ column, operator: 'overlaps', value: values });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.ordering = { column, ascending: options.ascending !== false };
    return this;
  }

  limit(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('limit() requires a non-negative integer.');
    }
    this.rowLimit = count;
    return this;
  }

  single(): PromiseLike<DatabaseResult<DatabaseRow | null>> {
    const rows = this.run();
    return {
      then: (resolve, reject) =>
        rows
          .then((result) => {
            if (result.error) return { data: null, error: result.error };
            const data = result.data ?? [];
            if (data.length !== 1) {
              return {
                data: null,
                error: {
                  message:
                    'JSON object requested, multiple (or no) rows returned',
                },
              };
            }
            return { data: data[0], error: null };
          })
          .then(resolve, reject),
    };
  }

  then<Fulfilled = DatabaseResult<DatabaseRow[] | null>, Rejected = never>(
    onfulfilled?:
      | ((
          value: DatabaseResult<DatabaseRow[] | null>,
        ) => Fulfilled | PromiseLike<Fulfilled>)
      | null,
    onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ) {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<DatabaseResult<DatabaseRow[] | null>> {
    try {
      const projection = parseProjection(this.columns);
      const parameters = new Parameters();
      const embed = projection.embed;
      const columnSql = (column: string) => {
        const [head, tail] = column.split('.');
        if (tail === undefined) return `base.${identifier(head)}`;
        if (!embed || head !== embed.table) {
          throw new Error(`Unknown embedded table in filter: ${column}`);
        }
        return `embedded.${identifier(tail)}`;
      };

      const selected = projection.columns.map((column) =>
        column === '*' ? 'base.*' : `base.${identifier(column)}`,
      );
      let join = '';
      if (embed) {
        const key = await this.client.foreignKey(this.table, embed.table);
        join = ` join ${identifier(embed.table)} embedded on base.${identifier(
          key.column,
        )} = embedded.${identifier(key.foreignColumn)}`;
        const pairs = embed.columns
          .map(
            (column) =>
              `'${column.replaceAll("'", "''")}', embedded.${identifier(column)}`,
          )
          .join(', ');
        selected.push(
          `jsonb_build_object(${pairs}) as ${identifier(embed.table)}`,
        );
      }

      const clauses = renderFilters(this.filters, parameters, columnSql);
      const where = clauses.length ? ` where ${clauses.join(' and ')}` : '';
      const order = this.ordering
        ? ` order by ${columnSql(this.ordering.column)} ${
            this.ordering.ascending ? 'asc' : 'desc'
          }`
        : '';
      const limit =
        this.rowLimit === undefined ? '' : ` limit ${this.rowLimit}`;
      const sql = `select ${selected.join(', ')} from ${identifier(
        this.table,
      )} base${join}${where}${order}${limit}`;
      const result = await this.client.execute<DatabaseRow>(
        sql,
        parameters.values,
      );
      return { data: result.rows, error: null };
    } catch (error) {
      return { data: null, error: failure(error) };
    }
  }
}

class WriteQuery implements PromiseLike<DatabaseResult<DatabaseRow[] | null>> {
  private returning?: string;

  constructor(
    private readonly client: PostgresRestClient,
    private readonly build: (
      parameters: Parameters,
      returning?: string,
    ) => string,
  ) {}

  select(columns = '*') {
    this.returning = columns;
    return this;
  }

  single(): PromiseLike<DatabaseResult<DatabaseRow | null>> {
    const rows = this.run();
    return {
      then: (resolve, reject) =>
        rows
          .then((result) => {
            if (result.error) return { data: null, error: result.error };
            const data = result.data ?? [];
            if (data.length !== 1) {
              return {
                data: null,
                error: {
                  message:
                    'JSON object requested, multiple (or no) rows returned',
                },
              };
            }
            return { data: data[0], error: null };
          })
          .then(resolve, reject),
    };
  }

  then<Fulfilled = DatabaseResult<DatabaseRow[] | null>, Rejected = never>(
    onfulfilled?:
      | ((
          value: DatabaseResult<DatabaseRow[] | null>,
        ) => Fulfilled | PromiseLike<Fulfilled>)
      | null,
    onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ) {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<DatabaseResult<DatabaseRow[] | null>> {
    try {
      const parameters = new Parameters();
      const sql = this.build(parameters, this.returning);
      const result = await this.client.execute<DatabaseRow>(
        sql,
        parameters.values,
      );
      return { data: this.returning ? result.rows : null, error: null };
    } catch (error) {
      return { data: null, error: failure(error) };
    }
  }
}

class UpdateQuery implements PromiseLike<DatabaseResult<null>> {
  private readonly filters: Filter[] = [];

  constructor(
    private readonly client: PostgresRestClient,
    private readonly table: string,
    private readonly values: DatabaseRow,
  ) {}

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: 'eq', value });
    return this;
  }

  then<Fulfilled = DatabaseResult<null>, Rejected = never>(
    onfulfilled?:
      | ((value: DatabaseResult<null>) => Fulfilled | PromiseLike<Fulfilled>)
      | null,
    onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ) {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<DatabaseResult<null>> {
    try {
      const parameters = new Parameters();
      const assignments = Object.entries(this.values).map(
        ([column, value]) => `${identifier(column)} = ${parameters.add(value)}`,
      );
      if (assignments.length === 0)
        throw new Error('update() requires values.');
      const clauses = renderFilters(this.filters, parameters, (column) =>
        identifier(column),
      );
      if (clauses.length === 0) {
        // PostgREST refuses an unfiltered update for the same reason.
        throw new Error('update() requires at least one filter.');
      }
      const sql = `update ${identifier(this.table)} set ${assignments.join(
        ', ',
      )} where ${clauses.join(' and ')}`;
      await this.client.execute(sql, parameters.values);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: failure(error) };
    }
  }
}

export class PostgresRestClient {
  private readonly foreignKeys = new Map<string, ForeignKey>();

  constructor(private readonly executor: SqlExecutor) {}

  execute<Row>(sql: string, values: unknown[] = []) {
    return this.executor.query<Row>(sql, values);
  }

  async foreignKey(table: string, foreignTable: string): Promise<ForeignKey> {
    const cacheKey = `${table}->${foreignTable}`;
    const cached = this.foreignKeys.get(cacheKey);
    if (cached) return cached;
    const { rows } = await this.executor.query<{
      column_name: string;
      foreign_column: string;
    }>(FOREIGN_KEY_SQL, [table, foreignTable]);
    if (rows.length !== 1) {
      throw new Error(
        `Expected exactly one foreign key from ${table} to ${foreignTable}, found ${rows.length}.`,
      );
    }
    const key = {
      column: rows[0].column_name,
      foreignColumn: rows[0].foreign_column,
    };
    this.foreignKeys.set(cacheKey, key);
    return key;
  }

  from(table: string) {
    identifier(table);
    return {
      select: (columns = '*') => new SelectQuery(this, table, columns),
      update: (values: DatabaseRow) => new UpdateQuery(this, table, values),
      upsert: (
        values: DatabaseRow | DatabaseRow[],
        options: { onConflict?: string; ignoreDuplicates?: boolean } = {},
      ) =>
        new WriteQuery(this, (parameters, returning) =>
          this.buildUpsert(table, values, options, parameters, returning),
        ),
    };
  }

  rpc(
    name: string,
    parameters: Record<string, unknown> = {},
  ): PromiseLike<DatabaseResult<unknown>> {
    const run = async (): Promise<DatabaseResult<unknown>> => {
      try {
        const values = new Parameters();
        const call = Object.entries(parameters)
          .map(([key, value]) => `${identifier(key)} => ${values.add(value)}`)
          .join(', ');
        // Parameters are sent untyped so Postgres resolves each one from the
        // function signature, the way PostgREST's JSON body does.
        const sql = `select ${identifier(name)}(${call}) as result`;
        const { rows } = await this.execute<{ result: unknown }>(
          sql,
          values.values,
        );
        return { data: rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: failure(error) };
      }
    };
    return { then: (resolve, reject) => run().then(resolve, reject) };
  }

  private buildUpsert(
    table: string,
    values: DatabaseRow | DatabaseRow[],
    options: { onConflict?: string; ignoreDuplicates?: boolean },
    parameters: Parameters,
    returning?: string,
  ) {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0)
      throw new Error('upsert() requires at least one row.');
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (columns.length === 0) throw new Error('upsert() requires columns.');
    const tuples = rows.map(
      (row) =>
        `(${columns
          .map((column) =>
            Object.hasOwn(row, column)
              ? parameters.add(row[column])
              : 'default',
          )
          .join(', ')})`,
    );
    const conflictColumns = (options.onConflict ?? '')
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    let conflict = '';
    if (conflictColumns.length > 0) {
      const updates = columns
        .filter((column) => !conflictColumns.includes(column))
        .map(
          (column) => `${identifier(column)} = excluded.${identifier(column)}`,
        );
      conflict =
        options.ignoreDuplicates || updates.length === 0
          ? ` on conflict (${conflictColumns.map(identifier).join(', ')}) do nothing`
          : ` on conflict (${conflictColumns
              .map(identifier)
              .join(', ')}) do update set ${updates.join(', ')}`;
    }
    const returned = returning
      ? ` returning ${
          returning.trim() === '*'
            ? '*'
            : splitTopLevel(returning).map(identifier).join(', ')
        }`
      : '';
    return `insert into ${identifier(table)} (${columns
      .map(identifier)
      .join(', ')}) values ${tuples.join(', ')}${conflict}${returned}`;
  }
}
