import { id, type Db } from '../db.js';
import type { ClaimMapEntry, ContentAngle, ContentAsset, ContentFormat } from './types.js';

function parseObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serialize(row: Record<string, unknown>): ContentAsset {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    status: String(row.status) as ContentAsset['status'],
    format: String(row.format) as ContentFormat,
    angle: String(row.angle) as ContentAngle,
    hook: String(row.hook ?? ''),
    body: String(row.body ?? ''),
    claimMap: (parseObject(row.claim_map_json) as ClaimMapEntry[]) ?? [],
    generation: (parseObject(row.generation_json) as Record<string, unknown>) ?? {},
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

async function assertOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string | null
): Promise<void> {
  if (!opportunityId) return;
  const row = await db
    .prepare('SELECT 1 AS present FROM content_opportunities WHERE workspace_id=? AND id=?')
    .get<{ present: number }>(workspaceId, opportunityId);
  if (!row) throw new Error('Content opportunity not found in this workspace.');
}

export async function createContentAsset(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId?: string | null;
    format: ContentFormat;
    angle: ContentAngle;
    hook?: string;
    body?: string;
    claimMap?: ClaimMapEntry[];
    generation?: Record<string, unknown>;
    createdBy?: string | null;
  },
  now: Date = new Date()
): Promise<ContentAsset> {
  await assertOpportunity(db, input.workspaceId, input.opportunityId ?? null);
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO content_assets (
         id,workspace_id,opportunity_id,status,format,angle,hook,body,
         claim_map_json,generation_json,created_by,created_at,updated_at
       ) VALUES (?,?,?,'draft',?,?,?,?,?::jsonb,?::jsonb,?,?,?) RETURNING *`
    )
    .get<Record<string, unknown>>(
      id('cas'),
      input.workspaceId,
      input.opportunityId ?? null,
      input.format,
      input.angle,
      input.hook ?? '',
      input.body ?? '',
      JSON.stringify(input.claimMap ?? []),
      JSON.stringify(input.generation ?? {}),
      input.createdBy ?? null,
      timestamp,
      timestamp
    );
  if (!row) throw new Error('Content asset could not be created.');
  return serialize(row);
}

export async function getContentAsset(
  db: Db,
  workspaceId: string,
  assetId: string
): Promise<ContentAsset | null> {
  const row = await db
    .prepare('SELECT * FROM content_assets WHERE workspace_id=? AND id=?')
    .get<Record<string, unknown>>(workspaceId, assetId);
  return row ? serialize(row) : null;
}

export async function listContentAssets(
  db: Db,
  workspaceId: string,
  opportunityId?: string | null,
  limit = 50
): Promise<ContentAsset[]> {
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = opportunityId
    ? await db
        .prepare(
          `SELECT * FROM content_assets WHERE workspace_id=? AND opportunity_id=?
           ORDER BY created_at DESC,id DESC LIMIT ?`
        )
        .all<Record<string, unknown>>(workspaceId, opportunityId, bounded)
    : await db
        .prepare(
          `SELECT * FROM content_assets WHERE workspace_id=?
           ORDER BY created_at DESC,id DESC LIMIT ?`
        )
        .all<Record<string, unknown>>(workspaceId, bounded);
  return rows.map(serialize);
}

export async function updateContentAsset(
  db: Db,
  workspaceId: string,
  assetId: string,
  patch: Partial<
    Pick<ContentAsset, 'status' | 'hook' | 'body' | 'claimMap' | 'generation' | 'angle' | 'format'>
  >,
  now: Date = new Date()
): Promise<ContentAsset | null> {
  const current = await getContentAsset(db, workspaceId, assetId);
  if (!current) return null;
  const row = await db
    .prepare(
      `UPDATE content_assets SET
         status=?,format=?,angle=?,hook=?,body=?,claim_map_json=?::jsonb,generation_json=?::jsonb,updated_at=?
       WHERE workspace_id=? AND id=? RETURNING *`
    )
    .get<Record<string, unknown>>(
      patch.status ?? current.status,
      patch.format ?? current.format,
      patch.angle ?? current.angle,
      patch.hook ?? current.hook,
      patch.body ?? current.body,
      JSON.stringify(patch.claimMap ?? current.claimMap),
      JSON.stringify(patch.generation ?? current.generation),
      now.toISOString(),
      workspaceId,
      assetId
    );
  return row ? serialize(row) : null;
}
