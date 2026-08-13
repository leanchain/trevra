import { id, type Db } from '../db.js';
import { OWNER_SEAT_KEY } from './seats.js';

export const ACTION_KIND_VALUES = [
  'invite','dm','reply','inmail','profile_view','comment','follow','like','endorse'
] as const;
export type LinkedInActionKind = (typeof ACTION_KIND_VALUES)[number];
export type LinkedInActionStatus = 'planned'|'exported'|'sent'|'accepted'|'replied'|'declined'|'skipped'|'withdrawn';
export type LinkedInActionSource = 'export'|'manual'|'aggregator'|'campaign';
export interface SeatRef { workspaceId: string; seatKey: string; }
export function ownerSeat(workspaceId: string): SeatRef { return { workspaceId, seatKey: OWNER_SEAT_KEY }; }
const COUNTED = `status NOT IN ('planned', 'skipped')`;

export interface LinkedInActionRecord {
  workspaceId: string;
  seatKey?: string;
  kind: LinkedInActionKind;
  targetRef: string | null;
  campaignId?: string | null;
  status: LinkedInActionStatus;
  plannedFor?: string | null;
  source: LinkedInActionSource;
  payloadHash?: string | null;
  recordedAt?: string | null;
}

export async function recordAction(db: Db, record: LinkedInActionRecord, now: Date): Promise<{ id: string; duplicate: boolean }> {
  const seatKey = record.seatKey ?? OWNER_SEAT_KEY;
  const counted = record.status !== 'planned' && record.status !== 'skipped';
  const recordedAt = record.recordedAt === undefined ? (counted ? now.toISOString() : null) : record.recordedAt;
  const actionId = id('lact');
  const scope = record.payloadHash ?? null;
  const row = await db.prepare(`
    INSERT INTO linkedin_actions (
      id, workspace_id, seat_key, kind, target_ref, campaign_id,
      status, planned_for, recorded_at, source, payload_hash, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING
    RETURNING id
  `).get<{ id: string }>(
    actionId, record.workspaceId, seatKey, record.kind, record.targetRef,
    record.campaignId ?? null, record.status, record.plannedFor ?? null,
    recordedAt, record.source, scope, now.toISOString()
  );
  if (row) return { id: row.id, duplicate: false };
  const existing = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=?
      AND COALESCE(payload_hash, 'legacy')=COALESCE(?::text, 'legacy')
      AND status <> 'skipped'
    ORDER BY created_at DESC LIMIT 1
  `).get<{ id: string }>(record.workspaceId, seatKey, record.kind, record.targetRef, scope);
  return { id: existing?.id ?? actionId, duplicate: true };
}

export async function countActionsInWindow(db: Db, seat: SeatRef, kind: LinkedInActionKind, sinceHours: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();
  const row = await db.prepare(`SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND seat_key=? AND kind=? AND ${COUNTED} AND recorded_at > ?`).get<{ total: number }>(seat.workspaceId, seat.seatKey, kind, since);
  return row?.total ?? 0;
}

export interface AcceptanceRate { decided: number; accepted: number; rate: number | null; }
export async function acceptanceRate(db: Db, seat: SeatRef, days: number, now: Date): Promise<AcceptanceRate> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*) FILTER (WHERE status IN ('accepted','replied','declined'))::int AS decided,
           COUNT(*) FILTER (WHERE status IN ('accepted','replied'))::int AS accepted
    FROM linkedin_actions WHERE workspace_id=? AND seat_key=? AND kind='invite' AND recorded_at > ?
  `).get<{ decided: number; accepted: number }>(seat.workspaceId, seat.seatKey, since);
  const decided = row?.decided ?? 0; const accepted = row?.accepted ?? 0;
  return { decided, accepted, rate: decided === 0 ? null : accepted / decided };
}

export async function dailyCountsForLastNDays(db: Db, seat: SeatRef, kind: LinkedInActionKind, n: number, now: Date): Promise<number[]> {
  const days = Math.max(1, Math.trunc(n)); const nowIso = now.toISOString(); const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await db.prepare(`
    SELECT FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - recorded_at)) / 86400)::int AS bucket, COUNT(*)::int AS total
    FROM linkedin_actions WHERE workspace_id=? AND seat_key=? AND kind=? AND ${COUNTED}
      AND recorded_at > ? AND recorded_at <= ? GROUP BY 1
  `).all<{ bucket: number; total: number }>(nowIso, seat.workspaceId, seat.seatKey, kind, since, nowIso);
  const counts = new Array<number>(days).fill(0);
  for (const row of rows) { const index = days - 1 - row.bucket; if (index >= 0 && index < days) counts[index] = row.total; }
  return counts;
}

export async function countPendingInvites(db: Db, seat: SeatRef, options: { before?: Date } = {}): Promise<number> {
  const before = options.before;
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind='invite' AND status IN ('sent','exported')
      AND (?::timestamptz IS NULL OR COALESCE(pending_since, recorded_at) < ?::timestamptz)
  `).get<{ total: number }>(seat.workspaceId, seat.seatKey, before?.toISOString() ?? null, before?.toISOString() ?? null);
  return row?.total ?? 0;
}

export async function hasTarget(
  db: Db,
  seat: SeatRef,
  kind: LinkedInActionKind,
  targetRef: string,
  excludeActionId: string | null = null,
  payloadHash: string | null | undefined = undefined
): Promise<boolean> {
  let scope = payloadHash;
  if (scope === undefined && excludeActionId) {
    const subject = await db.prepare(`SELECT payload_hash FROM linkedin_actions WHERE workspace_id=? AND seat_key=? AND id=?`).get<{ payload_hash: string | null }>(seat.workspaceId, seat.seatKey, excludeActionId);
    if (subject?.payload_hash) scope = subject.payload_hash;
  }
  const scoped = scope !== undefined;
  const row = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=? AND status <> 'skipped'
      AND id IS DISTINCT FROM ?::text
      AND (?::boolean = FALSE OR COALESCE(payload_hash, 'legacy')=COALESCE(?::text, 'legacy'))
    LIMIT 1
  `).get<{ id: string }>(seat.workspaceId, seat.seatKey, kind, targetRef, excludeActionId, scoped, scope ?? null);
  return row !== undefined;
}
