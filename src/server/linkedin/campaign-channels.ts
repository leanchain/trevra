import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { createSuppression } from '../suppressions.js';
import type { VerifiedEmailOutcome } from '../email-outcomes.js';
import { projectCampaignEmailDelivery, projectCampaignEmailReply } from '../conversations.js';
import { executeConnectedAction, readConnectedEmailThreadEvents } from '../integration-service.js';
import { campaignSnapshotSteps } from './managed-campaigns.js';
import { delayMilliseconds } from './workflows.js';
export type CampaignChannelKind = 'email' | 'find_email';
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
  tracking_token?: string | null;
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

function trackingOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.TREVRA_PUBLIC_API_URL ??
    env.BETTER_AUTH_URL ??
    env.APP_ORIGIN?.split(',')[0]?.trim() ??
    env.PUBLIC_SITE_URL ??
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (
      env.NODE_ENV === 'production' &&
      (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function trackableUrls(body: string): string[] {
  const found = body.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [
    ...new Set(
      found
        .map((value) => value.replace(/[),.;!?]+$/g, ''))
        .filter((value) => {
          try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
          } catch {
            return false;
          }
        })
    )
  ];
}

async function trackedHtmlBody(
  db: Db,
  row: ChannelRow,
  body: string,
  policy: 'off' | 'opens' | 'opens_clicks',
  now: Date
): Promise<string | null> {
  if (policy === 'off') return null;
  const origin = trackingOrigin();
  if (!origin) {
    throw new Error(
      'Email tracking requires a public HTTPS PUBLIC_SITE_URL (or equivalent app origin); tracking was requested but no recipient-reachable tracking origin is configured.'
    );
  }

  let token = row.tracking_token?.trim() || '';
  if (!token) {
    token = id('lietrk');
    const written = await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET tracking_token=?,updated_at=?::timestamptz
         WHERE workspace_id=? AND id=? AND tracking_token IS NULL RETURNING tracking_token`
      )
      .get<{ tracking_token: string }>(token, now.toISOString(), row.workspace_id, row.id);
    if (written?.tracking_token) token = written.tracking_token;
    else {
      token =
        (
          await db
            .prepare(
              `SELECT tracking_token FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?`
            )
            .get<{ tracking_token: string | null }>(row.workspace_id, row.id)
        )?.tracking_token ?? '';
    }
  }
  if (!token) throw new Error('Email tracking token could not be allocated.');

  const replacements = new Map<string, string>();
  if (policy === 'opens_clicks') {
    for (const target of trackableUrls(body)) {
      let link = await db
        .prepare(
          `SELECT token FROM linkedin_campaign_email_tracking_links
           WHERE workspace_id=? AND channel_action_id=? AND target_url=?`
        )
        .get<{ token: string }>(row.workspace_id, row.id, target);
      if (!link) {
        const linkToken = id('lietl');
        link = await db
          .prepare(
            `INSERT INTO linkedin_campaign_email_tracking_links
             (token,workspace_id,channel_action_id,target_url,created_at)
             VALUES (?,?,?,?,?::timestamptz)
             ON CONFLICT (workspace_id,channel_action_id,target_url)
             DO UPDATE SET target_url=excluded.target_url
             RETURNING token`
          )
          .get<{ token: string }>(linkToken, row.workspace_id, row.id, target, now.toISOString());
      }
      if (link?.token) {
        replacements.set(
          target,
          `${origin}/t/e/${encodeURIComponent(token)}/c/${encodeURIComponent(link.token)}`
        );
      }
    }
  }

  let escaped = escapeHtml(body);
  for (const [target, tracked] of replacements) {
    escaped = escaped.replaceAll(
      escapeHtml(target),
      `<a href="${escapeHtml(tracked)}">${escapeHtml(target)}</a>`
    );
  }
  escaped = escaped.replaceAll('\n', '<br>');
  return `${escaped}<img src="${origin}/t/e/${encodeURIComponent(token)}/open.gif" width="1" height="1" alt="" style="display:none" />`;
}

async function claimNext(db: Db, workspaceId: string, now: Date): Promise<ChannelRow | null> {
  return (
    (await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET status='claimed',claimed_at=?::timestamptz,attempt_count=attempt_count+1,updated_at=?::timestamptz
         WHERE id=(
           SELECT q.id
           FROM linkedin_campaign_channel_actions q
           JOIN linkedin_campaigns c
             ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
           JOIN linkedin_campaign_members m
             ON m.workspace_id=q.workspace_id AND m.id=q.member_id
           WHERE q.workspace_id=? AND q.status='planned' AND q.planned_for<=?::timestamptz
             AND q.claimed_at IS NULL AND c.status='running'
             AND m.status IN ('active','waiting')
             AND m.current_step_id=q.workflow_step_id
             AND NOT EXISTS (
               SELECT 1 FROM linkedin_actions r
               WHERE r.workspace_id=q.workspace_id AND r.campaign_member_id=q.member_id
                 AND r.status='replied'
             )
           ORDER BY q.planned_for ASC,q.created_at ASC,q.id ASC
           FOR UPDATE OF q SKIP LOCKED LIMIT 1
         )
         RETURNING id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,payload_json,variant_id,idempotency_key,connection_id,attempt_count,credits_used,tracking_token`
      )
      .get<ChannelRow>(now.toISOString(), now.toISOString(), workspaceId, now.toISOString())) ??
    null
  );
}

