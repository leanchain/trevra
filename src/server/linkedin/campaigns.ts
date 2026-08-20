import { id, type Db } from '../db.js';
import type { CampaignStatus } from './action-ledger.js';
// The seat key is NAMED on every insert now, never defaulted by the column --
// see `CampaignInsert.seatKey`. seats.ts imports db and limits and nothing
// from here.
import { OWNER_SEAT_KEY } from './seats.js';
import { LinkedInApiError } from './errors.js';
export interface LinkedInCampaign {
  id: string;
  workspaceId: string;
  name: string;
  /**
   * WHICH LINKEDIN ACCOUNT THIS CAMPAIGN SENDS FROM.
   *
   * Stored since migration 046 and, until the account switcher was made to
   * mean something, never read back out: the list route returned every
   * workspace campaign whoever it was filed against, so an operator working in
   * their second account was shown -- and could stop, edit and queue -- the
   * first account's campaigns. It is on the row type now because a screen that
   * scopes to one account has to be able to say which one each campaign is.
   */
  seatKey: string;
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
  seat_key: string;
  /**
   * THE ONE PLACE THE COLUMN IS NARROWED, and it is a row type rather than a
   * cast on purpose.
   *
   * `linkedin_campaigns.status` carries no CHECK constraint -- the same call
   * migration 032 makes about `linkedin_actions.status` -- so this is a claim
   * this module makes about the writers, not a guarantee the database offers.
   * Making it the SHAPE OF THE ROW rather than an `as` at the mapper means the
   * claim is stated once, where a reader looking for "what can this column
   * be" will find it, instead of being re-asserted at every read; and it means
   * the mappers below carry no cast at all, so widening the union is enough to
   * make every one of them honest.
   */
  status: CampaignStatus;
  sequence_json: unknown;
  playbook_run_id: string | null;
  stop_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

const CAMPAIGN_COLUMNS = `
  id, workspace_id, name, seat_key, status, sequence_json, playbook_run_id,
  stop_requested_at, created_at, updated_at
`;

function toCampaign(row: CampaignRow): LinkedInCampaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    seatKey: row.seat_key,
    status: row.status,
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
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
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
  /**
   * WHICH LINKEDIN ACCOUNT THIS CAMPAIGN IS FOR, named rather than defaulted.
   *
   * `linkedin_campaigns.seat_key` was added by migration 046 with
   * `NOT NULL DEFAULT 'owner'`, and this insert relied on that default. In a
   * single-seat product that was invisible; in a multi-account one it is the
   * dangerous kind of convenience -- a caller that forgets the seat does not
   * fail, it silently files the campaign against the owner's LinkedIn account,
   * and the first symptom is somebody else's outreach going out of the wrong
   * profile. Migration 058 removes that default across the LinkedIn tables for
   * exactly that reason: a forgotten column should raise, not guess.
   *
   * The default therefore moves UP HERE, where it is a TypeScript default with
   * a name on it that a reader and a grep can both find, rather than a
   * property of the column that no call site mentions. The legacy playbook
   * campaigns this function files have no seat of their own and are the owner's
   * by construction, so `OWNER_SEAT_KEY` remains the right value for them --
   * it is now a stated one. Managed campaigns take their seat from the
   * operator's choice and are inserted by `createManagedCampaign`, which has
   * always named the column.
   */
  seatKey?: string;
}

/**
 * File a campaign.
 *
 * The name is a claim (see the partial-unique index in 025): a second live
 * campaign under the same name in the same workspace is refused as a 409
 * rather than silently created, because the usual cause is a double-clicked
 * button and the usual consequence is two invites to every target.
 */
