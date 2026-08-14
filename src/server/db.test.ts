import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
