import { id, type Db } from '../db.js';
import { materializeAccountMarketPulse, type MarketPulseDays } from './pulse.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';

export type MarketPulseCadence = 'weekly' | 'monthly';

export interface MarketPulseSchedule {
  id: string;
  workspaceId: string;
  tag: string | null;
  cadence: MarketPulseCadence;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastOpportunityId: string | null;
  lastPostId: string | null;
  lastBlocker: string | null;
  createdAt: string;
  updatedAt: string;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function serialize(row: Record<string, unknown>): MarketPulseSchedule {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    tag: row.tag ? String(row.tag) : null,
    cadence: String(row.cadence) as MarketPulseCadence,
    enabled: Boolean(row.enabled),
    nextRunAt: iso(row.next_run_at) ?? new Date(0).toISOString(),
    lastRunAt: iso(row.last_run_at),
    lastOpportunityId: row.last_opportunity_id ? String(row.last_opportunity_id) : null,
    lastPostId: row.last_post_id ? String(row.last_post_id) : null,
    lastBlocker: row.last_blocker ? String(row.last_blocker) : null,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString()
  };
}

export function nextMarketPulseRunAt(from: Date, cadence: MarketPulseCadence): Date {
  if (cadence === 'weekly') return new Date(from.getTime() + 7 * 86_400_000);
  const next = new Date(from);
  const targetDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(targetDay, lastDay));
  return next;
}

export async function listMarketPulseSchedules(
  db: Db,
  workspaceId: string
): Promise<MarketPulseSchedule[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM content_pulse_schedules
       WHERE workspace_id=?
       ORDER BY COALESCE(LOWER(tag),''),created_at,id`
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serialize);
}

/** One schedule per existing account-watchlist scope (all Accounts or one tag). */
export async function upsertMarketPulseSchedule(
  db: Db,
  input: {
    workspaceId: string;
    tag?: string | null;
    cadence: MarketPulseCadence;
    enabled: boolean;
  },
  now: Date = new Date()
): Promise<MarketPulseSchedule> {
  const tag = input.tag?.trim() || null;
  const timestamp = now.toISOString();
  const nextRun = nextMarketPulseRunAt(now, input.cadence).toISOString();
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`content-pulse-schedule\u001f${input.workspaceId}\u001f${tag?.toLowerCase() ?? ''}`);
    const existing = await tx
      .prepare(
        `SELECT * FROM content_pulse_schedules
         WHERE workspace_id=? AND COALESCE(LOWER(tag),'')=COALESCE(LOWER(?),'')
         LIMIT 1`
      )
      .get<Record<string, unknown>>(input.workspaceId, tag);
    if (existing) {
      const changedCadence = String(existing.cadence) !== input.cadence;
      const reenabled = !Boolean(existing.enabled) && input.enabled;
      const row = await tx
        .prepare(
          `UPDATE content_pulse_schedules SET
             cadence=?,enabled=?,next_run_at=CASE WHEN ? OR ? THEN ? ELSE next_run_at END,
             updated_at=?
           WHERE workspace_id=? AND id=? RETURNING *`
        )
        .get<Record<string, unknown>>(
          input.cadence,
          input.enabled,
          changedCadence,
          reenabled,
          nextRun,
          timestamp,
          input.workspaceId,
          String(existing.id)
        );
      if (!row) throw new Error('Market Pulse schedule could not be updated.');
      return serialize(row);
    }
    const row = await tx
      .prepare(
        `INSERT INTO content_pulse_schedules
         (id,workspace_id,tag,cadence,enabled,next_run_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`
      )
      .get<Record<string, unknown>>(
        id('cps'),
        input.workspaceId,
        tag,
        input.cadence,
        input.enabled,
        nextRun,
        timestamp,
        timestamp
      );
    if (!row) throw new Error('Market Pulse schedule could not be created.');
    return serialize(row);
  });
}

export interface MarketPulseScheduleRunResult {
  checked: number;
  prepared: number;
  blocked: number;
  failed: number;
}

/**
 * Prepare due pulse drafts inside the existing workspace automation lease.
 * Every schedule advances after one attempt, including blockers/failures, so a
 * missing pattern or broken draft path cannot become a minute-by-minute retry.
 */
export async function runDueMarketPulseSchedules(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<MarketPulseScheduleRunResult> {
  const due = await db
    .prepare(
      `SELECT * FROM content_pulse_schedules
       WHERE workspace_id=? AND enabled=TRUE AND next_run_at<=?::timestamptz
       ORDER BY next_run_at,id LIMIT 20`
    )
    .all<Record<string, unknown>>(workspaceId, now.toISOString());
  const result: MarketPulseScheduleRunResult = {
    checked: 0,
    prepared: 0,
    blocked: 0,
    failed: 0
  };
  for (const raw of due) {
    const schedule = serialize(raw);
    result.checked += 1;
    let opportunityId: string | null = null;
    let postId: string | null = null;
    let blocker: string | null = null;
    try {
      const days: MarketPulseDays = schedule.cadence === 'weekly' ? 7 : 30;
      const materialized = await materializeAccountMarketPulse(
        db,
        workspaceId,
        { days, tag: schedule.tag },
        now
      );
      if (!materialized.opportunity) {
        blocker = materialized.pulse.draftBlocker ?? 'No cross-account market pattern is ready.';
        result.blocked += 1;
      } else {
        opportunityId = materialized.opportunity.id;
        const drafted = await prepareStoryLinkedInDraft(
          db,
          { workspaceId, opportunityId, seatKey: 'owner', actorUserId: null },
          now
        );
        postId = drafted.post.id;
        if (!drafted.reused) result.prepared += 1;
      }
    } catch (error) {
      blocker = error instanceof Error ? error.message : String(error);
      result.failed += 1;
    }
    await db
      .prepare(
        `UPDATE content_pulse_schedules SET
           last_run_at=?,next_run_at=?,last_opportunity_id=?,last_post_id=?,last_blocker=?,updated_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(
        now.toISOString(),
        nextMarketPulseRunAt(now, schedule.cadence).toISOString(),
        opportunityId,
        postId,
        blocker,
        now.toISOString(),
        workspaceId,
        schedule.id
      );
  }
  return result;
}
