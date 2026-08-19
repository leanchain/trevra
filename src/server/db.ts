import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg, { type PoolClient, type QueryResultRow } from 'pg';

const { Client, Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

export const DEMO_WORKSPACE_ID = 'ws_demo';
export const DEMO_USER_ID = 'usr_demo';

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<pg.QueryResult<T>>;
}

/**
 * What one pooled handle may hold, and how it complains when it runs out.
 *
 * Carried on the handle instead of re-read from the environment at the point of
 * use, because two handles in one process legitimately want different numbers:
 * the test suite opens deliberately tiny pools, a CLI that runs three queries
 * has no business reserving ten connections, and the API behind Cloud Run has
 * to divide a fixed Cloud SQL budget by its own maximum instance count. Each
 * field is also an environment variable (see {@link openDatabase}) because pool
 * sizing is a property of the DEPLOYMENT, and source code cannot know it.
 */
export interface PoolLimits {
  /** `max` the pool was built with. Reported verbatim once it is reached. */
  max: number;
  /** How long a checkout waits for a free connection before giving up. */
  connectionTimeoutMs: number;
  /**
   * How long ONE checkout may last before the holder is named in the log.
   * 0 turns it off.
   */
  checkoutWarnMs: number;
}

const DEFAULT_POOL_LIMITS: PoolLimits = {
  max: 10,
  connectionTimeoutMs: 10_000,
  checkoutWarnMs: 15_000
};

export class Db {
  constructor(
    private readonly queryable: Queryable,
    private readonly pool: InstanceType<typeof Pool> | null = null,
    private readonly limits: PoolLimits = DEFAULT_POOL_LIMITS
  ) {}

  prepare(sql: string) {
    const text = normalizeSql(sql);
    return {
      get: async <T extends QueryResultRow = QueryResultRow>(
        ...params: unknown[]
      ): Promise<T | undefined> => {
        const result = await this.queryable.query<T>(text, params);
        return result.rows[0];
      },
      all: async <T extends QueryResultRow = QueryResultRow>(
        ...params: unknown[]
      ): Promise<T[]> => {
        const result = await this.queryable.query<T>(text, params);
        return result.rows;
      },
      run: async (...params: unknown[]): Promise<{ changes: number }> => {
        const result = await this.queryable.query(text, params);
        return { changes: result.rowCount ?? 0 };
      }
    };
  }

  async exec(sql: string): Promise<void> {
    await this.queryable.query(sql);
  }

