import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { id, type Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { executePreparedPlaybookAction } from '../control-plane/execution.js';
import { campaignSnapshotSteps } from './managed-campaigns.js';
import { delayMilliseconds } from './workflows.js';

export type CampaignChannelKind = 'email' | 'find_email' | 'webhook' | 'external_handoff';
export type CampaignChannelStatus =
  'planned' | 'claimed' | 'sent' | 'failed' | 'unknown' | 'skipped';

export interface CampaignChannelRunResult {
  claimed: number;
  sent: number;
  failed: number;
  unknown: number;
}

interface ChannelRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  member_id: string;
  contact_id: string;
  workflow_step_id: string;
  kind: CampaignChannelKind;
  payload_json: unknown;
  variant_id: string | null;
  idempotency_key: string;
  connection_id: string | null;
  attempt_count: number;
  credits_used: number;
}

function objectOf(value: unknown): Record<string, unknown> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function claimNext(db: Db, workspaceId: string, now: Date): Promise<ChannelRow | null> {
  return (
    (await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET status='claimed',claimed_at=?::timestamptz,attempt_count=attempt_count+1,updated_at=?::timestamptz
         WHERE id=(
           SELECT id FROM linkedin_campaign_channel_actions
           WHERE workspace_id=? AND status='planned' AND planned_for<=?::timestamptz AND claimed_at IS NULL
           ORDER BY planned_for ASC,created_at ASC,id ASC
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,payload_json,variant_id,idempotency_key,connection_id,attempt_count,credits_used`
      )
      .get<ChannelRow>(now.toISOString(), now.toISOString(), workspaceId, now.toISOString())) ??
    null
  );
}

async function mailboxMaySend(
  db: Db,
  workspaceId: string,
  connectionId: string | null,
  now: Date
): Promise<{ allowed: boolean; nextAt: Date | null }> {
  if (!connectionId) return { allowed: true, nextAt: null };
  const setting = await db
    .prepare(
      `SELECT daily_limit,timezone,working_days_json,work_start_minute,work_end_minute
       FROM linkedin_campaign_mailbox_settings WHERE workspace_id=? AND connection_id=?`
    )
    .get<{
      daily_limit: number;
      timezone: string;
      working_days_json: unknown;
      work_start_minute: number;
      work_end_minute: number;
    }>(workspaceId, connectionId);
  if (!setting) return { allowed: true, nextAt: null };
  const used =
    (
      await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM linkedin_campaign_channel_actions
           WHERE workspace_id=? AND connection_id=? AND kind='email' AND status='sent' AND completed_at>=?::timestamptz`
        )
        .get<{ total: number }>(
          workspaceId,
          connectionId,
          new Date(now.getTime() - 86_400_000).toISOString()
        )
    )?.total ?? 0;
  if (Number(used) >= Number(setting.daily_limit)) {
    return { allowed: false, nextAt: new Date(now.getTime() + 60 * 60_000) };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: setting.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const localMinute = hour * 60 + minute;
  const days = (() => {
    const raw = objectOf({ value: setting.working_days_json }).value ?? setting.working_days_json;
    const parsed =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return [];
            }
          })()
        : raw;
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  })();
  if (
    !days.includes(weekday) ||
    localMinute < Number(setting.work_start_minute) ||
    localMinute >= Number(setting.work_end_minute)
  ) {
    return { allowed: false, nextAt: new Date(now.getTime() + 30 * 60_000) };
  }
  return { allowed: true, nextAt: null };
}

