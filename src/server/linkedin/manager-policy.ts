import type { Db } from '../db.js';
import { countActionsInWindow, type LinkedInActionKind } from './actions.js';
import { getSeat, type LinkedInSeat } from './seats.js';

export type ProductLimitKey = 'invite' | 'message' | 'profile_view' | 'follow';

export const CAMPAIGN_WARMUP_MULTIPLIERS = [0.2, 0.4, 0.6, 0.8, 1] as const;

export function productLimitKey(kind: LinkedInActionKind): ProductLimitKey | null {
  if (kind === 'invite') return 'invite';
  if (kind === 'dm' || kind === 'reply') return 'message';
  if (kind === 'profile_view') return 'profile_view';
  if (kind === 'follow') return 'follow';
  return null;
}

interface LocalClock {
  weekday: number;
  hour: number;
  minute: number;
}

function localClock(at: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const weekdayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return {
    weekday: Math.max(0, weekdayNames.indexOf(part('weekday'))),
    hour: Number(part('hour')),
    minute: Number(part('minute'))
  };
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function isWithinSeatWindow(seat: LinkedInSeat, at: Date): boolean {
  const local = localClock(at, seat.timezone);
  if (!seat.workingDays.includes(local.weekday)) return false;
  const minute = local.hour * 60 + local.minute;
  return minute >= clockMinutes(seat.workingStart) && minute < clockMinutes(seat.workingEnd);
}

/**
 * The earliest minute at or after `from` inside the operator's configured
 * window. DST is delegated to Intl by walking real instants, so there is no
 * invented local time during a spring-forward boundary.
 */
export function nextSeatWorkingInstant(seat: LinkedInSeat, from: Date): Date {
  const rounded = new Date(from);
  rounded.setUTCSeconds(0, 0);
  if (rounded.getTime() < from.getTime()) rounded.setUTCMinutes(rounded.getUTCMinutes() + 1);
  const max = 14 * 24 * 60;
  for (let offset = 0; offset <= max; offset += 1) {
    const candidate = new Date(rounded.getTime() + offset * 60_000);
    if (isWithinSeatWindow(seat, candidate)) return candidate;
  }
  throw new Error(`No working instant was found in the next 14 days for seat '${seat.label}'. Check its working-day settings.`);
}

export function campaignWarmupDay(startedAt: string | null, now: Date): number {
  if (!startedAt) return 1;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || start > now.getTime()) return 1;
  return Math.floor((now.getTime() - start) / 86_400_000) + 1;
}

export function campaignWarmupMultiplier(startedAt: string | null, now: Date): number {
  const day = campaignWarmupDay(startedAt, now);
  return CAMPAIGN_WARMUP_MULTIPLIERS[Math.min(CAMPAIGN_WARMUP_MULTIPLIERS.length, day) - 1];
}

async function operatorUsed24h(db: Db, workspaceId: string, seatKey: string, key: ProductLimitKey, now: Date): Promise<number> {
  const seat = { workspaceId, seatKey };
  if (key === 'message') {
    const [dms, replies] = await Promise.all([
      countActionsInWindow(db, seat, 'dm', 24, now),
      countActionsInWindow(db, seat, 'reply', 24, now)
    ]);
    return dms + replies;
  }
  return countActionsInWindow(db, seat, key, 24, now);
}

async function campaignUsed24h(
  db: Db,
  workspaceId: string,
  campaignId: string,
  key: ProductLimitKey,
  now: Date
): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const kinds = key === 'message' ? ['dm','reply'] : [key];
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND campaign_id=? AND kind = ANY(?::text[])
      AND status NOT IN ('planned','skipped') AND recorded_at > ?
  `).get<{ total: number }>(workspaceId, campaignId, kinds, since);
  return row?.total ?? 0;
}

export interface ManagerPolicyVerdict {
  allowed: boolean;
  reasons: string[];
  operatorLimit: number | null;
  operatorUsed: number;
  campaignLimit: number | null;
  campaignUsed: number;
  campaignWarmup: number | null;
}

/**
 * Product/operator policy layered on top of guard.ts. This function can only
 * make an action stricter; the existing LinkedIn safety verdict is still run
 * separately immediately before execution.
 */
export async function evaluateManagerPolicy(
  db: Db,
  input: {
    workspaceId: string;
    seatKey: string;
    kind: LinkedInActionKind;
    at: Date;
    campaignId?: string | null;
  }
): Promise<ManagerPolicyVerdict> {
  const seat = await getSeat(db, input.workspaceId, input.seatKey);
  const reasons: string[] = [];
  if (!seat) {
    return { allowed: false, reasons: ['The selected LinkedIn account no longer exists.'], operatorLimit: null, operatorUsed: 0, campaignLimit: null, campaignUsed: 0, campaignWarmup: null };
  }
  if (!isWithinSeatWindow(seat, input.at)) reasons.push(`Outside ${seat.workingStart}-${seat.workingEnd} on the seat's configured working days in ${seat.timezone}.`);

  const key = productLimitKey(input.kind);
  if (!key) return { allowed: reasons.length === 0, reasons, operatorLimit: null, operatorUsed: 0, campaignLimit: null, campaignUsed: 0, campaignWarmup: null };

  const operatorLimit = seat.operatorLimits[key];
  const operatorUsed = await operatorUsed24h(db, input.workspaceId, input.seatKey, key, input.at);
  if (operatorUsed + 1 > operatorLimit) reasons.push(`${key} operator limit reached: ${operatorUsed} of ${operatorLimit} in the last 24 hours.`);

  let campaignLimit: number | null = null;
  let campaignUsed = 0;
  let campaignWarmup: number | null = null;
  if (input.campaignId) {
    const campaign = await db.prepare(`
      SELECT TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
      FROM linkedin_campaigns WHERE workspace_id=? AND id=?
    `).get<{ started_at: string | null }>(input.workspaceId, input.campaignId);
    if (campaign) {
      campaignWarmup = campaignWarmupMultiplier(campaign.started_at, input.at);
      campaignLimit = Math.floor(operatorLimit * campaignWarmup);
      campaignUsed = await campaignUsed24h(db, input.workspaceId, input.campaignId, key, input.at);
      if (campaignUsed + 1 > campaignLimit) {
        reasons.push(`Campaign warm-up permits ${campaignLimit} ${key} action(s) in this 24-hour window; ${campaignUsed} already count.`);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons, operatorLimit, operatorUsed, campaignLimit, campaignUsed, campaignWarmup };
}