  async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.pool)
      throw new Error('Transactions can only be started from a pooled database handle');
    return this.withConnection('transaction', async (client) => {
      try {
        await client.query('BEGIN');
        const result = await work(new Db(client, null, this.limits));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * Hold ONE pooled connection for the length of `work`.
   *
   * Exists so that everything which needs a session -- a transaction, and the
   * session-scoped advisory leases the automation sweep takes -- goes through a
   * single checkout path, and so that path can answer the question a hung
   * process never answers: WHO IS HOLDING THE CONNECTIONS. A pool that runs out
   * reports `timeout exceeded when trying to connect`, which names neither the
   * caller that waited nor the callers that did not give theirs back, and a
   * deployment reading that line learns only that something, somewhere, is
   * slow. The wrapper below turns both halves into text: the failure names the
   * waiting caller and the pool's census, and a checkout that outlives
   * `checkoutWarnMs` names the holder while it still holds it -- which is the
   * only moment the import loop doing 30,000 round trips inside one transaction
   * is identifiable from a log.
   *
   * `warnAfterMs` overrides the handle's default for work that is SUPPOSED to
   * hold a connection for a long time (the automation lease), so the watchdog
   * stays a signal rather than a line printed every cycle.
   */
  async withConnection<T>(
    purpose: string,
    work: (client: PoolClient) => Promise<T>,
    warnAfterMs?: number
  ): Promise<T> {
    const pool = this.pool;
    if (!pool)
      throw new Error('A connection can only be checked out from a pooled database handle');
    // Captured BEFORE the wait and deliberately left unthrown: building an
    // Error is cheap, rendering `.stack` is not, so the frames are formatted
    // only on the two paths that actually report them.
    const site = new Error('database checkout');
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw this.checkoutFailure(purpose, site, error);
    }
    const startedAt = Date.now();
    const warnMs = warnAfterMs ?? this.limits.checkoutWarnMs;
    const watchdog =
      warnMs > 0
        ? setTimeout(() => {
            console.warn(
              `PostgreSQL connection held ${Date.now() - startedAt}ms by "${purpose}" ` +
                `(max=${this.limits.max}, waiting=${pool.waitingCount}). Caller: ${callerFrames(site)}`
            );
          }, warnMs)
        : null;
    watchdog?.unref?.();
    try {
      return await work(client);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      client.release();
    }
  }

  /**
   * The pool census, at the moment the wait failed.
   *
   * Only rewrites a CONNECT TIMEOUT. Anything else -- a refused socket, a
   * password rejection -- is the driver's own error and is worth more as it
   * stands than wrapped in a story about pool sizing.
   */
  private checkoutFailure(purpose: string, site: Error, error: unknown): Error {
    const pool = this.pool;
    const message = error instanceof Error ? error.message : String(error);
    if (!pool || !/timeout/i.test(message))
      return error instanceof Error ? error : new Error(message);
    return new Error(
      `PostgreSQL pool exhausted: no connection for "${purpose}" within ${this.limits.connectionTimeoutMs}ms ` +
        `(max=${this.limits.max}, open=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount}). ` +
        `Raise DATABASE_POOL_MAX, or shorten the work holding the other connections. Caller: ${callerFrames(site)}`,
      { cause: error }
    );
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  getPool(): InstanceType<typeof Pool> {
    if (!this.pool) throw new Error('Pool is unavailable inside a transaction');
    return this.pool;
  }
}

/**
 * A pooled handle, and -- in every deployment that is not hosted -- whatever
 * migrating it takes to make the schema match this build.
 *
 * OPENING A DATABASE AND MIGRATING ONE ARE TWO DIFFERENT JOBS, and this used to
 * be one. Every process that called this ran the whole migration set on the way
 * up: the API, the worker, both CLIs, the reset script and every test file. In
 * a single-node self-host that is a convenience with no downside -- there is one
 * process, and it is the one that should be applying schema. In a hosted,
 * multi-tenant deployment it is a boot-time race across every replica for a
 * privilege exactly one job should hold, and a schema change that takes minutes
 * is a rolling crashloop rather than a deploy.
 *
 * So the two jobs are split, and the split is made on `TREVRA_DEPLOYMENT_MODE`
 * -- the flag that already means "this is not one operator's machine":
 *
 *   local (default) -- apply pending migrations here, exactly as before, so
 *                      `npm run dev` and `npm test` need no extra step;
 *   hosted          -- VERIFY and refuse. A pod whose schema is behind the
 *                      build it is running says so and dies, instead of
 *                      silently mutating a shared production schema during a
 *                      health check. `npm run db:migrate` is the job that does
 *                      it, once, before the rollout.
 *
 * `DATABASE_AUTO_MIGRATE` forces either answer for the deployment that is an
 * exception to its own mode; `autoMigrate` does the same for one call.
 */
/**
 * Migrate-check + catalog seed (skills/channels/playbooks/module registry),
 * run at most ONCE per connection string for this process's lifetime.
 *
 * WHY: every one of these is idempotent and derived from static, in-process
 * registries (skill/channel/playbook manifests) that do not change between
 * two `openDatabase()` calls in the same run -- but `seedSkills`/
 * `seedChannels`/`seedPlaybooks` each loop one `await` per row, and
 * `seedBuiltinModuleRegistry` re-derives a JSON schema (`zodToJsonSchema`)
 * for every skill's input AND output. Re-running all of that on every test's
 * `beforeEach` (a common pattern: dozens of test files call `openDatabase()`
 * per test, not per file) was costing 40-60+ sequential round trips per test
 * for work whose result cannot have changed since the last call. Memoizing
 * it here sped up the affected files 2-3x with no behavior change: the
 * pending-migration check and every seed still runs, exactly once, before
 * anything can read from a freshly-opened connection to this database.
 *
 * A rejected attempt is evicted, not cached: a transient failure (e.g. a
 * migration that legitimately failed) must not be replayed as a cached
 * rejection for the rest of the process on a database that could still
 * recover (e.g. `db:migrate` runs, then a retry).
 */
const catalogSeeded = new Map<string, Promise<void>>();

async function ensureCatalogSeeded(
  db: Db,
  connectionString: string,
  migrationsPath: string,
  autoMigrate: boolean | undefined
): Promise<void> {
  const cached = catalogSeeded.get(connectionString);
  if (cached) return cached;

  const task = (async () => {
    // One cheap read before anything else: on the boot that has nothing to do --
    // which is every boot after the first -- this is the whole cost, and no
    // migration connection is opened at all.
    const pending = await pendingMigrations(db, migrationsPath);
    if (pending.length > 0) {
      if (autoMigrate ?? autoMigrateOnBoot())
        await runMigrations({ connectionString, migrationsPath });
      else
        throw new Error(
          `Database schema is behind this build: ${pending.length} migration(s) not applied ` +
            `(${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', ...' : ''}). ` +
            'A hosted deployment applies migrations as a job -- `npm run db:migrate` -- before the rollout, not on pod boot. ' +
            'Set DATABASE_AUTO_MIGRATE=true to apply them from here instead.'
        );
    }

    const [{ seedSkills }, { seedChannels }, { seedPlaybooks }] = await Promise.all([
      import('./skills/registry.js'),
      import('./channels/registry.js'),
      import('./playbooks/registry.js')
    ]);
    await seedSkills(db);
    await seedChannels(db);
    await seedPlaybooks(db);
    const [{ seedBuiltinModuleRegistry }, { listSkills }, { zodToJsonSchema }] = await Promise.all([
      import('./registry/service.js'),
      import('./skills/registry.js'),
      import('zod-to-json-schema')
    ]);
    let builtinSbom: Record<string, unknown> = {};
    for (const candidate of [
      'public/catalog/trevra.sbom.cdx.json',
      'dist/catalog/trevra.sbom.cdx.json'
    ]) {
      try {
        builtinSbom = JSON.parse(await readFile(resolve(candidate), 'utf8')) as Record<
          string,
          unknown
        >;
        break;
      } catch {
        /* optional before catalog build */
      }
    }
    await seedBuiltinModuleRegistry(
      db,
      listSkills().map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        sideEffect: manifest.sideEffect,
        requiresApproval: manifest.requiresApproval,
        inputSchema: zodToJsonSchema(manifest.inputSchema, {
          target: 'jsonSchema7',
          $refStrategy: 'none'
        }) as Record<string, unknown>,
        outputSchema: zodToJsonSchema(manifest.outputSchema, {
          target: 'jsonSchema7',
          $refStrategy: 'none'
        }) as Record<string, unknown>
      })),
      builtinSbom
    );
  })();

  catalogSeeded.set(connectionString, task);
  task.catch(() => catalogSeeded.delete(connectionString));
  return task;
}

