/**
 * Take your ledger with you.
 *
 * docs/gtm-shell-shape.md §3.4 and §3.7, Wave B2. The landing page has sold
 * "Exportable ledger and evidence" as the headline reason to self-host while no
 * control to do it existed anywhere in the product. This module is the render
 * half of earning that sentence.
 *
 * NDJSON PER TABLE PLUS A MANIFEST, ZIPPED. Not CSV, and the reason is the word
 * "evidence" in the claim: a step carries `evidence_json`, `policy_decision_json`
 * and `approval_payload_hash`, a run carries nested input and output payloads,
 * and flattening any of that into columns discards exactly the part somebody
 * exports a ledger to keep. One JSON object per line, one file per source
 * table, and the nesting survives.
 *
 * The manifest publishes a sha256 per file. That is the same promise the
 * approval `SignedNote` already makes -- these bytes, this hash, check it
 * yourself -- and it is why the archive is rendered once and stored rather than
 * regenerated per download: a hash that names different bytes on the second
 * click pins nothing.
 *
 * EVERY QUERY IS SCOPED TO ONE WORKSPACE. There is no unscoped read in this
 * file and there must never be one. An export that hands a workspace another
 * workspace's runs is the worst bug this product could ship, and it would look
 * exactly like a working feature.
 */

import { createHash } from 'node:crypto';
import { id, type Db } from './db.js';
import { zipArchive, type ZipEntry } from './zip.js';

/**
 * What may be asked for. The names are the operator's vocabulary, not the
 * schema's -- "runs" is three tables, because a job Trevra ran, a playbook it
 * ran and a skill it ran are one thing to the person reading the file.
 */
export const LEDGER_EXPORT_SECTIONS = ['runs', 'steps', 'evidence', 'approvals', 'actions'] as const;
export type LedgerExportSection = (typeof LEDGER_EXPORT_SECTIONS)[number];

/** Default window, in days. Matches the analytics range the rest of the shell defaults to. */
export const LEDGER_EXPORT_DEFAULT_WINDOW_DAYS = 30;

/** A year. Beyond this the render stops being a download and becomes an outage. */
export const LEDGER_EXPORT_MAX_WINDOW_DAYS = 365;

/**
 * Rows per table, per export.
 *
 * lc-debt: the whole archive is built in memory, so this ceiling is what stands
 * between a busy workspace and the API process's heap. A file that hits it says
 * so IN THE MANIFEST (`truncated: true` plus the ceiling) rather than quietly
 * handing over a short ledger that looks complete -- a silently truncated audit
 * trail is worse than a refused one. Upgrade path: stream each table with a
 * server-side cursor straight into `zlib.createDeflateRaw` and out to the
 * response, which removes the ceiling instead of raising it.
 */
export const LEDGER_EXPORT_ROW_LIMIT = 50_000;

export interface LedgerExportFile {
  /** Path inside the archive. */
  name: string;
  /** The source table these rows came from, verbatim. */
  table: string;
  section: LedgerExportSection;
  rows: number;
  bytes: number;
  /** Hex sha256 of the file's bytes, as published in manifest.json. */
  sha256: string;
  /** True when {@link LEDGER_EXPORT_ROW_LIMIT} cut this table short. */
  truncated: boolean;
}

export interface LedgerExportRecord {
  id: string;
  windowDays: number;
  include: LedgerExportSection[];
  /** Rows per SOURCE TABLE, keyed by table name. */
  counts: Record<string, number>;
  /** Hex sha256 per FILE, keyed by file name. `manifest.json` is not in here -- it cannot hash itself. */
  sha256: Record<string, string>;
  filename: string;
  contentType: string;
  /** Size of the archive in bytes. */
  size: number;
  createdAt: string;
}

/**
 * What one file in the archive is read out of.
 *
 * `sql` takes exactly two bound parameters in this order -- workspace id, then
 * the window start -- unless `params` says otherwise. Every statement carries
 * the workspace scope in its own WHERE clause rather than relying on a caller
 * to have filtered first.
 */
interface LedgerSource {
  table: string;
  sql: string;
  params?: (workspaceId: string, since: string) => unknown[];
}

/**
 * `SELECT *` throughout, deliberately.
 *
 * A ledger export is supposed to hand over what the row actually says, and a
 * hand-listed column set would silently drop every column added after this file
 * was written -- which is the exact failure mode of an audit trail nobody
 * re-reads. It also keeps this module from breaking when a table it only reads
 * gains a column.
 */