async function ensureEmailConnectionId(db: Db, row: ChannelRow, now: Date): Promise<void> {
  if (row.kind !== 'email' || row.connection_id) return;
  const connection = await db
    .prepare(
      `SELECT id FROM connections
       WHERE workspace_id=? AND status='connected'
         AND provider IN ('gmail','google-mail','microsoft','outlook')
       ORDER BY is_demo ASC,updated_at DESC LIMIT 1`
    )
    .get<{ id: string }>(row.workspace_id);
  if (!connection) return;
  await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions SET connection_id=?,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND connection_id IS NULL`
    )
    .run(connection.id, now.toISOString(), row.workspace_id, row.id);
  row.connection_id = connection.id;
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
  payload: Record<string, unknown>,
  now: Date
): Promise<{ provider: string; externalRef: string }> {
  const recipient = String(payload.recipient ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  const body = String(payload.body ?? '').trim();
  if (!recipient || !subject || !body)
    throw new Error('Email action requires recipient, subject, and body.');
  const threaded = payload.threaded === true;
  const tracking =
    payload.tracking === 'opens' || payload.tracking === 'opens_clicks'
      ? payload.tracking
      : ('off' as const);
  const htmlBody = await trackedHtmlBody(db, row, body, tracking, now);
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
      deliveryPurpose: 'outreach',
      deliverySourceType: 'campaign_email',
      deliverySourceId: row.id,
      campaignId: row.campaign_id,
      memberId: row.member_id,
      workflowStepId: row.workflow_step_id,
      htmlBody
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

function definiteFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /HTTP 4\d\d|requires recipient|no longer exists|Connect Gmail|Connect Microsoft|enrichment credit cap reached/i.test(
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
      `SELECT c.sequence_json,m.workflow_snapshot_json,m.current_step_id,m.completed_step_ids,m.step_index
       FROM linkedin_campaigns c
       JOIN linkedin_campaign_members m ON m.workspace_id=c.workspace_id AND m.campaign_id=c.id
       WHERE c.workspace_id=? AND c.id=? AND m.id=?`
    )
    .get<{
      sequence_json: unknown;
      workflow_snapshot_json: unknown;
      current_step_id: string | null;
      completed_step_ids: unknown;
      step_index: number;
    }>(row.workspace_id, row.campaign_id, row.member_id);
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
  const rawCompleted =
    typeof campaign.completed_step_ids === 'string'
      ? (() => {
          try {
            return JSON.parse(campaign.completed_step_ids) as unknown;
          } catch {
            return [];
          }
        })()
      : campaign.completed_step_ids;
  const completedStepIds = Array.isArray(rawCompleted)
    ? rawCompleted.filter((item): item is string => typeof item === 'string')
    : [];
  if (!completedStepIds.includes(current.id)) completedStepIds.push(current.id);
  const eligible = next
    ? new Date(now.getTime() + delayMilliseconds(next.delayBefore)).toISOString()
    : null;
  await db
    .prepare(
      `UPDATE linkedin_campaign_members SET step_index=?,current_step_id=?,completed_step_ids=?::jsonb,status=?,next_eligible_at=?::timestamptz,last_action_id=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status IN ('active','waiting')
         AND (current_step_id=? OR (current_step_id IS NULL AND step_index=?))`
    )
    .run(
      next ? nextIndex : steps.length,
      next?.id ?? null,
      JSON.stringify(completedStepIds),
      next ? 'waiting' : 'completed',
      eligible,
      now.toISOString(),
      row.workspace_id,
      row.member_id,
      row.workflow_step_id,
      currentIndex
    );
}

async function settleSuccess(
  db: Db,
  row: ChannelRow,
  outcome: { provider: string; externalRef: string },
  now: Date
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
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
      tx,
      row,
      {
        [`external:${row.kind}_success`]: true,
        ...(row.kind === 'find_email'
          ? { 'external:email_found': found, 'external:email_available': found }
          : {}),
        ...(row.kind === 'email' ? { 'external:email_sent': true } : {})
      },
      now
    );
    await advanceMemberAfterKnownOutcome(tx, row, now);
  });
}

async function settleFailure(
  db: Db,
  row: ChannelRow,
  error: unknown,
  now: Date
): Promise<'failed' | 'unknown'> {
  const known = definiteFailure(error);
  const status = known ? 'failed' : 'unknown';
  const message =
    error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
  if (!known) {
    // Unknown means exactly that. Do not leak a guessed false into branch state:
    // the side effect may have happened and must be resolved by a human/provider event.
    await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET status='unknown',claimed_at=NULL,last_error=?,outcome_known=FALSE,updated_at=?::timestamptz
         WHERE id=? AND workspace_id=?`
      )
      .run(message, now.toISOString(), row.id, row.workspace_id);
    return status;
  }

  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET status='failed',claimed_at=NULL,last_error=?,outcome_known=TRUE,updated_at=?::timestamptz
         WHERE id=? AND workspace_id=?`
      )
      .run(message, now.toISOString(), row.id, row.workspace_id);
    await mergeMemberExternalState(
      tx,
      row,
      {
        [`external:${row.kind}_success`]: false,
        ...(row.kind === 'find_email' ? { 'external:email_found': false } : {})
      },
      now
    );
    await advanceMemberAfterKnownOutcome(tx, row, now);
  });
  return status;
}

async function claimedChannelActionStillCurrent(db: Db, row: ChannelRow): Promise<boolean> {
  const live = await db
    .prepare(
      `SELECT 1 AS live
       FROM linkedin_campaign_channel_actions q
       JOIN linkedin_campaigns c ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
       JOIN linkedin_campaign_members m ON m.workspace_id=q.workspace_id AND m.id=q.member_id
       WHERE q.workspace_id=? AND q.id=? AND q.status='claimed'
         AND c.status='running' AND m.status IN ('active','waiting')
         AND m.current_step_id=q.workflow_step_id
         AND NOT EXISTS (
           SELECT 1 FROM linkedin_actions r
           WHERE r.workspace_id=q.workspace_id AND r.campaign_member_id=q.member_id
             AND r.status='replied'
         )`
    )
    .get<{ live: number }>(row.workspace_id, row.id);
  return live !== undefined;
}

async function retireStaleChannelClaim(db: Db, row: ChannelRow, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions
       SET status='skipped',claimed_at=NULL,last_error='The campaign/member moved before execution; no side effect was attempted.',updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status='claimed'`
    )
    .run(now.toISOString(), row.workspace_id, row.id);
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
        // Pin the fallback mailbox onto the action before pacing/sending so the
        // provider thread can be polled later for replies/bounces and retries
        // cannot drift to a different mailbox.
        await ensureEmailConnectionId(db, row, now);
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

      // The member may have replied, been skipped, branched, paused, or been ended
      // after this row was claimed. Re-read the authoritative campaign/member
      // cursor immediately before the external side effect.
      if (!(await claimedChannelActionStillCurrent(db, row))) {
        await retireStaleChannelClaim(db, row, now);
        continue;
      }

      const outcome =
        row.kind === 'email'
          ? await executeEmail(db, row, payload, now)
          : await executeFindEmail(db, row, payload, now);
      await settleSuccess(db, row, outcome, now);

      if (row.kind === 'email') {
        // Conversation projection is derived state. A projection failure must
        // never rewrite a provider-confirmed send into a failed/unknown send.
        try {
          await projectCampaignEmailDelivery(db, workspaceId, row.id, now);
        } catch {
          /* next reconciliation/backfill may safely retry this idempotent projection */
        }
      }
      result.sent += 1;
    } catch (error) {
      const status = await settleFailure(db, row, error, now);
      if (status === 'failed') result.failed += 1;
      else result.unknown += 1;
    }
  }
  return result;
  return result;
}
/** Resolve a provider side effect whose outcome was unknown without guessing or duplicating it. */
export async function resolveCampaignChannelUnknownOutcome(
  db: Db,
  workspaceId: string,
  actionId: string,
  resolution: 'sent' | 'retry' | 'skip',
  now: Date = new Date()
): Promise<{ resolved: boolean; memberId: string | null; campaignId: string | null }> {
  const row = await db
    .prepare(
      `SELECT id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,payload_json,
              variant_id,idempotency_key,connection_id,attempt_count,credits_used
       FROM linkedin_campaign_channel_actions
       WHERE workspace_id=? AND id=? AND status='unknown' AND outcome_known=FALSE`
    )
    .get<ChannelRow>(workspaceId, actionId);
  if (!row) return { resolved: false, memberId: null, campaignId: null };
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    if (resolution === 'retry') {
      await tx
        .prepare(
          `UPDATE linkedin_campaign_channel_actions
           SET status='planned',claimed_at=NULL,outcome_known=TRUE,last_error=NULL,
               planned_for=?::timestamptz,next_retry_at=NULL,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=? AND status='unknown' AND outcome_known=FALSE`
        )
        .run(timestamp, timestamp, workspaceId, actionId);
      await tx
        .prepare(
          `UPDATE linkedin_campaign_members SET status='waiting',next_eligible_at=?::timestamptz,
               last_failure_reason=NULL,updated_at=?::timestamptz WHERE workspace_id=? AND id=?`
        )
        .run(timestamp, timestamp, workspaceId, row.member_id);
      return;
    }

    const sent = resolution === 'sent';
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status=?,claimed_at=NULL,completed_at=?::timestamptz,outcome_known=TRUE,
             provider=COALESCE(provider,'operator'),external_ref=COALESCE(external_ref,?),
             last_error=?,updated_at=?::timestamptz
         WHERE workspace_id=? AND id=? AND status='unknown' AND outcome_known=FALSE`
      )
      .run(
        sent ? 'sent' : 'skipped',
        timestamp,
        sent ? 'operator-confirmed' : 'operator-skipped',
        sent ? null : 'Operator chose to skip this unresolved side effect.',
        timestamp,
        workspaceId,
        actionId
      );
    const found = row.kind === 'find_email' && sent;
    await mergeMemberExternalState(
      tx,
      row,
      {
        [`external:${row.kind}_success`]: sent,
        ...(row.kind === 'find_email'
          ? { 'external:email_found': found, 'external:email_available': found }
          : {}),
        ...(row.kind === 'email' && sent ? { 'external:email_sent': true } : {})
      },
      now
    );
    await advanceMemberAfterKnownOutcome(tx, row, now);
  });
  return { resolved: true, memberId: row.member_id, campaignId: row.campaign_id };
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
    eventKind: 'opened' | 'clicked' | VerifiedEmailOutcome;
    providerEventId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  },
  now: Date = new Date()
): Promise<{ recorded: boolean; memberId: string | null }> {
  const row = input.channelActionId
    ? await db
        .prepare(
          `SELECT a.id,a.member_id,a.campaign_id,a.contact_id,c.email,c.person_id
           FROM linkedin_campaign_channel_actions a
           JOIN linkedin_lead_contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id
          WHERE a.workspace_id=? AND a.id=? AND a.kind='email'`
        )
        .get<{
          id: string;
          member_id: string;
          campaign_id: string;
          contact_id: string;
          email: string | null;
          person_id: string | null;
        }>(workspaceId, input.channelActionId)
    : await db
        .prepare(
          `SELECT a.id,a.member_id,a.campaign_id,a.contact_id,c.email,c.person_id
           FROM linkedin_campaign_channel_actions a
           JOIN linkedin_lead_contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id
          WHERE a.workspace_id=? AND a.external_ref=? AND a.kind='email'
          ORDER BY a.completed_at DESC LIMIT 1`
        )
        .get<{
          id: string;
          member_id: string;
          campaign_id: string;
          contact_id: string;
          email: string | null;
          person_id: string | null;
        }>(workspaceId, input.externalRef ?? '');
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

  if ((input.eventKind === 'bounce' || input.eventKind === 'unsubscribe') && row.email) {
    const unsubscribe = input.eventKind === 'unsubscribe';
    // Verified unsubscribe intent and provider-confirmed hard bounce are durable
    // GTM safety state, not campaign-local telemetry. Generic delivery failures
    // do not suppress: a temporary/provider failure is not evidence that the
    // address must never be contacted again.
    await createSuppression(
      db,
      {
        workspaceId,
        channel: 'email',
        personId: row.person_id,
        email: row.email,
        reason: unsubscribe
          ? 'Recipient requested email unsubscribe'
          : 'Email delivery hard-bounced',
        source: unsubscribe ? 'campaign_email_unsubscribe' : 'campaign_email_bounce',
        sourceRef: input.providerEventId ?? row.id,
        actorType: 'system'
      },
      now
    );
  }

  if (input.eventKind === 'reply' || input.eventKind === 'unsubscribe') {
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

/** Public tracking pixel target. The opaque token reveals no workspace/action id. */
export async function recordCampaignEmailTrackingOpen(
  db: Db,
  token: string,
  now: Date = new Date()
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT workspace_id,id FROM linkedin_campaign_channel_actions
       WHERE tracking_token=? AND kind='email' AND status='sent'`
    )
    .get<{ workspace_id: string; id: string }>(token);
  if (!row) return false;
  await recordCampaignEmailEvent(
    db,
    row.workspace_id,
    {
      channelActionId: row.id,
      eventKind: 'opened',
      providerEventId: `tracking-open:${token}`,
      metadata: { source: 'trevra-pixel' }
    },
    now
  );
  return true;
}