export async function openDatabase(
  options: {
    connectionString?: string;
    seedDemo?: boolean;
    maxConnections?: number;
    connectionTimeoutMs?: number;
    statementTimeoutMs?: number;
    checkoutWarnMs?: number;
    autoMigrate?: boolean;
    migrationsPath?: string;
  } = {}
): Promise<Db> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required; Trevra only supports PostgreSQL');

  const limits: PoolLimits = {
    max: options.maxConnections ?? envInt('DATABASE_POOL_MAX', DEFAULT_POOL_LIMITS.max),
    connectionTimeoutMs:
      options.connectionTimeoutMs ??
      envInt('DATABASE_CONNECT_TIMEOUT_MS', DEFAULT_POOL_LIMITS.connectionTimeoutMs),
    checkoutWarnMs:
      options.checkoutWarnMs ??
      envInt('DATABASE_POOL_CHECKOUT_WARN_MS', DEFAULT_POOL_LIMITS.checkoutWarnMs)
  };
  const pool = new Pool({
    connectionString,
    max: limits.max,
    idleTimeoutMillis: envInt('DATABASE_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: limits.connectionTimeoutMs,
    statement_timeout:
      options.statementTimeoutMs ?? envInt('DATABASE_STATEMENT_TIMEOUT_MS', 30_000),
    application_name: process.env.DATABASE_APPLICATION_NAME ?? 'trevra'
  });
  pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));
  const db = new Db(pool, pool, limits);
  const migrationsPath = options.migrationsPath ?? migrationDirectory();
  try {
    await ensureCatalogSeeded(db, connectionString, migrationsPath, options.autoMigrate);
  } catch (error) {
    // Refusing to boot must not leak the pool it refused with: the CLI and the
    // test suite both keep running after catching this.
    await pool.end();
    throw error;
  }
  if (options.seedDemo ?? process.env.NODE_ENV !== 'production') await seedDemo(db);
  return db;
}