const SOURCES: Record<LedgerExportSection, LedgerSource[]> = {
  runs: [
    {
      table: 'agent_runs',
      sql: `SELECT * FROM agent_runs WHERE workspace_id=? AND started_at >= ? ORDER BY started_at, id`
    },
    {
      table: 'playbook_runs',
      sql: `SELECT * FROM playbook_runs WHERE workspace_id=? AND created_at >= ? ORDER BY created_at, id`
    },
    {
      table: 'skill_runs',
      sql: `SELECT * FROM skill_runs WHERE workspace_id=? AND started_at >= ? ORDER BY started_at, id`
    }
  ],
  steps: [
    {
      // Carries its own workspace_id (migration 017 denormalised it precisely so
      // an audit query never has to join to find out whose data a step touched).
      table: 'agent_run_steps',
      sql: `SELECT * FROM agent_run_steps WHERE workspace_id=? AND created_at >= ? ORDER BY run_id, seq`
    },
    {
      // Does NOT, so the scope comes from the parent run. This is the file that
      // carries policy_decision_json and approval_payload_hash.
      table: 'playbook_step_runs',
      sql: `
        SELECT s.* FROM playbook_step_runs s
        JOIN playbook_runs r ON r.id=s.playbook_run_id
        WHERE r.workspace_id=? AND s.updated_at >= ?
        ORDER BY s.playbook_run_id, s.step_id, s.attempt
      `
    }
  ],
  evidence: [
    {
      // One row per evidence ITEM, lifted out of the two `evidence_json` arrays
      // that hold them, each tagged with where it came from. Exported as its own
      // file because "and evidence" is half the sentence on the landing page,
      // and burying it inside a step row makes it something you have to know to
      // go looking for.
      //
      // The jsonb_typeof guard is not paranoia about today's writers: the column
      // is only DEFAULT '[]', not CHECKed, and one non-array row would otherwise
      // fail the whole export with a Postgres type error rather than skipping
      // the row that is malformed.
      table: 'evidence',
      sql: `
        SELECT 'playbook_step' AS source, s.playbook_run_id AS run_id, s.id AS step_run_id,
               s.step_id AS step_id, item AS evidence
        FROM playbook_step_runs s
        JOIN playbook_runs r ON r.id=s.playbook_run_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.evidence_json)='array' THEN s.evidence_json ELSE '[]'::jsonb END
        ) AS item
        WHERE r.workspace_id=? AND s.updated_at >= ?
        UNION ALL
        SELECT 'skill_run' AS source, sr.id AS run_id, NULL AS step_run_id,
               NULL AS step_id, item AS evidence
        FROM skill_runs sr
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(sr.evidence_json)='array' THEN sr.evidence_json ELSE '[]'::jsonb END
        ) AS item
        WHERE sr.workspace_id=? AND sr.started_at >= ?
      `,
      params: (workspaceId, since) => [workspaceId, since, workspaceId, since]
    }
  ],
  approvals: [
    {
      table: 'playbook_approvals',
      sql: `SELECT * FROM playbook_approvals WHERE workspace_id=? AND created_at >= ? ORDER BY created_at, id`
    },
    {
      // `approvals` has no workspace_id of its own -- it hangs off an action.
      // The join IS the scope here, and dropping it would export every
      // workspace's approvals.
      table: 'approvals',
      sql: `
        SELECT a.* FROM approvals a
        JOIN actions ac ON ac.id=a.action_id
        WHERE ac.workspace_id=? AND a.created_at >= ?
        ORDER BY a.created_at, a.id
      `
    }
  ],
  actions: [
    {
      table: 'actions',
      sql: `SELECT * FROM actions WHERE workspace_id=? AND created_at >= ? ORDER BY created_at, id`
    },
    {
      // Dated the way every other window over this table is dated: when it
      // happened, falling back to its planned slot and then to when it was
      // filed. See linkedin/campaigns.ts, which buckets its series the same way.
      table: 'linkedin_actions',
      sql: `
        SELECT * FROM linkedin_actions
        WHERE workspace_id=? AND COALESCE(recorded_at, planned_for, created_at) >= ?
        ORDER BY COALESCE(recorded_at, planned_for, created_at), id
      `
    }
  ]
};

/**
 * The sentence the manifest carries about what a hash here does and does not
 * prove. An unsigned digest is an integrity check, not a signature, and saying
 * so is cheaper than being asked later.
 */
const MANIFEST_NOTES = [
  'One JSON object per line (NDJSON), one file per source table. Nested payloads -- step evidence, policy decisions, approval payload hashes -- are kept whole rather than flattened.',
  'Every sha256 below is the digest of that file exactly as it appears in this archive. It proves the file has not changed since Trevra rendered it; it is not a signature and does not prove who rendered it.',
  'Every row in this archive belongs to the workspace named above. Nothing else was read.'
];

/**
 * Render, store and describe one export.
 *
 * The bytes are written in the same call that produced them and are never
 * re-rendered: {@link readLedgerExport} serves what was stored, so the hashes in
 * manifest.json keep pointing at the file they were computed from.
 */