async function executeEmail(
  db: Db,
  row: ChannelRow,
  payload: Record<string, unknown>
): Promise<{ provider: string; externalRef: string }> {
  const recipient = String(payload.recipient ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  const body = String(payload.body ?? '').trim();
  if (!recipient || !subject || !body)
    throw new Error('Email action requires recipient, subject, and body.');
  const threaded = payload.threaded === true;
  const prior = threaded
    ? await db
        .prepare(
          `SELECT external_ref,idempotency_key FROM linkedin_campaign_channel_actions
           WHERE workspace_id=? AND member_id=? AND kind='email' AND status='sent'
             AND external_ref IS NOT NULL
             AND connection_id IS NOT DISTINCT FROM ?
             AND id<>?
           ORDER BY completed_at DESC,created_at DESC LIMIT 1`
        )
        .get<{ external_ref: string; idempotency_key: string }>(
          row.workspace_id,
          row.member_id,
          row.connection_id,
          row.id
        )
    : undefined;
  return executeConnectedAction(db, row.workspace_id, {
    type: 'email_draft',
    connection_id: row.connection_id ?? payload.connectionId ?? undefined,
    recipient,
    subject,
    body,
    structured_payload_json: JSON.stringify({
      threaded,
      threadExternalRef: prior?.external_ref ?? null,
      threadIdempotencyKey: prior?.idempotency_key ?? null,
      tracking: payload.tracking ?? 'off',
      campaignId: row.campaign_id,
      memberId: row.member_id,
      workflowStepId: row.workflow_step_id
    }),
    payload_hash: row.idempotency_key
  });
}

async function reserveEnrichmentCredit(db: Db, row: ChannelRow, now: Date): Promise<void> {
  if (row.credits_used > 0) return;
  await db.transaction(async (tx) => {
    const campaign = await tx
      .prepare(
        `SELECT enrichment_credit_cap FROM linkedin_campaigns WHERE workspace_id=? AND id=? FOR UPDATE`
      )
      .get<{ enrichment_credit_cap: number | null }>(row.workspace_id, row.campaign_id);
    if (!campaign) throw new Error('Campaign no longer exists.');
    const cap =
      campaign.enrichment_credit_cap === null
        ? 0
        : Math.max(0, Number(campaign.enrichment_credit_cap));
    const used = await tx
      .prepare(
        `SELECT COALESCE(SUM(credits_used),0)::int AS total FROM linkedin_campaign_channel_actions
        WHERE workspace_id=? AND campaign_id=? AND kind='find_email'`
      )
      .get<{ total: number }>(row.workspace_id, row.campaign_id);
    if (Number(used?.total ?? 0) >= cap)
      throw new Error('Campaign enrichment credit cap reached; no provider lookup was attempted.');
    const reserved = await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET credits_used=1,updated_at=?::timestamptz
        WHERE workspace_id=? AND id=? AND credits_used=0 RETURNING id`
      )
      .get<{ id: string }>(now.toISOString(), row.workspace_id, row.id);
    if (reserved) row.credits_used = 1;
  });
}

async function executeFindEmail(
  db: Db,
  row: ChannelRow,
  payload: Record<string, unknown>,
  now: Date
): Promise<{ provider: string; externalRef: string }> {
  const contact = await db
    .prepare(
      `SELECT email,email_source,email_provenance,email_confidence,email_verification_status,first_name,last_name,company,profile_url
       FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?`
    )
    .get<{
      email: string | null;
      email_source: string | null;
      email_provenance: string | null;
      email_confidence: number | null;
      email_verification_status: string | null;
      first_name: string;
      last_name: string;
      company: string;
      profile_url: string | null;
    }>(row.workspace_id, row.contact_id);
  if (!contact) throw new Error('Campaign contact no longer exists.');
  if (contact.email && payload.refresh !== true) {
    return {
      provider: contact.email_source ?? contact.email_provenance ?? 'existing',
      externalRef: `email:${contact.email}`
    };
  }

  const providerId = String(
    payload.providerId ?? process.env.TREVRA_EMAIL_ENRICHMENT_PROVIDER ?? 'environment'
  );
  const endpoint = process.env.TREVRA_EMAIL_ENRICHMENT_URL?.trim();
  if (!endpoint) {
    // A definite no-provider result is not an unknown external side effect. It can branch cleanly.
    return { provider: providerId, externalRef: 'email:not-found' };
  }
  await reserveEnrichmentCredit(db, row, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': row.idempotency_key,
        ...(process.env.TREVRA_EMAIL_ENRICHMENT_TOKEN
          ? { authorization: `Bearer ${process.env.TREVRA_EMAIL_ENRICHMENT_TOKEN}` }
          : {})
      },
      body: JSON.stringify({
        firstName: contact.first_name,
        lastName: contact.last_name,
        company: contact.company,
        profileUrl: contact.profile_url,
        refresh: payload.refresh === true
      }),
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`Email enrichment provider returned HTTP ${response.status}.`);
    const data = (await response.json()) as Record<string, unknown>;
    const email = typeof data.email === 'string' ? data.email.trim() : '';
    if (!email) return { provider: providerId, externalRef: 'email:not-found' };
    const confidence =
      typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : null;
    const verification =
      typeof data.verificationStatus === 'string' ? data.verificationStatus.slice(0, 80) : null;
    await db
      .prepare(
        `UPDATE linkedin_lead_contacts SET email=?,email_source=?,email_provenance='enriched',email_confidence=?,email_verification_status=?,updated_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(
        email,
        providerId,
        confidence,
        verification,
        now.toISOString(),
        row.workspace_id,
        row.contact_id
      );
    return { provider: providerId, externalRef: `email:${email}` };
  } finally {
    clearTimeout(timer);
  }
}

function blockedAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('2001:db8:')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
    return mapped ? blockedAddress(mapped) : false;
  }
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

export async function assertSafeCampaignDestination(
  raw: string,
  options: { allowLocalTest?: boolean } = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Destination URL is invalid.');
  }
  const allowLocalTest = options.allowLocalTest ?? process.env.NODE_ENV === 'test';
  if (url.username || url.password) throw new Error('Destination URL credentials are not allowed.');
  if (url.protocol !== 'https:' && !(allowLocalTest && url.protocol === 'http:'))
    throw new Error('Destination URL must use HTTPS.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    if (!allowLocalTest) throw new Error('Destination hostname is blocked.');
    return url;
  }
  if (isIP(hostname)) {
    if (blockedAddress(hostname) && !allowLocalTest)
      throw new Error('Destination resolves to a private or reserved address.');
    return url;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Destination hostname could not be resolved.');
  }
  if (addresses.length === 0) throw new Error('Destination hostname could not be resolved.');
  if (!allowLocalTest && addresses.some(({ address }) => blockedAddress(address)))
    throw new Error('Destination resolves to a private or reserved address.');
  return url;
}

function handoffPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const text = value.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('External handoff payload must render as valid JSON.');
  }
}

async function executeExternalHandoff(
  db: Db,
  row: ChannelRow,
  payload: Record<string, unknown>
): Promise<{ provider: string; externalRef: string }> {
  const provider = String(payload.provider ?? 'webhook')
    .trim()
    .toLowerCase();
  if (provider === 'webhook') return executeWebhook(row, payload);
  if (provider === 'remote_action') {
    const actionType = String(payload.destination ?? '').trim();
    if (!actionType) throw new Error('External handoff has no configured remote action type.');
    const outcome = await executePreparedPlaybookAction(db, {
      workspaceId: row.workspace_id,
      actionType,
      payload: handoffPayload(payload.payload),
      payloadHash: row.idempotency_key
    });
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  }
  if (provider === 'crm_activity') {
    const outcome = await executePreparedPlaybookAction(db, {
      workspaceId: row.workspace_id,
      actionType: 'crm.log-activity',
      payload: handoffPayload(payload.payload),
      payloadHash: row.idempotency_key
    });
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  }
  throw new Error(`Cannot execute external handoff provider '${provider}'.`);
}

async function executeWebhook(
  row: ChannelRow,
  payload: Record<string, unknown>
): Promise<{ provider: string; externalRef: string }> {
  const rawUrl = String(payload.url ?? payload.destination ?? '').trim();
  if (!rawUrl) throw new Error('Webhook/handoff action has no destination URL.');
  const url = (await assertSafeCampaignDestination(rawUrl)).toString();
  const method = String(payload.method ?? 'POST').toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': row.idempotency_key,
        'x-trevra-campaign-id': row.campaign_id,
        'x-trevra-member-id': row.member_id
      },
      body: String(payload.body ?? payload.payload ?? '{}'),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Destination returned HTTP ${response.status}.`);
    return {
      provider: String(payload.provider ?? 'webhook'),
      externalRef:
        response.headers.get('x-request-id') ??
        response.headers.get('location') ??
        `http:${response.status}`
    };
  } finally {
    clearTimeout(timer);
  }
}

function definiteFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /HTTP 4\d\d|requires recipient|no destination|no longer exists|Connect Gmail|Connect Microsoft|cannot execute|enrichment credit cap reached|external handoff payload|No approved action adapter|requires [A-Z_]+|failed validation|cannot execute|destination .*?(?:invalid|blocked|resolve|HTTPS|credentials|private|reserved)/i.test(
    error.message
  );
}

async function mergeMemberExternalState(
  db: Db,
  row: ChannelRow,
  patch: Record<string, unknown>,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET branch_state_json=COALESCE(branch_state_json,'{}'::jsonb) || ?::jsonb,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=?`
    )
    .run(JSON.stringify(patch), now.toISOString(), row.workspace_id, row.member_id);
}