/* ---------------------------------------------------------------------------
 * Migrations.
 *
 * See migrations/README.md for the rules a migration FILE has to follow; this
 * is the runner behind them.
 * ------------------------------------------------------------------------ */

const MIGRATION_LOCK_NAME = 'trevra-schema-migrations';

/**
 * How a file says "do not wrap me in a transaction".
 *
 * A line of its own, anywhere in the file, exactly:
 *
 *     -- trevra:no-transaction
 *
 * A comment because it must remain a valid SQL file that `psql -f` can also
 * run, and a whole line because a marker that could appear inside a string
 * literal would be a marker that fires by accident.
 */
const NO_TRANSACTION_MARKER = /^[ \t]*--[ \t]*trevra:no-transaction[ \t]*$/m;

export function migrationDirectory(): string {
  return resolve(process.env.MIGRATIONS_PATH ?? 'migrations');
}

async function migrationFileNames(migrationsPath: string): Promise<string[]> {
  return (await readdir(migrationsPath)).filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Should this process apply migrations while opening a database?
 *
 * Local says yes because a self-hoster's `npm start` IS the migration job, and
 * making them run a second command before the first boot buys nothing. Hosted
 * says no for the reason in {@link openDatabase}. The explicit variable wins
 * over both, in either direction.
 */
function autoMigrateOnBoot(): boolean {
  const explicit = process.env.DATABASE_AUTO_MIGRATE;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env.TREVRA_DEPLOYMENT_MODE !== 'hosted';
}

/**
 * Migration files on disk that this database has not recorded.
 *
 * Reads through whatever handle it is given, so the boot path can ask it over
 * the ordinary pool (cheap, no privileges, no locks) and the migration runner
 * can ask it again over its own connection once it holds the lock.
 */
export async function pendingMigrations(
  db: Db,
  migrationsPath: string = migrationDirectory()
): Promise<string[]> {
  const files = await migrationFileNames(migrationsPath);
  return pendingFrom(files, async (sql) => db.prepare(sql).all<{ name: string }>());
}

async function pendingFrom(
  files: string[],
  all: (sql: string) => Promise<Array<Record<string, unknown>>>
): Promise<string[]> {
  // `to_regclass` rather than a catalogue join or a caught error: on a database
  // that has never been migrated the table does not exist, and asking for it
  // inside a transaction would abort that transaction rather than return false.
  const [registry] = await all("SELECT to_regclass('public.schema_migrations') AS reg");
  if (!registry?.reg) return files;
  const applied = new Set(
    (await all('SELECT name FROM schema_migrations')).map((row) => String(row.name))
  );
  return files.filter((name) => !applied.has(name));
}

/**
 * Apply every pending migration, on a connection built for exactly that.
 *
 * FOUR THINGS THIS DOES THAT THE OLD ONE-TRANSACTION-FOR-EVERYTHING PATH COULD
 * NOT, each of which was a way for a hosted deployment to lose a schema change:
 *
 *   1. NO STATEMENT TIMEOUT. The request pool caps every statement at 30s so a
 *      runaway query cannot pin a connection; a data-rewriting migration over a
 *      few million rows legitimately runs longer than that. Sharing the pool
 *      meant the cancel arrived mid-migration, rolled the transaction back, and
 *      crashlooped the process with nothing applied. This connection has no
 *      statement timeout and is used for nothing else.
 *   2. A SHORT `lock_timeout`. A migration that needs an AccessExclusiveLock
 *      behind live traffic should FAIL FAST and be retried in a quieter minute.
 *      Queueing for that lock is worse than failing: PostgreSQL makes every
 *      query arriving after the waiter queue behind it too, so one waiting
 *      ALTER TABLE stalls the whole tenant base until it gets in.
 *   3. ONE TRANSACTION PER FILE. Files commit as they pass, so a failure at
 *      file 9 leaves 1-8 applied and recorded, and the retry resumes there
 *      instead of redoing an hour of rewriting. It also releases each file's
 *      locks at that file's COMMIT rather than holding every lock taken by the
 *      whole range until the last one lands.
 *   4. A NON-TRANSACTIONAL LANE. `CREATE INDEX CONCURRENTLY` -- the only way to
 *      add an index to a live table without blocking writes on it -- cannot run
 *      inside a transaction block at all, so with one transaction around
 *      everything it was permanently unavailable. See NO_TRANSACTION_MARKER.
 *
 * The advisory lock is SESSION scoped rather than transaction scoped, because
 * with one transaction per file a transaction-scoped lock would be dropped
 * after the first one and replicas 2..N would start applying file 2 alongside
 * replica 1.
 */
export async function runMigrations(
  options: {
    connectionString?: string;
    migrationsPath?: string;
    lockTimeoutMs?: number;
    lockWaitMs?: number;
  } = {}
): Promise<{ applied: string[] }> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required; Trevra only supports PostgreSQL');
  const migrationsPath = options.migrationsPath ?? migrationDirectory();
  const lockTimeoutMs =
    options.lockTimeoutMs ?? envInt('DATABASE_MIGRATION_LOCK_TIMEOUT_MS', 10_000);
  const lockWaitMs = options.lockWaitMs ?? envInt('DATABASE_MIGRATION_LOCK_WAIT_MS', 120_000);
  const files = await migrationFileNames(migrationsPath);
  const applied: string[] = [];

  // A Client, not a Pool: session-scoped advisory locks belong to ONE session,
  // and a pool is free to hand the unlock to a different connection than the
  // one that took the lock.
  const client = new Client({ connectionString, application_name: 'trevra-migrate' });
  await client.connect();
  const all = async (sql: string, values?: unknown[]) => (await client.query(sql, values)).rows;
  let locked = false;
  try {
    await client.query(
      "SELECT set_config('statement_timeout','0',false), set_config('idle_in_transaction_session_timeout','0',false), set_config('lock_timeout',$1,false)",
      [String(lockTimeoutMs)]
    );
    locked = await acquireMigrationLock(client, lockWaitMs, () => pendingFrom(files, all));
    // Not an error: somebody else finished the work while this process waited,
    // which is the ordinary outcome for replicas 2..N of a rollout.
    if (!locked) return { applied };

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const pending = new Set(await pendingFrom(files, all));
    for (const name of files) {
      if (!pending.has(name)) continue;
      const sql = await readFile(resolve(migrationsPath, name), 'utf8');
      if (NO_TRANSACTION_MARKER.test(sql)) await applyWithoutTransaction(client, name, sql);
      else await applyInTransaction(client, name, sql);
      applied.push(name);
    }
  } finally {
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_NAME])
        .catch(() => undefined);
    await client.end();
  }
  return { applied };
}

