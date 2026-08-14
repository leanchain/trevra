import { id, type Db } from '../db.js';
import type { LinkedInActionKind, LinkedInActionStatus } from './actions.js';

/**
 * Campaigns, the action queue read model, and the one choke point through
 * which any HTTP route is allowed to write `linkedin_actions.status`.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD (plan 5):
 *
 *   No route may write `linkedin_actions.status='sent'` directly. Only the
 *   local worker or the explicit outcome-ingest call may move an action into a
 *   sent/accepted/replied state. The API plans and approves; it never sends.
 *
 * That is enforced here rather than remembered by each route.
 * `writeActionStatus` refuses a worker-only status unless the caller names
 * itself 'outcome-ingest', and exactly one route in `app.ts` passes that
 * value. A future route that wants to mark something sent has to either go
 * through the outcome endpoint or edit this line -- and editing this line is a
 * diff a reviewer sees, which is the whole point of putting the rule in code
 * instead of in a comment.
 *
 * The local worker is NOT a caller here. It writes its own outcomes in
 * `local-worker.ts`, inside the claim it holds, because only that loop knows
 * whether the browser actually got as far as sending. Two writers, one rule
 * each: the worker writes what it did, this file writes what a human reports.
 */

/** A 4xx an operator caused. Routes map `status` straight onto the response. */
export class LinkedInApiError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'LinkedInApiError';
  }
}

/**
 * Statuses that assert something reached LinkedIn.
 *
 * 'exported' is deliberately NOT here. An export is a file handed to the
 * operator; it consumes budget (see actions.ts `COUNTED`) but it is a claim
 * about Trevra, not about LinkedIn, and `exportCampaign` is the sanctioned
 * writer of it. These three are claims about what a stranger's account did.
 */
export const WORKER_ONLY_STATUSES: readonly LinkedInActionStatus[] = ['sent', 'accepted', 'replied'];

export function isWorkerOnlyStatus(status: string): boolean {
  return (WORKER_ONLY_STATUSES as readonly string[]).includes(status);
}

/** Who is asking. 'outcome-ingest' is POST /api/linkedin/actions/outcome, and nothing else. */
export type StatusWriter = 'api' | 'outcome-ingest';

export type CampaignStatus = 'draft' | 'running' | 'completed' | 'stopped';

export interface LinkedInCampaign {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  /** The approved sequence, or `{}` for a campaign whose run has not produced one. */
  sequence: unknown;
  playbookRunId: string | null;
  stopRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  sequence_json: unknown;
  playbook_run_id: string | null;
  stop_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

const CAMPAIGN_COLUMNS = `
  id, workspace_id, name, status, sequence_json, playbook_run_id,
  stop_requested_at, created_at, updated_at
`;

function toCampaign(row: CampaignRow): LinkedInCampaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status as CampaignStatus,
    sequence: parseJson(row.sequence_json),
    playbookRunId: row.playbook_run_id,
    stopRequestedAt: row.stop_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** JSONB comes back parsed from pg; a string means somebody stored text. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}

export interface CampaignInsert {
  /** Minted by the caller BEFORE the playbook starts, so the approval payload can carry it. */
  id: string;
  workspaceId: string;
  name: string;
  status?: CampaignStatus;
  sequence?: unknown;
  playbookRunId?: string | null;
  /**
   * The playbook input this campaign was planned from (029). Kept so a later
   * sequence edit can re-plan through the same pacing and guard without
   * depending on the run that produced it still existing.
   */
  brief?: unknown;
}

/**
 * File a campaign.
 *
 * The name is a claim (see the partial-unique index in 025): a second live
 * campaign under the same name in the same workspace is refused as a 409
 * rather than silently created, because the usual cause is a double-clicked
 * button and the usual consequence is two invites to every target.
 */