async function advanceMemberAfterKnownOutcome(db: Db, row: ChannelRow, now: Date): Promise<void> {
  const campaign = await db
    .prepare(
      `SELECT c.sequence_json,m.workflow_snapshot_json
       FROM linkedin_campaigns c
       JOIN linkedin_campaign_members m ON m.workspace_id=c.workspace_id AND m.campaign_id=c.id
       WHERE c.workspace_id=? AND c.id=? AND m.id=?`
    )
    .get<{ sequence_json: unknown; workflow_snapshot_json: unknown }>(
      row.workspace_id,
      row.campaign_id,
      row.member_id
    );
  if (!campaign) return;
  const memberSteps = campaignSnapshotSteps(campaign.workflow_snapshot_json);
  const steps =
    memberSteps.length > 0 ? memberSteps : campaignSnapshotSteps(campaign.sequence_json);
  const currentIndex = steps.findIndex((step) => step.id === row.workflow_step_id);
  if (currentIndex < 0) return;
  const current = steps[currentIndex]!;
  const targetId = current.nextStepId === null ? null : current.nextStepId;
  const nextIndex = targetId ? steps.findIndex((step) => step.id === targetId) : currentIndex + 1;
  const next = nextIndex >= 0 && nextIndex < steps.length ? steps[nextIndex] : null;
  const eligible = next
    ? new Date(now.getTime() + delayMilliseconds(next.delayBefore)).toISOString()
    : null;
  await db
    .prepare(
      `UPDATE linkedin_campaign_members SET step_index=?,status=?,next_eligible_at=?::timestamptz,last_action_id=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND step_index=? AND status IN ('active','waiting')`
    )
    .run(
      next ? nextIndex : steps.length,
      next ? 'waiting' : 'completed',
      eligible,
      now.toISOString(),
      row.workspace_id,
      row.member_id,
      currentIndex
    );
}

async function settleSuccess(
  db: Db,
  row: ChannelRow,
  outcome: { provider: string; externalRef: string },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions SET status='sent',claimed_at=NULL,completed_at=?::timestamptz,
       provider=?,external_ref=?,last_error=NULL,outcome_known=TRUE,updated_at=?::timestamptz WHERE id=? AND workspace_id=?`
    )
    .run(
      now.toISOString(),
      outcome.provider,
      outcome.externalRef,
      now.toISOString(),
      row.id,
      row.workspace_id
    );
  const found =
    row.kind === 'find_email' &&
    outcome.externalRef.startsWith('email:') &&
    outcome.externalRef !== 'email:not-found';
  await mergeMemberExternalState(
    db,
    row,
    {
      [`external:${row.kind}_success`]: true,
      ...(row.kind === 'find_email'
        ? { 'external:email_found': found, 'external:email_available': found }
        : {}),
      ...(row.kind === 'email' ? { 'external:email_sent': true } : {}),
      ...(row.kind === 'external_handoff' ? { 'external:handoff_succeeded': true } : {})
    },
    now
  );
  await advanceMemberAfterKnownOutcome(db, row, now);
}

async function settleFailure(
  db: Db,
  row: ChannelRow,
  error: unknown,
  now: Date
): Promise<'failed' | 'unknown'> {
  const known = definiteFailure(error);
  const status = known ? 'failed' : 'unknown';
  await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions SET status=?,claimed_at=NULL,last_error=?,outcome_known=?,updated_at=?::timestamptz
       WHERE id=? AND workspace_id=?`
    )
    .run(
      status,
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      known,
      now.toISOString(),
      row.id,
      row.workspace_id
    );
  await mergeMemberExternalState(
    db,
    row,
    {
      [`external:${row.kind}_success`]: false,
      ...(row.kind === 'find_email' ? { 'external:email_found': false } : {}),
      ...(row.kind === 'external_handoff' ? { 'external:handoff_succeeded': false } : {})
    },
    now
  );
  if (known) await advanceMemberAfterKnownOutcome(db, row, now);
  return status;
}

