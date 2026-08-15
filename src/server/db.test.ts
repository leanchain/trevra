import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, runMigrations, splitSqlStatements } from './db.js';

/**
 * The migration runner and the pool, against real PostgreSQL.
 *
 * Every migration test gets its OWN database rather than the shared test one:
 * these apply deliberately broken and deliberately slow migration files, and
 * `schema_migrations` in the suite's database is not a place to leave debris.
 */
const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

async function withScratchDatabase<T>(work: (url: string) => Promise<T>): Promise<T> {
  const name = `trevra_scratch_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  try {
    return await work(url.toString());
  } finally {
    const cleanup = new pg.Client({ connectionString: baseUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await cleanup.end(); }
  }
}

async function withMigrationFiles<T>(files: Record<string, string>, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'trevra-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql, 'utf8');
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function inspect(url: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return (await client.query(sql)).rows; } finally { await client.end(); }
}

describe('migration runner', () => {
  it('commits each file on its own, so a failure keeps the files before it', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({
        '001_first.sql': 'CREATE TABLE mig_first (id TEXT PRIMARY KEY);',
        '002_broken.sql': 'CREATE TABLE mig_second (id TEXT PRIMARY KEY);\nSELECT 1/0;'
      }, async (dir) => {
        await expect(runMigrations({ connectionString: url, migrationsPath: dir })).rejects.toThrow(/Migration 002_broken\.sql failed/);

        const tables = await inspect(url, "SELECT to_regclass('public.mig_first') AS first, to_regclass('public.mig_second') AS second");
        expect(tables[0].first).toBe('mig_first');
        expect(tables[0].second).toBeNull();

        const applied = await inspect(url, 'SELECT name FROM schema_migrations ORDER BY name');
        expect(applied.map((row) => row.name)).toEqual(['001_first.sql']);
      });
    });
  });

  it('resumes at the file that failed', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({ '001_first.sql': 'CREATE TABLE mig_first (id TEXT PRIMARY KEY);' }, async (dir) => {
        expect((await runMigrations({ connectionString: url, migrationsPath: dir })).applied).toEqual(['001_first.sql']);
        await writeFile(join(dir, '002_second.sql'), 'CREATE TABLE mig_second (id TEXT PRIMARY KEY);', 'utf8');
        expect((await runMigrations({ connectionString: url, migrationsPath: dir })).applied).toEqual(['002_second.sql']);
      });
    });
  });

  it('runs migrations on a connection with no statement timeout', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({
        // The DO block is the assertion: the request pool caps statements at 30s
        // and a data-rewriting migration is allowed to outlast that, so the
        // migration connection must report no cap at all. The sleep is the same
        // claim made the slow way.
        '001_slow.sql': [
          'DO $$ BEGIN',
          "  IF current_setting('statement_timeout') <> '0' THEN",
          "    RAISE EXCEPTION 'migration ran with statement_timeout=%', current_setting('statement_timeout');",
          '  END IF;',
          'END $$;',
          'SELECT pg_sleep(0.4);',
          'CREATE TABLE mig_slow (id TEXT PRIMARY KEY);'
        ].join('\n')
      }, async (dir) => {
        expect((await runMigrations({ connectionString: url, migrationsPath: dir })).applied).toEqual(['001_slow.sql']);
      });
    });
  });

  it('runs CREATE INDEX CONCURRENTLY when the file opts out of the transaction', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({
        '001_table.sql': 'CREATE TABLE mig_rows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL);',
        '002_index.sql': [
          '-- trevra:no-transaction',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mig_rows_tenant ON mig_rows (tenant);'
        ].join('\n')
      }, async (dir) => {
        expect((await runMigrations({ connectionString: url, migrationsPath: dir })).applied).toEqual(['001_table.sql', '002_index.sql']);
        const indexes = await inspect(url, "SELECT indexname FROM pg_indexes WHERE indexname='idx_mig_rows_tenant'");
        expect(indexes).toHaveLength(1);
      });
    });
  });

  it('still wraps a file that does not ask for the lane, which CONCURRENTLY cannot survive', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({
        '001_table.sql': 'CREATE TABLE mig_rows (id TEXT PRIMARY KEY, tenant TEXT NOT NULL);',
        '002_index.sql': 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mig_rows_tenant ON mig_rows (tenant);'
      }, async (dir) => {
        await expect(runMigrations({ connectionString: url, migrationsPath: dir }))
          .rejects.toThrow(/cannot run inside a transaction block/);
      });
    });
  });

  it('is a no-op the second time, and reports nothing applied', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({ '001_first.sql': 'CREATE TABLE mig_first (id TEXT PRIMARY KEY);' }, async (dir) => {
        await runMigrations({ connectionString: url, migrationsPath: dir });
        expect((await runMigrations({ connectionString: url, migrationsPath: dir })).applied).toEqual([]);
      });
    });
  });
});

/**
 * The one migration whose whole job is repairing a database somebody else broke.
 *
 * Every other migration is tested by the suite simply running it: the shared
 * test database is built from `migrations/` and a mistake shows up as a failing
 * feature test. This one is invisible that way -- a fresh database already has
 * the index, so the file is a no-op everywhere except on the drifted database
 * it exists for. So the drift is rebuilt here and the REAL file is run against
 * it.
 */
describe('073_workspace_secret_unique_key', () => {
  // The drifted shape, copied from the database that produced the 42P10: a
  // `scope_key` column that is in no migration in this repository, and the
  // unique index widened to include it.
  const drifted = [
    'CREATE TABLE workspace_secrets (',
    '  id TEXT PRIMARY KEY,',
    '  workspace_id TEXT NOT NULL,',
    '  kind TEXT NOT NULL,',
    '  ciphertext BYTEA NOT NULL,',
    "  scope_key TEXT NOT NULL DEFAULT 'default'",
    ');',
    'CREATE UNIQUE INDEX idx_workspace_secrets_kind_scope ON workspace_secrets(workspace_id, kind, scope_key);'
  ].join('\n');

  const upsert = [
    "INSERT INTO workspace_secrets (id, workspace_id, kind, ciphertext) VALUES ('wsec_2','w1','linkedin.password','\\x02')",
    'ON CONFLICT (workspace_id, kind) DO UPDATE SET ciphertext=EXCLUDED.ciphertext'
  ].join(' ');

  async function withRepair<T>(setup: string, work: (url: string) => Promise<T>): Promise<T> {
    const file = '073_workspace_secret_unique_key.sql';
    const sql = await readFile(resolve('migrations', file), 'utf8');
    return withScratchDatabase(async (url) =>
      withMigrationFiles({ '001_drift.sql': setup, [file]: sql }, async (dir) => {
        await runMigrations({ connectionString: url, migrationsPath: dir });
        return work(url);
      })
    );
  }

  it('restores the key the secret upsert infers on, so storing a credential works again', async () => {
    await withRepair(drifted, async (url) => {
      // THE ACTUAL FAILURE, not a proxy for it: this is the statement shape
      // `putWorkspaceSecret` sends, and before the repair it raised 42P10.
      await inspect(url, "INSERT INTO workspace_secrets (id, workspace_id, kind, ciphertext) VALUES ('wsec_1','w1','linkedin.password','\\x01')");
      await inspect(url, upsert);
      const rows = await inspect(url, 'SELECT id, ciphertext FROM workspace_secrets');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('wsec_1');
    });
  });

  it('leaves a database that already has the key exactly as it found it', async () => {
    const correct = [
      'CREATE TABLE workspace_secrets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, ciphertext BYTEA NOT NULL);',
      'CREATE UNIQUE INDEX idx_workspace_secrets_kind ON workspace_secrets(workspace_id, kind);'
    ].join('\n');
    await withRepair(correct, async (url) => {
      const indexes = await inspect(url, "SELECT indexname FROM pg_indexes WHERE tablename='workspace_secrets' ORDER BY indexname");
      expect(indexes.map((row) => row.indexname)).toEqual(['idx_workspace_secrets_kind', 'workspace_secrets_pkey']);
    });
  });

  it('refuses rather than picking, when two rows claim the same secret', async () => {
    const file = '073_workspace_secret_unique_key.sql';
    const sql = await readFile(resolve('migrations', file), 'utf8');
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({
        '001_drift.sql': [
          drifted,
          "INSERT INTO workspace_secrets (id, workspace_id, kind, ciphertext, scope_key) VALUES ('a','w1','linkedin.password','\\x01','default');",
          "INSERT INTO workspace_secrets (id, workspace_id, kind, ciphertext, scope_key) VALUES ('b','w1','linkedin.password','\\x02','other');"
        ].join('\n'),
        [file]: sql
      }, async (dir) => {
        await expect(runMigrations({ connectionString: url, migrationsPath: dir }))
          .rejects.toThrow(/holds 1 \(workspace_id, kind\) pair\(s\) with more than one row/);
      });
    });
  });
});

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons only', () => {
    const statements = splitSqlStatements([
      "INSERT INTO t (v) VALUES ('a;b');",
      'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;',
      '/* a ; comment */',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (v)'
    ].join('\n'));
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("INSERT INTO t (v) VALUES ('a;b')");
    expect(statements[1]).toBe('DO $$ BEGIN PERFORM 1; PERFORM 2; END $$');
    expect(statements[2]).toContain('CREATE INDEX CONCURRENTLY');
  });

  it('drops a comment-only file', () => {
    expect(splitSqlStatements('-- nothing to do here\n/* nor here */\n')).toEqual([]);
  });
});

describe('openDatabase', () => {
  it('refuses to boot a hosted pod against a schema behind the build', async () => {
    const previous = process.env.TREVRA_DEPLOYMENT_MODE;
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      await withScratchDatabase(async (url) => {
        await withMigrationFiles({ '001_first.sql': 'CREATE TABLE mig_first (id TEXT PRIMARY KEY);' }, async (dir) => {
          await expect(openDatabase({ connectionString: url, migrationsPath: dir, seedDemo: false }))
            .rejects.toThrow(/schema is behind this build: 1 migration\(s\) not applied \(001_first\.sql\)/);
          // Verified, not applied: the pod died, the schema did not move.
          const tables = await inspect(url, "SELECT to_regclass('public.mig_first') AS first");
          expect(tables[0].first).toBeNull();
        });
      });
    } finally {
      if (previous === undefined) delete process.env.TREVRA_DEPLOYMENT_MODE;
      else process.env.TREVRA_DEPLOYMENT_MODE = previous;
    }
  });

  it('applies pending migrations on boot outside hosted mode', async () => {
    await withScratchDatabase(async (url) => {
      await withMigrationFiles({ '001_first.sql': 'CREATE TABLE mig_first (id TEXT PRIMARY KEY);' }, async (dir) => {
        // autoMigrate without the seeds that follow it: this scratch database
        // has one table, not Trevra's schema. The boot path's decision is what
        // is under test, and it happens before any of them.
        await expect(openDatabase({ connectionString: url, migrationsPath: dir, seedDemo: false })).rejects.toThrow();
        const tables = await inspect(url, "SELECT to_regclass('public.mig_first') AS first");
        expect(tables[0].first).toBe('mig_first');
      });
    });
  });

  it('names the caller when the pool is exhausted, and while a connection is held too long', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await openDatabase({ maxConnections: 1, connectionTimeoutMs: 250, checkoutWarnMs: 50, seedDemo: false });
    let release = (): void => {};
    const held = db.transaction(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await expect(db.transaction(async () => undefined)).rejects.toThrow(/pool exhausted[\s\S]*max=1[\s\S]*db\.test\.ts/);
      expect(warn.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/connection held \d+ms by "transaction"[\s\S]*db\.test\.ts/);
    } finally {
      release();
      await held;
      warn.mockRestore();
      await db.close();
    }
  });
});