export async function createCampaign(db: Db, input: CampaignInsert, now: Date): Promise<LinkedInCampaign> {
  const timestamp = now.toISOString();
  const row = await db.prepare(`
    INSERT INTO linkedin_campaigns (
      id, workspace_id, name, status, sequence_json, brief_json, playbook_run_id, created_at, updated_at
    ) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?)
    ON CONFLICT DO NOTHING
    RETURNING ${CAMPAIGN_COLUMNS}
  `).get<CampaignRow>(
    input.id,
    input.workspaceId,
    input.name,
    input.status ?? 'draft',
    JSON.stringify(input.sequence ?? {}),
    JSON.stringify(input.brief ?? {}),
    input.playbookRunId ?? null,
    timestamp,
    timestamp
  );

  if (!row) {
    throw new LinkedInApiError(
      `A live campaign called '${input.name}' already exists in this workspace. Stop it first, or pick another name.`,
      409
    );
  }
  return toCampaign(row);
}

export async function listCampaigns(db: Db, workspaceId: string, limit = 100): Promise<LinkedInCampaign[]> {
  const rows = await db.prepare(`
    SELECT ${CAMPAIGN_COLUMNS} FROM linkedin_campaigns
    WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?
  `).all<CampaignRow>(workspaceId, Math.max(1, Math.min(limit, 500)));
  return rows.map(toCampaign);
}

export async function getCampaign(db: Db, workspaceId: string, campaignId: string): Promise<LinkedInCampaign | undefined> {
  const row = await db.prepare(`SELECT ${CAMPAIGN_COLUMNS} FROM linkedin_campaigns WHERE id=? AND workspace_id=?`)
    .get<CampaignRow>(campaignId, workspaceId);
  return row ? toCampaign(row) : undefined;
}

/**
 * Stop a campaign, and release the work it had queued.
 *
 * `stop_requested_at` alone would be decoration: the local worker claims from
 * `linkedin_actions`, not from this table, so a stop that wrote one timestamp
 * and nothing else would leave every planned slot to fire on schedule. The
 * campaign's remaining 'planned' actions are therefore moved to 'skipped',
 * which is the ledger's own word for "never happened" -- it consumes no
 * budget (actions.ts `COUNTED`) and it releases the replay guard, so those
 * targets can be approached again in a later campaign.
 *
 * `claimed_at IS NULL` is the boundary between the two writers. A claimed row
 * is already in a browser somewhere and its outcome belongs to the worker that
 * holds it; overwriting it here would file an action as never-happened while
 * it was happening. Stopping mid-batch is the seat kill switch's job
 * (POST /api/linkedin/seat/pause), and this route does not pretend otherwise.
 */
export async function stopCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date
): Promise<{ campaign: LinkedInCampaign; released: number } | undefined> {
  const timestamp = now.toISOString();
  const row = await db.prepare(`
    UPDATE linkedin_campaigns
    SET status='stopped',
        stop_requested_at=COALESCE(stop_requested_at, ?::timestamptz),
        updated_at=?
    WHERE id=? AND workspace_id=?
    RETURNING ${CAMPAIGN_COLUMNS}
  `).get<CampaignRow>(timestamp, timestamp, campaignId, workspaceId);
  if (!row) return undefined;

  const released = await db.prepare(`
    UPDATE linkedin_actions SET status='skipped', recorded_at=NULL
    WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL
  `).run(workspaceId, campaignId);

  return { campaign: toCampaign(row), released: released.changes };
}

/**
 * The brief a campaign was planned from (029), read by id and by nothing else.
 *
 * Kept off `LinkedInCampaign` on purpose: it carries the whole target list, and
 * the campaign LIST route would otherwise ship every person in every campaign
 * to a screen that renders names and statuses.
 */
export async function getCampaignBrief(db: Db, workspaceId: string, campaignId: string): Promise<unknown> {
  const row = await db.prepare('SELECT brief_json FROM linkedin_campaigns WHERE id=? AND workspace_id=?')
    .get<{ brief_json: unknown }>(campaignId, workspaceId);
  return row ? parseJson(row.brief_json) : undefined;
}