/** Public click redirect. Returns null for an invalid token pair, otherwise the stored safe URL. */
export async function recordCampaignEmailTrackingClick(
  db: Db,
  actionToken: string,
  linkToken: string,
  now: Date = new Date()
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT a.workspace_id,a.id,l.target_url
       FROM linkedin_campaign_channel_actions a
       JOIN linkedin_campaign_email_tracking_links l
         ON l.workspace_id=a.workspace_id AND l.channel_action_id=a.id
       WHERE a.tracking_token=? AND l.token=? AND a.kind='email' AND a.status='sent'`
    )
    .get<{ workspace_id: string; id: string; target_url: string }>(actionToken, linkToken);
  if (!row) return null;
  let target: URL;
  try {
    target = new URL(row.target_url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  await recordCampaignEmailEvent(
    db,
    row.workspace_id,
    {
      channelActionId: row.id,
      eventKind: 'clicked',
      providerEventId: `tracking-click:${linkToken}`,
      metadata: { source: 'trevra-redirect' }
    },
    now
  );
  return target.toString();
}

export interface CampaignEmailTelemetrySyncResult {
  checked: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
  deliveryFailures: number;
  automatic: number;
  unknown: number;
  failed: number;
}

/**
 * Poll a bounded set of recently-sent Gmail/Microsoft campaign threads.
 * Reply/bounce evidence is provider-owned, while open/click evidence comes from
 * the opt-in Trevra tracking endpoints above. A ten-minute poll floor prevents
 * the minute scheduler from hammering mailbox APIs when nothing has changed.
 */
export async function syncCampaignEmailProviderEvents(
  db: Db,
  workspaceId: string,
  now: Date = new Date(),
  limit = 50,
  readThreadEvents: typeof readConnectedEmailThreadEvents = readConnectedEmailThreadEvents
): Promise<CampaignEmailTelemetrySyncResult> {
  const rows = await db
    .prepare(
      `SELECT q.id,q.connection_id,q.external_ref,q.payload_json
       FROM linkedin_campaign_channel_actions q
       WHERE q.workspace_id=? AND q.kind='email' AND q.status='sent'
         AND q.connection_id IS NOT NULL AND q.external_ref IS NOT NULL
         AND q.completed_at >= (?::timestamptz - INTERVAL '30 days')
         AND (q.telemetry_checked_at IS NULL OR q.telemetry_checked_at <= (?::timestamptz - INTERVAL '10 minutes'))
         AND NOT EXISTS (
           SELECT 1 FROM linkedin_campaign_email_events e
           WHERE e.workspace_id=q.workspace_id AND e.channel_action_id=q.id
             AND e.event_kind IN ('reply','unsubscribe','bounce','delivery_failure')
         )
       ORDER BY COALESCE(q.telemetry_checked_at,q.completed_at) ASC,q.id ASC
       LIMIT ?`
    )
    .all<{
      id: string;
      connection_id: string;
      external_ref: string;
      payload_json: unknown;
    }>(workspaceId, now.toISOString(), now.toISOString(), Math.max(1, Math.min(200, limit)));

  const result: CampaignEmailTelemetrySyncResult = {
    checked: 0,
    replied: 0,
    unsubscribed: 0,
    bounced: 0,
    deliveryFailures: 0,
    automatic: 0,
    unknown: 0,
    failed: 0
  };
  for (const row of rows) {
    const payload = objectOf(row.payload_json);
    const recipient = String(payload.recipient ?? '').trim();
    if (!recipient) continue;
    try {
      const events = await readThreadEvents(db, workspaceId, {
        localConnectionId: row.connection_id,
        externalRef: row.external_ref,
        recipient
      });
      result.checked += 1;
      for (const event of events) {
        // Only recipient-originated provider-thread messages become Person
        // transcript entries. Delivery daemon evidence remains a delivery event,
        // not a fabricated message from the prospect.
        if (!['bounce', 'delivery_failure'].includes(event.kind) && event.body?.trim()) {
          await projectCampaignEmailReply(
            db,
            workspaceId,
            {
              channelActionId: row.id,
              providerEventId: event.providerEventId,
              body: event.body,
              outcomeKind: event.kind,
              subject: event.subject ?? null,
              occurredAt: event.occurredAt ?? null
            },
            now
          );
        }
        const recorded = await recordCampaignEmailEvent(
          db,
          workspaceId,
          {
            channelActionId: row.id,
            eventKind: event.kind,
            providerEventId: event.providerEventId,
            occurredAt: event.occurredAt,
            metadata: {
              source: 'mailbox-thread-sync',
              ...(event.sender ? { sender: event.sender } : {}),
              ...(event.subject ? { subject: event.subject } : {})
            }
          },
          now
        );
        if (recorded.recorded) {
          if (event.kind === 'reply') result.replied += 1;
          else if (event.kind === 'unsubscribe') result.unsubscribed += 1;
          else if (event.kind === 'bounce') result.bounced += 1;
          else if (event.kind === 'delivery_failure') result.deliveryFailures += 1;
          else if (event.kind === 'out_of_office' || event.kind === 'auto_reply')
            result.automatic += 1;
          else result.unknown += 1;
        }
      }
    } catch {
      // Mailbox telemetry is observational. A temporary provider/read failure must
      // not turn an already-sent email into a failed campaign action.
      result.failed += 1;
    } finally {
      await db
        .prepare(
          `UPDATE linkedin_campaign_channel_actions SET telemetry_checked_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=? AND status='sent'`
        )
        .run(now.toISOString(), now.toISOString(), workspaceId, row.id);
    }
  }
  return result;
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