/**
 * Take the migration lock, or establish that nobody needs it any more.
 *
 * `pg_try_advisory_lock` in a poll rather than the blocking `pg_advisory_lock`,
 * for one reason: an advisory lock wait is not affected by `lock_timeout`, so
 * the blocking call is an unbounded wait with a statement timeout of zero --
 * exactly the hang a boot path must not contain. Polling also gives the loop
 * somewhere to ask the only question that matters while it waits: is there
 * still anything left to apply? Once the answer is no, this returns false and
 * the caller proceeds with a schema somebody else brought up to date.
 */
async function acquireMigrationLock(
  client: InstanceType<typeof Client>,
  waitMs: number,
  pending: () => Promise<string[]>
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [MIGRATION_LOCK_NAME]
    );
    if (rows[0]?.locked) return true;
    if ((await pending()).length === 0) return false;
    if (Date.now() >= deadline) {
      throw new Error(
        `Another process has held the Trevra migration lock for ${waitMs}ms and migrations are still pending. ` +
          'Check for a stuck migration job before retrying (DATABASE_MIGRATION_LOCK_WAIT_MS raises the wait).'
      );
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
}

async function applyInTransaction(
  client: InstanceType<typeof Client>,
  name: string,
  sql: string
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw migrationFailure(name, error);
  }
}