/**
 * How many of this campaign's actions have left the 'planned' state.
 *
 * 'skipped' does not count, and that is the whole subtlety: a skipped row is
 * the ledger's word for "never happened" (`skipAction` will only skip a row
 * that is still planned, and `stopCampaign` releases planned rows the same
 * way), so it describes work that was cancelled rather than delivered.
 * Everything else -- exported, sent, accepted, replied, declined -- is a claim
 * that something left Trevra, and rewriting the copy behind it would make the
 * campaign a lie about what was sent.
 *
 * 'held' does not count either, for the same reason as 'planned' rather than a
 * new one: it is where `pauseManagedCampaign` parks a row that was scheduled
 * but never claimed, so that resuming can hand back the identical slot
 * (migration 051). Nothing has been delivered, and counting it here would let
 * a paused campaign be refused an edit on the grounds that it had already
 * sent -- which is precisely the state a pause exists to create.
 */
export async function countDeliveredActions(db: Db, workspaceId: string, campaignId: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND campaign_id=? AND status NOT IN ('planned','held','skipped')
  `).get<{ total: number }>(workspaceId, campaignId);
  return row?.total ?? 0;
}
/** Record the approved copy and the run behind it, once the playbook has produced them. */
export async function attachCampaignRun(
  db: Db,
  workspaceId: string,
  campaignId: string,
  patch: { playbookRunId?: string | null; sequence?: unknown; status?: CampaignStatus },
  now: Date
): Promise<LinkedInCampaign | undefined> {
  const row = await db.prepare(`
    UPDATE linkedin_campaigns SET
      playbook_run_id=COALESCE(?::text, playbook_run_id),
      sequence_json=COALESCE(?::jsonb, sequence_json),
      status=COALESCE(?::text, status),
      updated_at=?
    WHERE id=? AND workspace_id=?
    RETURNING ${CAMPAIGN_COLUMNS}
  `).get<CampaignRow>(
    patch.playbookRunId ?? null,
    patch.sequence === undefined ? null : JSON.stringify(patch.sequence),
    patch.status ?? null,
    now.toISOString(),
    campaignId,
    workspaceId
  );
  return row ? toCampaign(row) : undefined;
}

/* -------------------------------------------------------------------------
 * The queue view.
 * ---------------------------------------------------------------------- */

export interface LinkedInActionView {
  id: string;
  seatKey: string;
  kind: LinkedInActionKind;
  targetRef: string | null;
  campaignId: string | null;
  status: LinkedInActionStatus;
  plannedFor: string | null;
  recordedAt: string | null;
  source: string;
  payloadHash: string | null;
  failureKind: string | null;
  externalRef: string | null;
  claimedAt: string | null;
  createdAt: string;
  /**
   * The Trevra user whose live request queued this row -- migration 043,
   * team-workspace-access design (docs/superpowers/specs/2026-08-13-team-
   * workspace-access-design.md). Null for rows queued before that column
   * existed, queued by the approved-action executor outside a live request,
   * queued by a since-deleted user, or filed with source='export'. The queue
   * view resolves it against the workspace's member list, not here.
   */
  queuedByUserId: string | null;
}

interface ActionRow {
  id: string;
  seat_key: string;
  kind: string;
  target_ref: string | null;
  campaign_id: string | null;
  status: string;
  planned_for: string | null;
  recorded_at: string | null;
  source: string;
  payload_hash: string | null;
  failure_kind: string | null;
  external_ref: string | null;
  claimed_at: string | null;
  created_at: string;
  queued_by_user_id: string | null;
}

const ACTION_COLUMNS = `
  id, seat_key, kind, target_ref, campaign_id, status, planned_for, recorded_at,
  source, payload_hash, failure_kind, external_ref, claimed_at, created_at, queued_by_user_id
`;

function toActionView(row: ActionRow): LinkedInActionView {
  return {
    id: row.id,
    seatKey: row.seat_key,
    kind: row.kind as LinkedInActionKind,
    targetRef: row.target_ref,
    campaignId: row.campaign_id,
    status: row.status as LinkedInActionStatus,
    plannedFor: row.planned_for,
    recordedAt: row.recorded_at,
    source: row.source,
    payloadHash: row.payload_hash,
    failureKind: row.failure_kind,
    externalRef: row.external_ref,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    queuedByUserId: row.queued_by_user_id
  };
}

export interface ActionFilters {
  status?: LinkedInActionStatus;
  kind?: LinkedInActionKind;
  campaignId?: string;
  seatKey?: string;
  /** ISO-8601 bounds on the action's own moment: its slot, else when it was filed. */
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * The queue, always scoped to one workspace.
 *
 * `workspace_id=?` is the first clause and is not optional anywhere in this
 * file: `linkedin_actions.id` is a global identifier, so a handler that looked
 * a row up by id alone would happily serve one workspace's outreach list to
 * another's session.
 */
export async function listActions(db: Db, workspaceId: string, filters: ActionFilters = {}): Promise<LinkedInActionView[]> {
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.status) { clauses.push('status=?'); params.push(filters.status); }
  if (filters.kind) { clauses.push('kind=?'); params.push(filters.kind); }
  if (filters.campaignId) { clauses.push('campaign_id=?'); params.push(filters.campaignId); }
  if (filters.seatKey) { clauses.push('seat_key=?'); params.push(filters.seatKey); }
  if (filters.from) { clauses.push('COALESCE(planned_for, recorded_at, created_at) >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('COALESCE(planned_for, recorded_at, created_at) <= ?'); params.push(filters.to); }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));

  const rows = await db.prepare(`
    SELECT ${ACTION_COLUMNS} FROM linkedin_actions
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(planned_for, recorded_at, created_at) DESC, id DESC
    LIMIT ?
  `).all<ActionRow>(...params);
  return rows.map(toActionView);
}

export async function getAction(db: Db, workspaceId: string, actionId: string): Promise<LinkedInActionView | undefined> {
  const row = await db.prepare(`SELECT ${ACTION_COLUMNS} FROM linkedin_actions WHERE id=? AND workspace_id=?`)
    .get<ActionRow>(actionId, workspaceId);
  return row ? toActionView(row) : undefined;
}

export interface StatusWrite {
  workspaceId: string;
  actionId: string;
  status: LinkedInActionStatus;
  /** Only meaningful for a counted status; ignored for 'planned' and 'skipped'. */
  recordedAt?: string;
  via: StatusWriter;
}

/**
 * The only path from an HTTP request to `linkedin_actions.status`.
 *
 * Read the module header for why. The short version: `via` is a parameter and
 * not a comment, so "the API never sends" is checked at runtime on every call
 * and the one exception is greppable.
 *
 * `recorded_at` is set for counted statuses and cleared for the two that never
 * happened, which is what keeps rule 1 of actions.ts true -- every rolling
 * window reads `recorded_at`, so an outcome reported today for a send that
 * happened on Tuesday must charge Tuesday's budget, not today's.
 */
export async function writeActionStatus(db: Db, input: StatusWrite, now: Date): Promise<LinkedInActionView> {
  if (isWorkerOnlyStatus(input.status) && input.via !== 'outcome-ingest') {
    throw new LinkedInApiError(
      `The API cannot mark a LinkedIn action '${input.status}'. Trevra plans and approves; it never sends. `
        + 'A send is recorded by the local worker that performed it, or reported through POST /api/linkedin/actions/outcome.',
      409
    );
  }

  const counted = input.status !== 'planned' && input.status !== 'skipped';
  const recordedAt = counted ? (input.recordedAt ?? now.toISOString()) : null;

  const row = await db.prepare(`
    UPDATE linkedin_actions SET status=?, recorded_at=?
    WHERE id=? AND workspace_id=?
    RETURNING ${ACTION_COLUMNS}
  `).get<ActionRow>(input.status, recordedAt, input.actionId, input.workspaceId);

  if (!row) throw new LinkedInApiError('LinkedIn action not found', 404);
  return toActionView(row);
}

/**
 * Statuses a skip may be applied to.
 *
 * Skipping is not undo. 'skipped' releases the replay guard on
 * (workspace, seat, kind, target), so skipping an action that already went out
 * frees the target for a second invite to somebody who has already had one --
 * and LinkedIn counts that, whatever the ledger says afterwards. Only work
 * that has not left the building can be dropped.
 */
const SKIPPABLE: readonly string[] = ['planned', 'skipped'];

export async function skipAction(db: Db, workspaceId: string, actionId: string, now: Date): Promise<LinkedInActionView> {
  const existing = await getAction(db, workspaceId, actionId);
  if (!existing) throw new LinkedInApiError('LinkedIn action not found', 404);
  if (!SKIPPABLE.includes(existing.status)) {
    throw new LinkedInApiError(
      `This action is already '${existing.status}' and cannot be skipped. Skipping releases the target for a future campaign, `
        + 'and a target that has already been contacted must not be released.',
      409
    );
  }
  return writeActionStatus(db, { workspaceId, actionId, status: 'skipped', via: 'api' }, now);
}

export interface OutcomeIngest {
  workspaceId: string;
  /** Either the ledger id, or the (kind, targetRef) pair the operator can read off their own tool. */
  actionId?: string;
  kind?: LinkedInActionKind;
  targetRef?: string;
  seatKey?: string;
  outcome: LinkedInActionStatus;
  /** When it actually happened. Defaults to now. */
  occurredAt?: string;
}

/**
 * Manual outcome ingest -- the one sanctioned way an HTTP request moves an
 * action into a sent/accepted/replied state (plan 5, and the answer to open
 * question 7.2 for anybody exporting to their own tool).
 *
 * This is a REPORT, not an instruction. Nothing is sent here; the operator is
 * telling Trevra what already happened in Dripify or in their own browser, so
 * that the acceptance-rate throttle and the day-over-day arithmetic have a
 * real denominator instead of an empty one.
 */
export async function ingestOutcome(db: Db, input: OutcomeIngest, now: Date): Promise<LinkedInActionView> {
  const action = input.actionId
    ? await getAction(db, input.workspaceId, input.actionId)
    : await findActionByTarget(db, input);

  if (!action) {
    throw new LinkedInApiError(
      input.actionId
        ? 'LinkedIn action not found'
        : `No LinkedIn action was found for ${input.kind ?? 'that kind'} to '${input.targetRef ?? ''}'. Outcomes attach to actions Trevra planned; it does not create one to hold a report.`,
      404
    );
  }

  // A skipped action never went out, and its target was released. Reporting an
  // outcome against it would resurrect a claim the ledger has already given up.
  if (action.status === 'skipped') {
    throw new LinkedInApiError(
      'This action was skipped, so it never went out and can carry no outcome. Plan it again if it did.',
      409
    );
  }

  return writeActionStatus(
    db,
    {
      workspaceId: input.workspaceId,
      actionId: action.id,
      status: input.outcome,
      ...(input.occurredAt === undefined ? {} : { recordedAt: input.occurredAt }),
      via: 'outcome-ingest'
    },
    now
  );
}

async function findActionByTarget(db: Db, input: OutcomeIngest): Promise<LinkedInActionView | undefined> {
  if (!input.kind || !input.targetRef) {
    throw new LinkedInApiError("Provide actionId, or both kind and targetRef, so the outcome has exactly one action to attach to.", 400);
  }
  const clauses = ['workspace_id=?', 'kind=?', 'target_ref=?'];
  const params: unknown[] = [input.workspaceId, input.kind, input.targetRef];
  if (input.seatKey) { clauses.push('seat_key=?'); params.push(input.seatKey); }
  const row = await db.prepare(`
    SELECT ${ACTION_COLUMNS} FROM linkedin_actions
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC LIMIT 1
  `).get<ActionRow>(...params);
  return row ? toActionView(row) : undefined;
}

/* -------------------------------------------------------------------------
 * Analytics.
 * ---------------------------------------------------------------------- */

export interface LinkedInFunnel {
  planned: number;
  exported: number;
  sent: number;
  /** Includes replies: somebody who answered necessarily accepted first. Same rule as actions.ts. */
  accepted: number;
  replied: number;
  declined: number;
  skipped: number;
  /**
   * The eighth status, from migration 032: the invite went out, went
   * unanswered, and the seat took it back.
   *
   * Counted SEPARATELY and never folded into `declined`, which is the tempting
   * merge and the wrong one -- nobody refused a withdrawn invite, and the
   * acceptance denominator deliberately excludes it for that reason. 032
   * recorded this query as the known gap it left behind: without this column a
   * withdrawn invite simply vanished from the funnel, so a campaign of 40 that
   * withdrew 12 reported 28 and looked like one that had lost rows.
   */
  withdrawn: number;
}

export interface CampaignFunnel extends LinkedInFunnel {
  campaignId: string;
  name: string | null;
  status: CampaignStatus | null;
  /** Accepted over DECIDED invites, or null when nothing has been decided. Never 0-of-0. */
  acceptanceRate: number | null;
}

export interface FunnelDay extends Pick<LinkedInFunnel, 'planned' | 'exported' | 'sent' | 'accepted' | 'replied'> {
  /** 'YYYY-MM-DD', UTC. */
  date: string;
}

export interface LinkedInAnalytics {
  windowDays: number;
  total: LinkedInFunnel;
  byCampaign: CampaignFunnel[];
  series: FunnelDay[];
}

/** The funnel aggregate, qualified so it can sit in a join without an ambiguous `status`. */
function funnelSelect(prefix = ''): string {
  const status = `${prefix}status`;
  return `
    COUNT(*) FILTER (WHERE ${status}='planned')::int AS planned,
    COUNT(*) FILTER (WHERE ${status}='exported')::int AS exported,
    COUNT(*) FILTER (WHERE ${status}='sent')::int AS sent,
    COUNT(*) FILTER (WHERE ${status} IN ('accepted','replied'))::int AS accepted,
    COUNT(*) FILTER (WHERE ${status}='replied')::int AS replied,
    COUNT(*) FILTER (WHERE ${status}='declined')::int AS declined,
    COUNT(*) FILTER (WHERE ${status}='skipped')::int AS skipped,
    COUNT(*) FILTER (WHERE ${status}='withdrawn')::int AS withdrawn
  `;
}

interface CampaignFunnelRow extends LinkedInFunnel {
  campaign_id: string;
  name: string | null;
  campaign_status: string | null;
  decided_invites: number;
  accepted_invites: number;
}

/**
 * The funnel, by campaign, plus a daily series.
 *
 * The series buckets on `COALESCE(recorded_at, planned_for, created_at)` in
 * UTC: an action that happened is dated when it happened, one that is merely
 * planned is dated at its slot, and one with neither falls back to when it was
 * filed. Calendar days here and rolling 24h windows in actions.ts are not an
 * inconsistency -- a chart is read by a human in a timezone, a ceiling is
 * enforced against a clock nobody told us.
 */
export async function linkedinAnalytics(db: Db, workspaceId: string, windowDays: number, now: Date): Promise<LinkedInAnalytics> {
  const days = Math.max(1, Math.min(Math.trunc(windowDays), 365));
  const since = new Date(now.getTime() - (days - 1) * 86_400_000);
  const sinceIso = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())).toISOString();

  const total = await db.prepare(`SELECT ${funnelSelect()} FROM linkedin_actions WHERE workspace_id=?`)
    .get<LinkedInFunnel>(workspaceId);

  const campaignRows = await db.prepare(`
    SELECT a.campaign_id AS campaign_id, c.name AS name, c.status AS campaign_status, ${funnelSelect('a.')},
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied','declined'))::int AS decided_invites,
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS accepted_invites
    FROM linkedin_actions a
    LEFT JOIN linkedin_campaigns c ON c.id=a.campaign_id AND c.workspace_id=a.workspace_id
    WHERE a.workspace_id=? AND a.campaign_id IS NOT NULL
    GROUP BY a.campaign_id, c.name, c.status
    ORDER BY a.campaign_id
  `).all<CampaignFunnelRow>(workspaceId);

  const seriesRows = await db.prepare(`
    SELECT TO_CHAR(DATE_TRUNC('day', COALESCE(recorded_at, planned_for, created_at) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      ${funnelSelect()}
    FROM linkedin_actions
    WHERE workspace_id=? AND COALESCE(recorded_at, planned_for, created_at) >= ?
    GROUP BY 1
  `).all<LinkedInFunnel & { day: string }>(workspaceId, sinceIso);

  const byDay = new Map(seriesRows.map((row) => [row.day, row]));
  const series: FunnelDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const at = new Date(now.getTime() - offset * 86_400_000);
    const date = at.toISOString().slice(0, 10);
    const row = byDay.get(date);
    series.push({
      date,
      planned: row?.planned ?? 0,
      exported: row?.exported ?? 0,
      sent: row?.sent ?? 0,
      accepted: row?.accepted ?? 0,
      replied: row?.replied ?? 0
    });
  }

  return {
    windowDays: days,
    total: total ?? { planned: 0, exported: 0, sent: 0, accepted: 0, replied: 0, declined: 0, skipped: 0, withdrawn: 0 },
    byCampaign: campaignRows.map((row) => ({
      campaignId: row.campaign_id,
      name: row.name ?? null,
      status: (row.campaign_status as CampaignStatus | null) ?? null,
      planned: row.planned,
      exported: row.exported,
      sent: row.sent,
      accepted: row.accepted,
      replied: row.replied,
      declined: row.declined,
      skipped: row.skipped,
      withdrawn: row.withdrawn,
      // Decided invites only, never sent ones -- an invite sitting unanswered
      // is not a refusal, and counting it as one drags every fresh campaign's
      // rate toward zero on evidence that has not arrived. Same denominator
      // actions.ts `acceptanceRate` uses, for the same reason.
      acceptanceRate: row.decided_invites === 0 ? null : row.accepted_invites / row.decided_invites
    })),
    series
  };
}

/** The id prefix campaigns are minted under. Exported so a route can mint one before the run starts. */
export function newCampaignId(): string {
  return id('lcmp');
}

/* -------------------------------------------------------------------------
 * Rendered exports.
 *
 * RENDER ONCE, SERVE FOREVER, and the reason is worth repeating outside the
 * migration because this is the layer somebody will "optimise":
 *
 *   `exportCampaign()` in export.ts is NOT a pure render. It writes the plan's
 *   slots into `linkedin_actions` as 'exported', which is what makes the next
 *   plan's day-over-day arithmetic describe a real seat. Regenerating a file on
 *   download would re-run that write on every click. The ledger's replay guard
 *   absorbs it today, but the ledger is the single input the entire safety
 *   engine reasons from, and "it happens to dedupe" is not something to hang
 *   that on.
 *
 * So: the download route reads bytes and touches nothing. The export route
 * renders only when there is no current render for this (campaign, format) at
 * this payload hash.
 * ---------------------------------------------------------------------- */

export interface LinkedInExportRecord {
  id: string;
  campaignId: string;
  format: string;
  filename: string;
  contentType: string;
  payloadHash: string | null;
  status: 'current' | 'superseded';
  /** Length of the stored file in UTF-16 code units, so a UI can show a size without fetching it. */
  size: number;
  createdAt: string;
}

interface ExportRow {
  id: string;
  campaign_id: string;
  format: string;
  filename: string;
  content_type: string;
  payload_hash: string | null;
  status: string;
  size: number;
  created_at: string;
}

/** Metadata only. `bytes` is never in a list response -- a queue view must not carry N files. */
const EXPORT_COLUMNS = `
  id, campaign_id, format, filename, content_type, payload_hash, status,
  LENGTH(bytes)::int AS size, created_at
`;

function toExportRecord(row: ExportRow): LinkedInExportRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    format: row.format,
    filename: row.filename,
    contentType: row.content_type,
    payloadHash: row.payload_hash,
    status: row.status as 'current' | 'superseded',
    size: row.size,
    createdAt: row.created_at
  };
}

export async function listCampaignExports(db: Db, workspaceId: string, campaignId: string): Promise<LinkedInExportRecord[]> {
  const rows = await db.prepare(`
    SELECT ${EXPORT_COLUMNS} FROM linkedin_exports
    WHERE workspace_id=? AND campaign_id=? ORDER BY created_at DESC, id DESC
  `).all<ExportRow>(workspaceId, campaignId);
  return rows.map(toExportRecord);
}

/** The live render for one (campaign, format), if there is one. */
export async function currentCampaignExport(
  db: Db,
  workspaceId: string,
  campaignId: string,
  format: string
): Promise<LinkedInExportRecord | undefined> {
  const row = await db.prepare(`
    SELECT ${EXPORT_COLUMNS} FROM linkedin_exports
    WHERE workspace_id=? AND campaign_id=? AND format=? AND status <> 'superseded'
  `).get<ExportRow>(workspaceId, campaignId, format);
  return row ? toExportRecord(row) : undefined;
}

/**
 * The download. Workspace-scoped like everything else here: an export id is a
 * global identifier, and a lookup by id alone would hand one workspace's target
 * list to another's session.
 */
export async function readCampaignExport(
  db: Db,
  workspaceId: string,
  campaignId: string,
  exportId: string
): Promise<(LinkedInExportRecord & { bytes: string }) | undefined> {
  const row = await db.prepare(`
    SELECT ${EXPORT_COLUMNS}, bytes FROM linkedin_exports
    WHERE id=? AND workspace_id=? AND campaign_id=?
  `).get<ExportRow & { bytes: string }>(exportId, workspaceId, campaignId);
  return row ? { ...toExportRecord(row), bytes: row.bytes } : undefined;
}

export interface ExportInsert {
  workspaceId: string;
  campaignId: string;
  format: string;
  filename: string;
  contentType: string;
  bytes: string;
  payloadHash: string | null;
}

/**
 * Retire the current render for a (campaign, format).
 *
 * Called only when a re-approval changed the payload hash. The old row keeps
 * its id and its bytes: an operator may already be halfway through running
 * that file in Dripify, and deleting the thing they are working from is not a
 * kindness. It simply stops being the answer to "the current export".
 */
export async function supersedeCampaignExport(db: Db, workspaceId: string, exportId: string): Promise<void> {
  await db.prepare("UPDATE linkedin_exports SET status='superseded' WHERE id=? AND workspace_id=?")
    .run(exportId, workspaceId);
}

export async function storeCampaignExport(db: Db, input: ExportInsert, now: Date): Promise<LinkedInExportRecord> {
  const row = await db.prepare(`
    INSERT INTO linkedin_exports (
      id, workspace_id, campaign_id, format, filename, content_type, bytes, payload_hash, status, created_at
    ) VALUES (?,?,?,?,?,?,?,?, 'current', ?)
    RETURNING ${EXPORT_COLUMNS}
  `).get<ExportRow>(
    id('lexp'),
    input.workspaceId,
    input.campaignId,
    input.format,
    input.filename,
    input.contentType,
    input.bytes,
    input.payloadHash,
    now.toISOString()
  );
  return toExportRecord(row as ExportRow);
}
