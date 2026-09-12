import { id, type Db } from '../db.js';
import type {
  ContentEvidenceRef,
  ContentOpportunity,
  ContentOpportunityKind,
  ContentOpportunityStatus
} from './types.js';

function object(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serialize(row: Record<string, unknown>): ContentOpportunity {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: String(row.status) as ContentOpportunityStatus,
    kind: String(row.kind) as ContentOpportunityKind,
    title: String(row.title),
    thesis: String(row.thesis),
    audience: row.audience ? String(row.audience) : null,
    freshnessAt: new Date(String(row.freshness_at)).toISOString(),
    score: Number(row.score),
    rationale: (object(row.rationale_json) as string[]) ?? [],
    evidence: (object(row.evidence_json) as ContentEvidenceRef[]) ?? [],
    fingerprint: String(row.fingerprint),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export async function upsertContentOpportunity(
  db: Db,
  input: {
    workspaceId: string;
    status?: Extract<ContentOpportunityStatus, 'candidate' | 'ready'>;
    kind: ContentOpportunityKind;
    title: string;
    thesis: string;
    audience?: string | null;
    freshnessAt: string;
    score: number;
    rationale: string[];
    evidence: ContentEvidenceRef[];
    fingerprint: string;
  },
  now: Date = new Date()
): Promise<ContentOpportunity> {
  if (input.evidence.length === 0) throw new Error('A content opportunity needs source evidence.');
  for (const evidence of input.evidence) {
    if (!evidence.sourceUrl || !evidence.observedAt)
      throw new Error('Content evidence requires a source URL and observed timestamp.');
  }
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO content_opportunities (
         id,workspace_id,status,kind,title,thesis,audience,freshness_at,score,
         rationale_json,evidence_json,fingerprint,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?)
       ON CONFLICT (workspace_id,fingerprint) DO UPDATE SET
         kind=EXCLUDED.kind,title=EXCLUDED.title,thesis=EXCLUDED.thesis,
         audience=EXCLUDED.audience,freshness_at=EXCLUDED.freshness_at,
         score=EXCLUDED.score,rationale_json=EXCLUDED.rationale_json,
         evidence_json=EXCLUDED.evidence_json,updated_at=EXCLUDED.updated_at
       WHERE content_opportunities.status NOT IN ('dismissed','expired')
       RETURNING *`
    )
    .get<Record<string, unknown>>(
      id('cop'),
      input.workspaceId,
      input.status ?? 'ready',
      input.kind,
      input.title,
      input.thesis,
      input.audience ?? null,
      input.freshnessAt,
      Math.max(0, Math.min(100, Math.round(input.score))),
      JSON.stringify(input.rationale),
      JSON.stringify(input.evidence),
      input.fingerprint,
      timestamp,
      timestamp
    );
  if (row) return serialize(row);
  const existing = await db
    .prepare('SELECT * FROM content_opportunities WHERE workspace_id=? AND fingerprint=?')
    .get<Record<string, unknown>>(input.workspaceId, input.fingerprint);
  if (!existing) throw new Error('Content opportunity could not be persisted.');
  return serialize(existing);
}

export async function getContentOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string
): Promise<ContentOpportunity | null> {
  const row = await db
    .prepare('SELECT * FROM content_opportunities WHERE workspace_id=? AND id=?')
    .get<Record<string, unknown>>(workspaceId, opportunityId);
  return row ? serialize(row) : null;
}

export async function listContentOpportunities(
  db: Db,
  workspaceId: string,
  options: { status?: ContentOpportunityStatus; limit?: number } = {}
): Promise<ContentOpportunity[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  const rows = options.status
    ? await db
        .prepare(
          `SELECT * FROM content_opportunities WHERE workspace_id=? AND status=?
           ORDER BY score DESC,freshness_at DESC,id ASC LIMIT ?`
        )
        .all<Record<string, unknown>>(workspaceId, options.status, limit)
    : await db
        .prepare(
          `SELECT * FROM content_opportunities WHERE workspace_id=?
           ORDER BY score DESC,freshness_at DESC,id ASC LIMIT ?`
        )
        .all<Record<string, unknown>>(workspaceId, limit);
  return rows.map(serialize);
}

export async function setContentOpportunityStatus(
  db: Db,
  workspaceId: string,
  opportunityId: string,
  status: ContentOpportunityStatus,
  now: Date = new Date()
): Promise<ContentOpportunity | null> {
  const row = await db
    .prepare(
      `UPDATE content_opportunities SET status=?,updated_at=?
       WHERE workspace_id=? AND id=? RETURNING *`
    )
    .get<Record<string, unknown>>(status, now.toISOString(), workspaceId, opportunityId);
  return row ? serialize(row) : null;
}
