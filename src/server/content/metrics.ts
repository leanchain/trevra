import { id, type Db } from '../db.js';

export interface ContentPublicationMetric {
  id: string;
  workspaceId: string;
  channel: string;
  publicationId: string;
  observedAt: string;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  clicks: number | null;
  profileViews: number | null;
  follows: number | null;
  raw: Record<string, unknown>;
  createdAt: string;
}

function json(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function serialize(row: Record<string, unknown>): ContentPublicationMetric {
  const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    channel: String(row.channel),
    publicationId: String(row.publication_id),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    impressions: n(row.impressions),
    reactions: n(row.reactions),
    comments: n(row.comments),
    reposts: n(row.reposts),
    clicks: n(row.clicks),
    profileViews: n(row.profile_views),
    follows: n(row.follows),
    raw: json(row.raw_json),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function metric(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Publication metrics must be non-negative.');
  return Math.trunc(value);
}

/** Append-only snapshot. An exact observedAt replay returns the original row and never overwrites it. */
export async function appendContentPublicationMetric(
  db: Db,
  input: {
    workspaceId: string;
    channel: string;
    publicationId: string;
    observedAt: string;
    impressions?: number | null;
    reactions?: number | null;
    comments?: number | null;
    reposts?: number | null;
    clicks?: number | null;
    profileViews?: number | null;
    follows?: number | null;
    raw?: Record<string, unknown>;
  },
  now: Date = new Date()
): Promise<ContentPublicationMetric> {
  const row = await db
    .prepare(
      `INSERT INTO content_publication_metrics (
         id,workspace_id,channel,publication_id,observed_at,impressions,reactions,comments,reposts,
         clicks,profile_views,follows,raw_json,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?)
       ON CONFLICT (workspace_id,channel,publication_id,observed_at) DO NOTHING
       RETURNING *`
    )
    .get<Record<string, unknown>>(
      id('cpm'),
      input.workspaceId,
      input.channel.trim(),
      input.publicationId.trim(),
      input.observedAt,
      metric(input.impressions),
      metric(input.reactions),
      metric(input.comments),
      metric(input.reposts),
      metric(input.clicks),
      metric(input.profileViews),
      metric(input.follows),
      JSON.stringify(input.raw ?? {}),
      now.toISOString()
    );
  if (row) return serialize(row);
  const existing = await db
    .prepare(
      `SELECT * FROM content_publication_metrics
       WHERE workspace_id=? AND channel=? AND publication_id=? AND observed_at=?::timestamptz`
    )
    .get<Record<string, unknown>>(
      input.workspaceId,
      input.channel.trim(),
      input.publicationId.trim(),
      input.observedAt
    );
  if (!existing) throw new Error('Publication metric snapshot could not be persisted.');
  return serialize(existing);
}

export async function listContentPublicationMetrics(
  db: Db,
  workspaceId: string,
  channel: string,
  publicationId: string,
  limit = 100
): Promise<ContentPublicationMetric[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM content_publication_metrics
       WHERE workspace_id=? AND channel=? AND publication_id=?
       ORDER BY observed_at ASC,id ASC LIMIT ?`
    )
    .all<Record<string, unknown>>(
      workspaceId,
      channel,
      publicationId,
      Math.max(1, Math.min(1000, Math.trunc(limit)))
    );
  return rows.map(serialize);
}