export async function createCampaign(
  db: Db,
  input: CampaignInsert,
  now: Date
): Promise<LinkedInCampaign> {
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `
    INSERT INTO linkedin_campaigns (
      id, workspace_id, name, status, sequence_json, brief_json, playbook_run_id, seat_key, created_at, updated_at
    ) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?)
    ON CONFLICT DO NOTHING
    RETURNING ${CAMPAIGN_COLUMNS}
  `
    )
    .get<CampaignRow>(
      input.id,
      input.workspaceId,
      input.name,
      input.status ?? 'draft',
      JSON.stringify(input.sequence ?? {}),
      JSON.stringify(input.brief ?? {}),
      input.playbookRunId ?? null,
      input.seatKey ?? OWNER_SEAT_KEY,
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

/**
 * WHICH CAMPAIGNS THIS MODULE SPEAKS FOR: the ones built in the sequence
 * builder, and not the outreach manager's.
 *
 * A managed campaign carries a `lead_list_id` AND a `workflow_id` -- exactly
 * the pair `runner.ts` selects on -- and its `sequence_json` holds
 * `WorkflowStep`s. The legacy campaign screen reads that snapshot as
 * `EditableSequenceStep`s, so a manager campaign rendered there is garbled;
 * and worse, the Stop button beside it calls `stopCampaign` below, which sets
 * this table's `status` and releases the ledger but does NOT do what
 * `stopManagedCampaign` also does -- mark `linkedin_campaign_members` removed
 * and cancel their pending manual tasks. A manager campaign stopped from the
 * old screen therefore read as fully stopped while its enrolled leads kept
 * being worked on the next tick.
 *
 * The predicate is written once, as the inverse of the runner's own, so the
 * two ends of "is this campaign managed" cannot drift.
 */
const LEGACY_CAMPAIGN_ONLY = 'AND (lead_list_id IS NULL OR workflow_id IS NULL)';

export interface CampaignListFilters {
  /**
   * ONE ACCOUNT'S CAMPAIGNS, and absent still means every one of them.
   *
   * The default is deliberately NOT the owner seat. This is a list route, and
   * a list that silently narrowed to one account would hide rows from every
   * caller that has always asked a workspace-wide question -- the opposite
   * failure from the one this filter fixes, and a quieter one. The screens
   * that follow the account switcher pass the key; anything else keeps the
   * whole workspace.
   */
  seatKey?: string;
  limit?: number;
}

export async function listCampaigns(
  db: Db,
  workspaceId: string,
  filters: CampaignListFilters = {}
): Promise<LinkedInCampaign[]> {
  const params: unknown[] = [workspaceId];
  const seatClause = filters.seatKey ? 'AND seat_key=?' : '';
  if (filters.seatKey) params.push(filters.seatKey);
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));

  const rows = await db
    .prepare(
      `
    SELECT ${CAMPAIGN_COLUMNS} FROM linkedin_campaigns
    WHERE workspace_id=? ${LEGACY_CAMPAIGN_ONLY} ${seatClause} ORDER BY created_at DESC LIMIT ?
  `
    )
    .all<CampaignRow>(...params);
  return rows.map(toCampaign);
}

export async function getCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<LinkedInCampaign | undefined> {
  const row = await db
    .prepare(
      `SELECT ${CAMPAIGN_COLUMNS} FROM linkedin_campaigns WHERE id=? AND workspace_id=? ${LEGACY_CAMPAIGN_ONLY}`
    )
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
 * 'held' IS RELEASED TOO, AND LEAVING IT OUT STRANDED PEOPLE PERMANENTLY.
 * This function predates migration 051, so it stopped only 'planned' rows --
 * and a campaign stopped while it was PAUSED has its entire queue parked in
 * 'held' by `pauseManagedCampaign`. Those rows then survived the stop in a
 * state with no exit at all:
 *
 *   * the worker cannot claim them (it claims 'planned'), so they never send;
 *   * `startManagedCampaign` cannot restore them, because it refuses to start
 *     a stopped campaign at all;
 *   * `skipAction` refused them with a 409 for the same reason it refuses a
 *     sent one, so nobody could clear them by hand either;
 *   * and they still occupied `idx_linkedin_actions_target`, which is partial
 *     on `status <> 'skipped'` (migration 047) -- so the replay guard went on
 *     holding a claim on those prospects FOREVER. A later campaign from the
 *     same seat could never plan an invite to any of them, and nothing on any
 *     screen said why: the queue was empty, the campaign was stopped, and the
 *     people simply could not be reached again.
 *
 * `stopManagedCampaign` in managed-campaigns.ts already had this right. Two
 * stop paths, one rule: stopping releases everything a pause could have parked.
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
  const row = await db
    .prepare(
      `
    UPDATE linkedin_campaigns
    SET status='stopped',
        stop_requested_at=COALESCE(stop_requested_at, ?::timestamptz),
        updated_at=?
    WHERE id=? AND workspace_id=?
    RETURNING ${CAMPAIGN_COLUMNS}
  `
    )
    .get<CampaignRow>(timestamp, timestamp, campaignId, workspaceId);
  if (!row) return undefined;

  const released = await db
    .prepare(
      `
    UPDATE linkedin_actions SET status='skipped', recorded_at=NULL, claimed_at=NULL
    WHERE workspace_id=? AND campaign_id=? AND status IN ('planned','held') AND claimed_at IS NULL
  `
    )
    .run(workspaceId, campaignId);

  return { campaign: toCampaign(row), released: released.changes };
}