export async function createLedgerExport(
  db: Db,
  input: { workspaceId: string; windowDays: number; include: LedgerExportSection[] },
  now: Date
): Promise<LedgerExportRecord> {
  const windowDays = Math.max(1, Math.min(Math.trunc(input.windowDays), LEDGER_EXPORT_MAX_WINDOW_DAYS));
  // Same boundary the analytics series uses: whole UTC days, counted inclusive
  // of today, so "30 days" means the same span on both screens.
  const start = new Date(now.getTime() - (windowDays - 1) * 86_400_000);
  const since = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())).toISOString();

  // De-duplicated and put back in the canonical order, so two requests asking
  // for the same sections in different orders produce the same manifest.
  const include = LEDGER_EXPORT_SECTIONS.filter((section) => input.include.includes(section));

  const files: LedgerExportFile[] = [];
  const entries: ZipEntry[] = [];
  const counts: Record<string, number> = {};
  const sha256: Record<string, string> = {};

  for (const section of include) {
    for (const source of SOURCES[section]) {
      const params = source.params
        ? source.params(input.workspaceId, since)
        : [input.workspaceId, since];
      const rows = await db.prepare(`${source.sql} LIMIT ${LEDGER_EXPORT_ROW_LIMIT + 1}`)
        .all<Record<string, unknown>>(...params);

      const truncated = rows.length > LEDGER_EXPORT_ROW_LIMIT;
      const kept = truncated ? rows.slice(0, LEDGER_EXPORT_ROW_LIMIT) : rows;
      const name = `${source.table}.ndjson`;
      // An empty table still gets a file. A zero-row NDJSON is a fact -- "we
      // looked, there was nothing" -- and a missing file is a question.
      const data = Buffer.from(kept.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
      const digest = createHash('sha256').update(data).digest('hex');

      files.push({
        name,
        table: source.table,
        section,
        rows: kept.length,
        bytes: data.length,
        sha256: digest,
        truncated
      });
      entries.push({ name, data });
      counts[source.table] = kept.length;
      sha256[name] = digest;
    }
  }

  const manifest = {
    product: 'Trevra',
    format: 'ndjson+manifest',
    generatedAt: now.toISOString(),
    workspaceId: input.workspaceId,
    window: { days: windowDays, since, until: now.toISOString() },
    include,
    rowLimitPerTable: LEDGER_EXPORT_ROW_LIMIT,
    counts,
    files,
    notes: MANIFEST_NOTES
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Manifest first, so a reader that streams the archive can learn what is in
  // it before it has all of it.
  const bytes = zipArchive([{ name: 'manifest.json', data: manifestBytes }, ...entries], now);
  const exportId = id('lgex');
  const filename = `trevra-ledger-${now.toISOString().slice(0, 10)}-${exportId}.zip`;
  const contentType = 'application/zip';

  const row = await db.prepare(`
    INSERT INTO ledger_exports (
      id, workspace_id, window_days, include_json, counts_json, sha256_json,
      filename, content_type, bytes, created_at
    ) VALUES (?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?,?,?)
    RETURNING ${METADATA_COLUMNS}
  `).get<LedgerExportRow>(
    exportId,
    input.workspaceId,
    windowDays,
    JSON.stringify(include),
    JSON.stringify(counts),
    JSON.stringify(sha256),
    filename,
    contentType,
    bytes,
    now.toISOString()
  );

  return toRecord(row as LedgerExportRow);
}

/**
 * The download.
 *
 * Workspace-scoped like everything else here, and for the reason
 * `readCampaignExport` gives about its own table: an export id is a global
 * identifier, and a lookup by id alone would hand one workspace's entire run
 * ledger to another's session.
 */
export async function readLedgerExport(
  db: Db,
  workspaceId: string,
  exportId: string
): Promise<(LedgerExportRecord & { bytes: Buffer }) | undefined> {
  const row = await db.prepare(`
    SELECT ${METADATA_COLUMNS}, bytes FROM ledger_exports WHERE id=? AND workspace_id=?
  `).get<LedgerExportRow & { bytes: Buffer }>(exportId, workspaceId);
  return row ? { ...toRecord(row), bytes: row.bytes } : undefined;
}

/** Metadata only. `bytes` is never in a listing -- a list view must not carry N archives. */
const METADATA_COLUMNS = `
  id, window_days, include_json, counts_json, sha256_json, filename, content_type,
  LENGTH(bytes)::int AS size,
  TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
`;

export async function listLedgerExports(db: Db, workspaceId: string, limit = 20): Promise<LedgerExportRecord[]> {
  const rows = await db.prepare(`
    SELECT ${METADATA_COLUMNS} FROM ledger_exports
    WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all<LedgerExportRow>(workspaceId, Math.max(1, Math.min(Math.trunc(limit), 100)));
  return rows.map(toRecord);
}

interface LedgerExportRow {
  id: string;
  window_days: number;
  include_json: unknown;
  counts_json: unknown;
  sha256_json: unknown;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

function toRecord(row: LedgerExportRow): LedgerExportRecord {
  return {
    id: row.id,
    windowDays: Number(row.window_days),
    include: Array.isArray(row.include_json) ? (row.include_json as LedgerExportSection[]) : [],
    counts: asNumberMap(row.counts_json),
    sha256: asStringMap(row.sha256_json),
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    createdAt: row.created_at
  };
}

function asNumberMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, Number(item)]));
}

function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}