export async function runCampaignChannelActions(
  db: Db,
  workspaceId: string,
  now: Date = new Date(),
  limit = 100
): Promise<CampaignChannelRunResult> {
  const result: CampaignChannelRunResult = { claimed: 0, sent: 0, failed: 0, unknown: 0 };
  for (let index = 0; index < Math.max(0, Math.min(500, limit)); index += 1) {
    const row = await claimNext(db, workspaceId, now);
    if (!row) break;
    result.claimed += 1;
    const payload = objectOf(row.payload_json);
    try {
      if (row.kind === 'email') {
        const mailbox = await mailboxMaySend(db, workspaceId, row.connection_id, now);
        if (!mailbox.allowed) {
          await db
            .prepare(
              `UPDATE linkedin_campaign_channel_actions SET status='planned',claimed_at=NULL,planned_for=?::timestamptz,updated_at=?::timestamptz
               WHERE id=? AND workspace_id=?`
            )
            .run(
              (mailbox.nextAt ?? new Date(now.getTime() + 30 * 60_000)).toISOString(),
              now.toISOString(),
              row.id,
              workspaceId
            );
          continue;
        }
      }
      const outcome =
        row.kind === 'email'
          ? await executeEmail(db, row, payload)
          : row.kind === 'find_email'
            ? await executeFindEmail(db, row, payload, now)
            : row.kind === 'external_handoff'
              ? await executeExternalHandoff(db, row, payload)
              : await executeWebhook(row, payload);
      await settleSuccess(db, row, outcome, now);
      result.sent += 1;
    } catch (error) {
      const status = await settleFailure(db, row, error, now);
      if (status === 'failed') result.failed += 1;
      else result.unknown += 1;
    }
  }
  return result;
}