/**
 * The non-transactional lane, one statement per round trip.
 *
 * SPLIT RATHER THAN SENT AS ONE STRING, and that is the whole trick: several
 * statements in a single simple-query message are executed by PostgreSQL in one
 * implicit transaction block, so `CREATE INDEX CONCURRENTLY` would still be
 * refused with "cannot run inside a transaction block" even with no BEGIN in
 * sight.
 *
 * NOTHING IS ROLLED BACK HERE -- there is nothing to roll back to. A file that
 * fails halfway leaves its earlier statements applied and no row in
 * `schema_migrations`, so the retry runs it again from the top. That is why
 * migrations/README.md requires every statement in this lane to be idempotent
 * (`IF NOT EXISTS`), and why the lane is for index builds rather than for data
 * rewrites.
 */
async function applyWithoutTransaction(
  client: InstanceType<typeof Client>,
  name: string,
  sql: string
): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    try {
      await client.query(statement);
    } catch (error) {
      throw migrationFailure(name, error, statement);
    }
  }
  await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
}

function migrationFailure(name: string, error: unknown, statement?: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const where = statement ? ` (statement: ${statement.split('\n')[0].slice(0, 120)})` : '';
  return new Error(`Migration ${name} failed: ${detail}${where}`, { cause: error });
}

/**
 * Cut a SQL file into statements at top-level semicolons.
 *
 * Written out rather than split on `/;/` because every quoting form in the tree
 * contains semicolons that are not statement ends: string literals, quoted
 * identifiers, `/* *\/` blocks (which PostgreSQL nests), and above all the
 * dollar-quoted bodies that every `DO $$ ... $$` and trigger function in
 * migrations/ is written with. Backslashes are NOT treated as escapes inside
 * single quotes, matching `standard_conforming_strings=on` -- PostgreSQL's
 * default since 9.1 and what these files are written against.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === char && sql[cursor + 1] === char) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }
    const dollar = char === '$' ? /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index)) : null;
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, index + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === ';') {
      pushStatement(statements, current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  pushStatement(statements, current);
  return statements;
}

/** Keeps comment-only tails (the licence header, the trailing newline) out. */
function pushStatement(statements: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (!trimmed) return;
  const stripped = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (stripped) statements.push(trimmed);
}