/**
 * The brief a campaign was planned from (029), read by id and by nothing else.
 *
 * Kept off `LinkedInCampaign` on purpose: it carries the whole target list, and
 * the campaign LIST route would otherwise ship every person in every campaign
 * to a screen that renders names and statuses.
 */
export async function getCampaignBrief(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<unknown> {
  const row = await db
    .prepare('SELECT brief_json FROM linkedin_campaigns WHERE id=? AND workspace_id=?')
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
export async function countDeliveredActions(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<number> {
  const row = await db
    .prepare(
      `
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND campaign_id=? AND status NOT IN ('planned','held','skipped')
  `
    )
    .get<{ total: number }>(workspaceId, campaignId);
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
  const row = await db
    .prepare(
      `
    UPDATE linkedin_campaigns SET
      playbook_run_id=COALESCE(?::text, playbook_run_id),
      sequence_json=COALESCE(?::jsonb, sequence_json),
      status=COALESCE(?::text, status),
      updated_at=?
    WHERE id=? AND workspace_id=?
    RETURNING ${CAMPAIGN_COLUMNS}
  `
    )
    .get<CampaignRow>(
      patch.playbookRunId ?? null,
      patch.sequence === undefined ? null : JSON.stringify(patch.sequence),
      patch.status ?? null,
      now.toISOString(),
      campaignId,
      workspaceId
    );
  return row ? toCampaign(row) : undefined;
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

export async function listCampaignExports(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<LinkedInExportRecord[]> {
  const rows = await db
    .prepare(
      `
    SELECT ${EXPORT_COLUMNS} FROM linkedin_exports
    WHERE workspace_id=? AND campaign_id=? ORDER BY created_at DESC, id DESC
  `
    )
    .all<ExportRow>(workspaceId, campaignId);
  return rows.map(toExportRecord);
}

/** The live render for one (campaign, format), if there is one. */
export async function currentCampaignExport(
  db: Db,
  workspaceId: string,
  campaignId: string,
  format: string
): Promise<LinkedInExportRecord | undefined> {
  const row = await db
    .prepare(
      `
    SELECT ${EXPORT_COLUMNS} FROM linkedin_exports
    WHERE workspace_id=? AND campaign_id=? AND format=? AND status <> 'superseded'
  `
    )
    .get<ExportRow>(workspaceId, campaignId, format);
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
  const row = await db
    .prepare(
      `
    SELECT ${EXPORT_COLUMNS}, bytes FROM linkedin_exports
    WHERE id=? AND workspace_id=? AND campaign_id=?
  `
    )
    .get<ExportRow & { bytes: string }>(exportId, workspaceId, campaignId);
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
export async function supersedeCampaignExport(
  db: Db,
  workspaceId: string,
  exportId: string
): Promise<void> {
  await db
    .prepare("UPDATE linkedin_exports SET status='superseded' WHERE id=? AND workspace_id=?")
    .run(exportId, workspaceId);
}

export async function storeCampaignExport(
  db: Db,
  input: ExportInsert,
  now: Date
): Promise<LinkedInExportRecord> {
  const row = await db
    .prepare(
      `
    INSERT INTO linkedin_exports (
      id, workspace_id, campaign_id, format, filename, content_type, bytes, payload_hash, status, created_at
    ) VALUES (?,?,?,?,?,?,?,?, 'current', ?)
    RETURNING ${EXPORT_COLUMNS}
  `
    )
    .get<ExportRow>(
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