export async function retryCampaignChannelAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions SET status='planned',claimed_at=NULL,next_retry_at=NULL,last_error=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status='failed' AND outcome_known=TRUE`
    )
    .run(now.toISOString(), workspaceId, actionId);
  return result.changes > 0;
}

export async function recordCampaignEmailEvent(
  db: Db,
  workspaceId: string,
  input: {
    channelActionId?: string;
    externalRef?: string;
    eventKind: 'opened' | 'clicked' | 'bounced' | 'replied';
    providerEventId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  },
  now: Date = new Date()
): Promise<{ recorded: boolean; memberId: string | null }> {
  const row = input.channelActionId
    ? await db
        .prepare(
          `SELECT id,member_id,campaign_id FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=? AND kind='email'`
        )
        .get<{ id: string; member_id: string; campaign_id: string }>(
          workspaceId,
          input.channelActionId
        )
    : await db
        .prepare(
          `SELECT id,member_id,campaign_id FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND external_ref=? AND kind='email' ORDER BY completed_at DESC LIMIT 1`
        )
        .get<{ id: string; member_id: string; campaign_id: string }>(
          workspaceId,
          input.externalRef ?? ''
        );
  if (!row) return { recorded: false, memberId: null };
  const eventId = input.providerEventId
    ? `lice_${sha(`${workspaceId}:${input.providerEventId}`).slice(0, 32)}`
    : id('lice');
  try {
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_events (id,workspace_id,channel_action_id,event_kind,provider_event_id,occurred_at,metadata_json,created_at)
         VALUES (?,?,?,?,?,?::timestamptz,?::jsonb,?::timestamptz)`
      )
      .run(
        eventId,
        workspaceId,
        row.id,
        input.eventKind,
        input.providerEventId ?? null,
        input.occurredAt ?? now.toISOString(),
        JSON.stringify(input.metadata ?? {}),
        now.toISOString()
      );
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === '23505') return { recorded: false, memberId: row.member_id };
    throw error;
  }

  await db
    .prepare(
      `UPDATE linkedin_campaign_members SET branch_state_json=COALESCE(branch_state_json,'{}'::jsonb) || ?::jsonb,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=?`
    )
    .run(
      JSON.stringify({ [`external:email_${input.eventKind}`]: true }),
      now.toISOString(),
      workspaceId,
      row.member_id
    );
  if (input.eventKind === 'replied') {
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          `UPDATE linkedin_campaign_members SET status='replied',next_eligible_at=NULL,ended_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual','paused')`
        )
        .run(now.toISOString(), now.toISOString(), workspaceId, row.member_id);
      await tx
        .prepare(
          `UPDATE linkedin_actions SET status='skipped',claimed_at=NULL,recorded_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
        )
        .run(workspaceId, row.member_id);
      await tx
        .prepare(
          `UPDATE linkedin_campaign_channel_actions SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
           WHERE workspace_id=? AND member_id=? AND status='planned'`
        )
        .run(now.toISOString(), workspaceId, row.member_id);
    });
  }
  return { recorded: true, memberId: row.member_id };
}

export async function listCampaignMailboxes(
  db: Db,
  workspaceId: string
): Promise<
  Array<{
    id: string;
    provider: string;
    status: string;
    dailyLimit: number;
    timezone: string;
    workingDays: number[];
    workStartMinute: number;
    workEndMinute: number;
  }>
> {
  const rows = await db
    .prepare(
      `SELECT c.id,c.provider,c.status,
              COALESCE(s.daily_limit,50)::int AS daily_limit,COALESCE(s.timezone,'UTC') AS timezone,
              COALESCE(s.working_days_json,'[1,2,3,4,5]'::jsonb) AS working_days_json,
              COALESCE(s.work_start_minute,480)::int AS work_start_minute,
              COALESCE(s.work_end_minute,1080)::int AS work_end_minute
       FROM connections c LEFT JOIN linkedin_campaign_mailbox_settings s ON s.workspace_id=c.workspace_id AND s.connection_id=c.id
       WHERE c.workspace_id=? AND c.status='connected' AND c.provider IN ('gmail','google-mail','microsoft','outlook')
       ORDER BY c.provider,c.id`
    )
    .all<{
      id: string;
      provider: string;
      status: string;
      daily_limit: number;
      timezone: string;
      working_days_json: unknown;
      work_start_minute: number;
      work_end_minute: number;
    }>(workspaceId);
  return rows.map((row) => {
    const raw =
      typeof row.working_days_json === 'string'
        ? (() => {
            try {
              return JSON.parse(row.working_days_json) as unknown;
            } catch {
              return [];
            }
          })()
        : row.working_days_json;
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      dailyLimit: Number(row.daily_limit),
      timezone: row.timezone,
      workingDays: Array.isArray(raw)
        ? raw.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [],
      workStartMinute: Number(row.work_start_minute),
      workEndMinute: Number(row.work_end_minute)
    };
  });
}

export async function upsertCampaignMailboxSettings(
  db: Db,
  workspaceId: string,
  connectionId: string,
  input: {
    dailyLimit: number;
    timezone: string;
    workingDays: number[];
    workStartMinute: number;
    workEndMinute: number;
  },
  now: Date = new Date()
): Promise<void> {
  if (!Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 1000)
    throw new Error('Mailbox daily limit must be a whole number from 1 to 1000.');
  if (!input.timezone.trim()) throw new Error('Mailbox timezone is required.');
  new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(now);
  if (input.workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    throw new Error('Mailbox working days must use weekday numbers 0-6.');
  if (
    !Number.isInteger(input.workStartMinute) ||
    !Number.isInteger(input.workEndMinute) ||
    input.workStartMinute < 0 ||
    input.workEndMinute > 1440 ||
    input.workEndMinute <= input.workStartMinute
  )
    throw new Error('Mailbox working hours must be valid minutes in one day.');
  const connection = await db
    .prepare(
      `SELECT id FROM connections WHERE workspace_id=? AND id=? AND status='connected' AND provider IN ('gmail','google-mail','microsoft','outlook')`
    )
    .get<{ id: string }>(workspaceId, connectionId);
  if (!connection) throw new Error('Connected Gmail or Microsoft 365 mailbox not found.');
  await db
    .prepare(
      `INSERT INTO linkedin_campaign_mailbox_settings (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
       VALUES (?,?,?, ?,?::jsonb,?,?,?::timestamptz,?::timestamptz)
       ON CONFLICT (workspace_id,connection_id) DO UPDATE SET daily_limit=excluded.daily_limit,timezone=excluded.timezone,
       working_days_json=excluded.working_days_json,work_start_minute=excluded.work_start_minute,work_end_minute=excluded.work_end_minute,updated_at=excluded.updated_at`
    )
    .run(
      workspaceId,
      connectionId,
      input.dailyLimit,
      input.timezone,
      JSON.stringify([...new Set(input.workingDays)]),
      input.workStartMinute,
      input.workEndMinute,
      now.toISOString(),
      now.toISOString()
    );
}
