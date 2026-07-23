import 'dotenv/config';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { closeAuthDatabase, migrateAuthDatabase } from '../src/server/auth-service.js';
import { id, openDatabase, type Db } from '../src/server/db.js';

const execFileAsync = promisify(execFile);

const APP_TABLES = [
  'workspaces', 'users', 'sessions', 'workspace_settings', 'connections', 'webhook_events', 'source_records',
  'clients', 'contact_identities', 'opportunities', 'projects', 'contracts', 'contract_clauses', 'scope_items',
  'commitments', 'deliverables', 'milestones', 'invoices', 'payments', 'messages', 'recommendations',
  'recommendation_evidence', 'proof_packs', 'proof_pack_items', 'actions', 'automation_rules', 'approvals',
  'recommendation_outcomes', 'audit_events'
] as const;
const AUTH_TABLES = ['user', 'account', 'session', 'verification'] as const;

type ExportPayload = {
  source: string;
  snapshot: string;
  tables: Record<string, { columns: string[]; rows: Array<Record<string, unknown>> }>;
};

type ReportRow = { source: string; table: string; rows: number; inserted: number; conflicts: number; ignoredColumns: string[] };

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const allowConflicts = args.includes('--allow-conflicts');
const appSource = resolve(option('--app', 'data/trevra.db'));
const authSource = resolve(option('--auth', 'data/trevra-auth.db'));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = resolve(option('--backup-dir', `data/sqlite-backup-${timestamp}`));

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point to the target PostgreSQL database');
await mkdir(backupDir, { recursive: true });

const exports: ExportPayload[] = [];
for (const [source, tables] of [[appSource, APP_TABLES], [authSource, AUTH_TABLES]] as const) {
  try {
    exports.push(await exportSqlite(source, resolve(backupDir, basename(source)), tables));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || String(error).includes('does not exist')) {
      console.warn(`Skipping missing source: ${source}`);
      continue;
    }
    throw error;
  }
}
if (exports.length === 0) throw new Error('No SQLite source database was found');

await migrateAuthDatabase();
const db = await openDatabase({ seedDemo: false });
try {
  const existingWorkspaces = await db.prepare('SELECT COUNT(*) AS count FROM workspaces').get<{ count: number }>();
  if (!dryRun && !allowConflicts && Number(existingWorkspaces?.count ?? 0) > 0) {
    throw new Error('Target PostgreSQL already contains workspaces. Use a fresh database or pass --allow-conflicts for a non-destructive merge.');
  }

  const report = dryRun
    ? await inspectExports(db, exports)
    : await db.transaction(async (tx) => {
        const rows = await importExports(tx, exports);
        const conflicts = rows.reduce((sum, row) => sum + row.conflicts, 0);
        if (conflicts > 0 && !allowConflicts) {
          throw new Error(`Migration found ${conflicts} conflicting rows. The transaction was rolled back; retry with a fresh database or --allow-conflicts.`);
        }
        await backfillRequiredWorkspaceData(tx);
        return rows;
      });

  printReport(report, backupDir, dryRun);
} finally {
  await Promise.allSettled([db.close(), closeAuthDatabase()]);
}

async function exportSqlite(source: string, snapshot: string, tables: readonly string[]): Promise<ExportPayload> {
  const { stdout } = await execFileAsync('python3', [
    resolve('scripts/sqlite-export.py'), '--source', source, '--snapshot', snapshot, '--tables', tables.join(',')
  ], { maxBuffer: 100 * 1024 * 1024 });
  return JSON.parse(stdout) as ExportPayload;
}

async function inspectExports(db: Db, exportsToInspect: ExportPayload[]): Promise<ReportRow[]> {
  const report: ReportRow[] = [];
  for (const payload of exportsToInspect) {
    for (const [table, source] of Object.entries(payload.tables)) {
      const targetColumns = await getTargetColumns(db, table);
      const common = source.columns.filter((column) => targetColumns.has(column));
      report.push({
        source: payload.source,
        table,
        rows: source.rows.length,
        inserted: 0,
        conflicts: 0,
        ignoredColumns: source.columns.filter((column) => !common.includes(column))
      });
    }
  }
  return report;
}

async function importExports(db: Db, exportsToImport: ExportPayload[]): Promise<ReportRow[]> {
  const report: ReportRow[] = [];
  for (const payload of exportsToImport) {
    for (const [table, source] of Object.entries(payload.tables)) {
      const targetColumns = await getTargetColumns(db, table);
      const columns = source.columns.filter((column) => targetColumns.has(column));
      const ignoredColumns = source.columns.filter((column) => !targetColumns.has(column));
      let inserted = 0;
      if (columns.length > 0) {
        const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`;
        for (const row of source.rows) {
          const values = columns.map((column) => decodeValue(row[column]));
          inserted += (await db.prepare(sql).run(...values)).changes;
        }
      }
      report.push({
        source: payload.source,
        table,
        rows: source.rows.length,
        inserted,
        conflicts: source.rows.length - inserted,
        ignoredColumns
      });
    }
  }
  return report;
}

async function getTargetColumns(db: Db, table: string): Promise<Set<string>> {
  const rows = await db.prepare(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=?
  `).all<{ column_name: string }>(table);
  if (rows.length === 0) throw new Error(`Target PostgreSQL table does not exist: ${table}`);
  return new Set(rows.map((row) => row.column_name));
}

async function backfillRequiredWorkspaceData(db: Db): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at)
    SELECT w.id, 'EUR', COALESCE(u.name,''), 'Europe/Zurich', CASE WHEN w.id='ws_demo' THEN 1 ELSE 0 END, ?, ?
    FROM workspaces w
    LEFT JOIN LATERAL (SELECT name FROM users WHERE workspace_id=w.id ORDER BY created_at LIMIT 1) u ON true
    ON CONFLICT(workspace_id) DO NOTHING
  `).run(now, now);

  const workspaces = await db.prepare('SELECT id FROM workspaces').all<{ id: string }>();
  const defaults = [
    ['stale_proposal', 'prepare', 0.85, 25000, 0, 1],
    ['overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
    ['scope_creep', 'suggest', 0.9, 5000, 0, 1],
    ['unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
  ] as const;
  for (const workspace of workspaces) {
    for (const rule of defaults) {
      await db.prepare(`
        INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,recommendation_type) DO NOTHING
      `).run(id('rule'), workspace.id, ...rule, now, now);
    }
  }

  const demo = await db.prepare('SELECT id FROM workspaces WHERE id=?').get<{ id: string }>('ws_demo');
  if (demo) {
    await db.prepare(`
      INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO NOTHING
    `).run('conn_demo_gmail', 'ws_demo', 'gmail', 'google-mail', 'demo-gmail', 'demo@trevra.local', 'connected', 1, now, now, now);
  }
}

function decodeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && '__base64' in value) {
    return Buffer.from(String((value as { __base64: unknown }).__base64), 'base64');
  }
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function printReport(report: ReportRow[], backups: string, isDryRun: boolean): void {
  console.table(report.filter((row) => row.rows > 0).map((row) => ({
    source: basename(row.source), table: row.table, rows: row.rows,
    inserted: isDryRun ? 'dry-run' : row.inserted, conflicts: row.conflicts,
    ignoredColumns: row.ignoredColumns.join(',') || '-'
  })));
  console.log(`Consistent SQLite snapshots: ${backups}`);
  console.log(isDryRun ? 'Dry run complete; PostgreSQL was not modified.' : 'SQLite to PostgreSQL migration committed successfully.');
}
