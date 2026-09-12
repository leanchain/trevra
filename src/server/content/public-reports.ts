import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { compileAccountMarketPulse, type MarketPulseDays } from './pulse.js';
import { compileAccountMomentumIndex, type MarketIndexRow } from './index.js';

export type PublicReportTemplate = 'market_pulse' | 'index';
export type PublicReportStatus = 'published' | 'unpublished';

export interface PublicReportEvidence {
  accountName: string;
  detail: string;
  sourceUrl: string;
  observedAt: string;
}

export interface PublicReportPattern {
  kind: string;
  label: string;
  accountCount: number;
  signalCount: number;
  newestAt: string;
  examples: PublicReportEvidence[];
}

export interface PublicMarketPulseSnapshot {
  version: 1;
  kind: 'market_pulse';
  scopeLabel: string;
  days: MarketPulseDays;
  from: string;
  to: string;
  accountCount: number;
  changedAccountCount: number;
  signalCount: number;
  patterns: PublicReportPattern[];
}

export interface PublicMarketIndexSnapshot {
  version: 1;
  kind: 'index';
  scopeLabel: string;
  days: MarketPulseDays;
  from: string;
  to: string;
  accountCount: number;
  scoredAccountCount: number;
  rows: MarketIndexRow[];
  formula: string[];
}

export type PublicReportSnapshot = PublicMarketPulseSnapshot | PublicMarketIndexSnapshot;

export interface PublicContentReport {
  id: string;
  workspaceId: string;
  slug: string;
  template: PublicReportTemplate;
  status: PublicReportStatus;
  title: string;
  description: string;
  snapshot: PublicReportSnapshot;
  methodology: string[];
  publishedAt: string;
  unpublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class PublicReportError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function object(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const valueDate = new Date(String(value));
  return Number.isNaN(valueDate.getTime()) ? null : valueDate.toISOString();
}

function serialize(row: Record<string, unknown>): PublicContentReport {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    slug: String(row.slug),
    template: String(row.template) as PublicReportTemplate,
    status: String(row.status) as PublicReportStatus,
    title: String(row.title),
    description: String(row.description),
    snapshot: object(row.snapshot_json) as PublicReportSnapshot,
    methodology: (object(row.methodology_json) as string[]) ?? [],
    publishedAt: iso(row.published_at) ?? new Date(0).toISOString(),
    unpublishedAt: iso(row.unpublished_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString()
  };
}

function slugPart(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'market-signal'
  );
}

function snapshotHash(
  workspaceId: string,
  title: string,
  description: string,
  snapshot: PublicReportSnapshot
): string {
  return createHash('sha256')
    .update(JSON.stringify([workspaceId, title, description, snapshot]))
    .digest('hex');
}

function publicSnapshot(
  pulse: Awaited<ReturnType<typeof compileAccountMarketPulse>>
): PublicMarketPulseSnapshot {
  return {
    version: 1,
    kind: 'market_pulse',
    scopeLabel: pulse.scopeLabel,
    days: pulse.days,
    from: pulse.from,
    to: pulse.to,
    accountCount: pulse.accountCount,
    changedAccountCount: pulse.changedAccountCount,
    signalCount: pulse.signalCount,
    patterns: pulse.patterns.map((pattern) => ({
      kind: pattern.kind,
      label: pattern.label,
      accountCount: pattern.accountCount,
      signalCount: pattern.signalCount,
      newestAt: pattern.newestAt,
      examples: pattern.examples.map((example) => ({
        accountName: example.accountName,
        detail: example.detail,
        sourceUrl: example.sourceUrl,
        observedAt: example.observedAt
      }))
    }))
  };
}

export async function publishMarketPulseReport(
  db: Db,
  input: {
    workspaceId: string;
    days?: MarketPulseDays;
    tag?: string | null;
    actorUserId?: string | null;
  },
  now: Date = new Date()
): Promise<PublicContentReport> {
  const pulse = await compileAccountMarketPulse(
    db,
    input.workspaceId,
    { days: input.days, tag: input.tag },
    now
  );
  const top = pulse.patterns[0];
  if (!pulse.canDraft || !top)
    throw new PublicReportError(
      pulse.draftBlocker ?? 'No publishable market pattern exists yet.',
      409
    );
  const snapshot = publicSnapshot(pulse);
  const period = pulse.days === 7 ? 'Weekly' : '30-day';
  const scope = pulse.scope.tag ? ` · ${pulse.scope.tag}` : '';
  const title = `${period} market pulse${scope}: ${top.label}`;
  const description = `${top.accountCount} companies showed ${top.label} across ${pulse.scopeLabel.toLowerCase()} in the last ${pulse.days} days.`;
  const methodology = [
    `Window: ${pulse.days} days (${pulse.from.slice(0, 10)} through ${new Date(Date.parse(pulse.to) - 1).toISOString().slice(0, 10)} UTC).`,
    `Scope: ${pulse.scopeLabel}.`,
    'Only source-backed Account signals with a public evidence URL are counted.',
    'A market pattern requires at least two distinct companies; first-capture baselines are excluded.',
    'Examples are snapshots of what Trevra observed at publication time; this public report does not query private workspace state live.'
  ];
  const hash = snapshotHash(input.workspaceId, title, description, snapshot);
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`public-report\u001f${input.workspaceId}\u001f${hash}`);
    const existing = await tx
      .prepare(
        'SELECT * FROM content_public_reports WHERE workspace_id=? AND template=? AND snapshot_hash=?'
      )
      .get<Record<string, unknown>>(input.workspaceId, 'market_pulse', hash);
    if (existing) {
      if (String(existing.status) === 'published') return serialize(existing);
      const republished = await tx
        .prepare(
          `UPDATE content_public_reports SET status='published',published_at=?,unpublished_at=NULL,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`
        )
        .get<Record<string, unknown>>(timestamp, timestamp, input.workspaceId, String(existing.id));
      if (!republished) throw new PublicReportError('Public report could not be republished.', 409);
      return serialize(republished);
    }
    const suffix = hash.slice(0, 10);
    const slug = `${slugPart(title)}-${suffix}`;
    const row = await tx
      .prepare(
        `INSERT INTO content_public_reports
      (id,workspace_id,slug,template,status,title,description,snapshot_json,methodology_json,snapshot_hash,created_by,published_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?) RETURNING *`
      )
      .get<Record<string, unknown>>(
        id('cpr'),
        input.workspaceId,
        slug,
        'market_pulse',
        'published',
        title,
        description,
        JSON.stringify(snapshot),
        JSON.stringify(methodology),
        hash,
        input.actorUserId ?? null,
        timestamp,
        timestamp,
        timestamp
      );
    if (!row) throw new PublicReportError('Public report could not be published.', 409);
    return serialize(row);
  });
}