/**
 * An integer from the environment, or the default.
 *
 * `Number('')` is 0 and `Number('nonsense')` is NaN, and both used to reach the
 * pool as a setting: an empty variable in a compose file meant "no connections
 * and no timeouts", which is a hang rather than a misconfiguration message.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function seedDemo(db: Db): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM workspaces WHERE id=?')
    .get<{ id: string }>(DEMO_WORKSPACE_ID);
  if (existing) return;
  const now = new Date();
  const iso = (daysAgo = 0) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(DEMO_WORKSPACE_ID, 'Northstar Studio', iso(90));
    await tx
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(DEMO_USER_ID, DEMO_WORKSPACE_ID, 'alex@northstar.studio', 'Alex Morgan', iso(90));
    await tx
      .prepare(
        'INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(DEMO_WORKSPACE_ID, 'EUR', 'Alex', 'Europe/Zurich', 1, iso(90), iso());
    await tx
      .prepare(
        'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'conn_demo_gmail',
        DEMO_WORKSPACE_ID,
        'gmail',
        'google-mail',
        'demo-gmail',
        'alex@northstar.studio',
        'connected',
        1,
        iso(),
        iso(90),
        iso()
      );

    const clients = [
      ['cl_acme', 'Acme Labs', 'Maya Chen', 'maya@acme.example', 'active', 15000, 'EUR', iso(1)],
      [
        'cl_orbit',
        'Orbit Health',
        'Jonas Keller',
        'jonas@orbit.example',
        'prospect',
        8000,
        'EUR',
        iso(9)
      ],
      ['cl_luma', 'Luma Works', 'Sofia Rossi', 'sofia@luma.example', 'active', 7200, 'EUR', iso(4)]
    ] as const;
    for (const client of clients) {
      await tx
        .prepare(
          'INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          client[0],
          DEMO_WORKSPACE_ID,
          client[1],
          client[2],
          client[3],
          client[4],
          client[5],
          client[6],
          client[7],
          iso(80)
        );
      await tx
        .prepare(
          'INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(id('ident'), DEMO_WORKSPACE_ID, client[0], 'email', 'email', client[3], iso(80));
    }

    await tx
      .prepare(
        'INSERT INTO opportunities (id,workspace_id,client_id,title,value,currency,status,proposal_sent_at,expected_response_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'opp_orbit',
        DEMO_WORKSPACE_ID,
        'cl_orbit',
        'Brand strategy engagement',
        8000,
        'EUR',
        'proposal_sent',
        iso(9),
        iso(5),
        iso(14)
      );
    await tx
      .prepare(
        'INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'prj_acme',
        DEMO_WORKSPACE_ID,
        'cl_acme',
        'Acme website launch',
        'active',
        15000,
        'EUR',
        iso(50)
      );
    await tx
      .prepare(
        'INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'prj_luma',
        DEMO_WORKSPACE_ID,
        'cl_luma',
        'Luma positioning sprint',
        'delivered',
        7200,
        'EUR',
        iso(35)
      );
    await tx
      .prepare(
        'INSERT INTO contracts (id,workspace_id,client_id,project_id,title,status,signed_at,effective_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'contract_acme',
        DEMO_WORKSPACE_ID,
        'cl_acme',
        'prj_acme',
        'Acme website statement of work',
        'signed',
        iso(52),
        iso(50),
        iso(52)
      );
    await tx
      .prepare(
        'INSERT INTO contract_clauses (id,contract_id,clause_type,title,content,value_number,unit,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'clause_acme_revision',
        'contract_acme',
        'change_order',
        'Additional deliverables',
        'Additional pages and deliverables require written approval and are priced separately.',
        750,
        'per landing page',
        iso(52)
      );
    await tx
      .prepare(
        'INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(
        'scope_acme_1',
        'prj_acme',
        'One homepage and one product landing page',
        1,
        null,
        iso(50)
      );
    await tx
      .prepare(
        'INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(
        'scope_acme_2',
        'prj_acme',
        'Additional landing pages priced separately',
        0,
        750,
        iso(50)
      );
    await tx
      .prepare(
        'INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(
        'scope_luma_1',
        'prj_luma',
        'Positioning workshop and final strategy deck',
        1,
        null,
        iso(35)
      );
    await tx
      .prepare(
        'INSERT INTO milestones (id,project_id,name,amount,currency,status,delivered_at,invoiced_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'mil_luma_final',
        'prj_luma',
        'Final strategy delivery',
        2400,
        'EUR',
        'delivered',
        iso(2),
        null,
        iso(35)
      );
    await tx
      .prepare(
        'INSERT INTO deliverables (id,workspace_id,project_id,name,status,delivered_at,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        'del_luma_deck',
        DEMO_WORKSPACE_ID,
        'prj_luma',
        'Final positioning deck',
        'delivered',
        iso(2),
        iso(35)
      );
    await tx
      .prepare(
        'INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'inv_acme_104',
        DEMO_WORKSPACE_ID,
        'cl_acme',
        'prj_acme',
        'INV-104',
        1850,
        'EUR',
        'sent',
        iso(25),
        iso(7),
        null,
        iso(25)
      );
    await tx
      .prepare(
        'INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'msg_acme_extra',
        DEMO_WORKSPACE_ID,
        'cl_acme',
        'prj_acme',
        'inbound',
        'A few additions',
        'Could you also create two additional landing pages for the partner campaigns? We would love to include those in this round.',
        iso(1),
        iso(1)
      );
    await tx
      .prepare(
        'INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'msg_orbit_proposal',
        DEMO_WORKSPACE_ID,
        'cl_orbit',
        null,
        'outbound',
        'Orbit brand strategy proposal',
        'Hi Jonas, attached is the €8,000 proposal. I can reserve an August start if you confirm this week.',
        iso(9),
        iso(9)
      );
    await tx
      .prepare(
        'INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'msg_luma_delivery',
        DEMO_WORKSPACE_ID,
        'cl_luma',
        'prj_luma',
        'outbound',
        'Final strategy deck',
        'Hi Sofia, the final positioning deck and workshop summary are attached. This completes the final milestone.',
        iso(2),
        iso(2)
      );

    const defaults = [
      ['rule_stale', 'stale_proposal', 'prepare', 0.85, 25000, 0, 1],
      ['rule_overdue', 'overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
      ['rule_scope', 'scope_creep', 'suggest', 0.9, 5000, 0, 1],
      ['rule_unbilled', 'unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
    ] as const;
    for (const rule of defaults) {
      await tx
        .prepare(
          'INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          rule[0],
          DEMO_WORKSPACE_ID,
          rule[1],
          rule[2],
          rule[3],
          rule[4],
          rule[5],
          rule[6],
          iso(30),
          iso()
        );
    }
  });
}

export async function resetDemoData(db: Db): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(DEMO_WORKSPACE_ID);
  await seedDemo(db);
}

/**
 * The first few frames outside this file, as one line.
 *
 * db.ts's own frames are dropped because "the pool ran out inside the pool" is
 * not information; what a deployment needs is the route handler or the loop
 * that asked. Three frames because one is often a generic helper.
 */
function callerFrames(site: Error, depth = 3): string {
  const frames = (site.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith('at ') &&
        !/[\\/]server[\\/]db\.(?:ts|js)/.test(line) &&
        !line.includes('node:internal')
    );
  return frames.slice(0, depth).join(' <- ') || 'unknown caller';
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function normalizeSql(sql: string): string {
  let index = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++index}`);
}