export async function publishMarketIndexReport(
  db: Db,
  input: {
    workspaceId: string;
    days?: MarketPulseDays;
    tag?: string | null;
    actorUserId?: string | null;
  },
  now: Date = new Date()
): Promise<PublicContentReport> {
  const index = await compileAccountMomentumIndex(
    db,
    input.workspaceId,
    { days: input.days ?? 30, tag: input.tag },
    now
  );
  if (!index.canPublish)
    throw new PublicReportError(index.publishBlocker ?? 'No publishable index exists yet.', 409);
  const snapshot: PublicMarketIndexSnapshot = {
    version: 1,
    kind: 'index',
    scopeLabel: index.scopeLabel,
    days: index.days,
    from: index.from,
    to: index.to,
    accountCount: index.accountCount,
    scoredAccountCount: index.scoredAccountCount,
    rows: index.rows,
    formula: index.formula
  };
  const title = `${index.days}-day Market Momentum Index`;
  const description = `A source-backed ranking of ${index.scoredAccountCount} changing companies across ${index.scopeLabel.toLowerCase()}, scored only on visible signal diversity, activity and recency.`;
  const methodology = [
    `Window: ${index.days} days (${index.from.slice(0, 10)} through ${new Date(Date.parse(index.to) - 1).toISOString().slice(0, 10)} UTC).`,
    `Scope: ${index.scopeLabel}.`,
    ...index.formula,
    'Every ranked row includes source links captured at publication time; the public page never queries private workspace state live.'
  ];
  const hash = snapshotHash(input.workspaceId, title, description, snapshot);
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`public-index\u001f${input.workspaceId}\u001f${hash}`);
    const existing = await tx
      .prepare(
        'SELECT * FROM content_public_reports WHERE workspace_id=? AND template=? AND snapshot_hash=?'
      )
      .get<Record<string, unknown>>(input.workspaceId, 'index', hash);
    if (existing) {
      if (String(existing.status) === 'published') return serialize(existing);
      const republished = await tx
        .prepare(
          `UPDATE content_public_reports SET status='published',published_at=?,unpublished_at=NULL,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`
        )
        .get<Record<string, unknown>>(timestamp, timestamp, input.workspaceId, String(existing.id));
      if (!republished) throw new PublicReportError('Public index could not be republished.', 409);
      return serialize(republished);
    }
    const slug = `${slugPart(title)}-${hash.slice(0, 10)}`;
    const row = await tx
      .prepare(
        `INSERT INTO content_public_reports
         (id,workspace_id,slug,template,status,title,description,snapshot_json,methodology_json,snapshot_hash,created_by,published_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?) RETURNING *`
      )
      .get<Record<string, unknown>>(
        id('cpr'),
        input.workspaceId,
        slug,
        'index',
        'published',
        title,
        description,
        JSON.stringify(snapshot),
        JSON.stringify(methodology),
        hash,
        input.actorUserId ?? null,
        timestamp,
        timestamp,
        timestamp
      );
    if (!row) throw new PublicReportError('Public index could not be published.', 409);
    return serialize(row);
  });
}

export async function listPublicContentReports(
  db: Db,
  workspaceId: string
): Promise<PublicContentReport[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM content_public_reports WHERE workspace_id=? ORDER BY published_at DESC,id DESC'
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serialize);
}

export async function unpublishContentReport(
  db: Db,
  workspaceId: string,
  reportId: string,
  now: Date = new Date()
): Promise<PublicContentReport | null> {
  const row = await db
    .prepare(
      `UPDATE content_public_reports SET status='unpublished',unpublished_at=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`
    )
    .get<Record<string, unknown>>(now.toISOString(), now.toISOString(), workspaceId, reportId);
  return row ? serialize(row) : null;
}

export async function getPublishedContentReportBySlug(
  db: Db,
  slug: string
): Promise<PublicContentReport | null> {
  const row = await db
    .prepare("SELECT * FROM content_public_reports WHERE slug=? AND status='published'")
    .get<Record<string, unknown>>(slug);
  return row ? serialize(row) : null;
}
