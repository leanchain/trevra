import { createHmac } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import type { Db } from '../db.js';
import { stableJson } from './payload.js';
import { executeConnectedAction } from '../integration-service.js';
import { communityReplyPayloadSchema, publishCommunityReply } from '../outreach/publish.js';
import { crmActivityPayloadSchema, logCrmActivity } from '../crm/activity.js';
import { exportCampaign, linkedinExportPayloadSchema } from '../linkedin/export.js';
import { linkedinQueuePayloadSchema, queueCampaign } from '../linkedin/queue.js';

export type ExecutionActionType = string;

const actionTypeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{2,119}$/);

const emailPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional()
});

const invoicePayloadSchema = z.object({
  recipient: z.string().email(),
  amount: z.number().positive().max(10_000_000),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  description: z.string().min(1).max(500),
  dueDays: z.number().int().min(0).max(365).default(14),
  message: z.string().max(20_000).default('')
});

const changeOrderPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  amount: z.number().nonnegative().max(10_000_000),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  description: z.string().min(1).max(500)
});

const remoteActionAdapterSchema = z.object({
  actionType: actionTypeSchema,
  endpoint: z.string().url(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  provider: z.string().trim().min(1).max(100).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  payloadSchema: z.record(z.unknown()).optional()
});

export type RemoteActionAdapterConfig = z.infer<typeof remoteActionAdapterSchema>;

export async function executePreparedPlaybookAction(
  db: Db,
  input: {
    workspaceId: string;
    actionType: ExecutionActionType;
    payload: unknown;
    payloadHash: string;
  }
): Promise<{ provider: string; externalRef: string; actionType: ExecutionActionType }> {
  const actionType = actionTypeSchema.parse(input.actionType);
  if (actionType === 'email.send') {
    const payload = emailPayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify(payload.metadata ?? {}),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }
  if (actionType === 'invoice.create') {
    const payload = invoicePayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'invoice_draft',
      recipient: payload.recipient,
      subject: payload.description,
      body: payload.message,
      structured_payload_json: JSON.stringify({
        recipient: payload.recipient,
        amount: payload.amount,
        currency: payload.currency,
        description: payload.description,
        dueDays: payload.dueDays
      }),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }
  if (actionType === 'change_order.create') {
    const payload = changeOrderPayloadSchema.parse(input.payload);
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'change_order_draft',
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify({
        recipient: payload.recipient,
        amount: payload.amount,
        currency: payload.currency,
        description: payload.description
      }),
      payload_hash: input.payloadHash
    });
    return { ...delivery, actionType };
  }

  if (actionType === 'community.reply') {
    // Posting a reply into someone else's thread. Unlike the three action
    // types above it routes through no connection: the credential is the
    // founder's own platform token, and whether Trevra may press the button at
    // all is decided by the channel adapter's automation mode inside
    // `publishCommunityReply`. A platform that forbids unattended posting
    // yields a manual handoff, never a post.
    const payload = communityReplyPayloadSchema.parse(input.payload);
    const now = new Date();
    const outcome = await publishCommunityReply(db, input.workspaceId, payload, input.payloadHash, now);

    // Close the loop into the CRM the team actually works in. Best-effort and
    // deliberately AFTER the post: the reply is already public, so a CRM outage
    // must never turn a delivered reply into a failed action that the engine
    // then retries. Whatever happens here is recorded in `crm_activities`.
    await recordOutreachInCrm(db, input.workspaceId, payload, outcome, now);

    return { provider: outcome.provider, externalRef: outcome.externalRef, actionType };
  }

  if (actionType === 'crm.log-activity') {
    // Standalone, so any playbook can append evidence to a CRM record under the
    // same approval gate -- not only outreach.
    const payload = crmActivityPayloadSchema.parse(input.payload);
    const result = await logCrmActivity(db, input.workspaceId, payload, new Date());
    if (result.status === 'failed') throw new Error(result.reason ?? 'CRM activity write failed');
    return {
      provider: result.provider ?? 'none',
      externalRef: result.externalRef ?? `skipped:${result.reason ?? 'no CRM contact'}`,
      actionType
    };
  }

  if (actionType === 'linkedin.export') {
    // The one action type whose "external write" is a file the OPERATOR runs.
    // Trevra opens no connection to LinkedIn here and holds no credential for
    // it (plan 3, option d): the campaign is rendered for the user's own tool,
    // and every export says in its own header block that the ToS relationship
    // is theirs.
    //
    // The side effect that IS ours is the ledger. `exportCampaign` writes the
    // plan's slots into `linkedin_actions` as `exported`, dated at the slot
    // rather than at now, which is what makes the next plan's day-over-day
    // arithmetic describe a real seat instead of an empty one. That write is
    // idempotent on (workspace, seat, kind, target), so the engine's retry of
    // an action whose outcome was unknown cannot double-count a target.
    const payload = linkedinExportPayloadSchema.parse(input.payload);
    const result = await exportCampaign(
      db,
      {
        workspaceId: input.workspaceId,
        plan: payload.plan,
        sequence: payload.sequence,
        format: payload.format,
        ...(payload.contacts === undefined ? {} : { contacts: payload.contacts }),
        campaignId: payload.campaignId ?? null,
        payloadHash: input.payloadHash
      },
      new Date()
    );
    return {
      provider: `trevra-export:${result.format}`,
      externalRef: result.filename,
      actionType
    };
  }

  if (actionType === 'linkedin.queue') {
    // The sibling of `linkedin.export`, for the deployment that drives the
    // browser itself: instead of rendering a file, it writes the approved plan's
    // slots into `linkedin_actions` as 'planned' rows the local worker can
    // claim. Nothing is sent here and nothing is gated here -- the slots are
    // days in the future, and `runLinkedInLocalBatch` re-runs the safety gate
    // per action immediately before it acts, because approval is a decision
    // about CONTENT and the clock keeps moving afterwards.
    //
    // IT IS `queue`, NOT `send`. This action's entire external effect is a set
    // of rows in Trevra's own database; a name that claimed otherwise would be
    // a string a human reads that is not true, which docs/app-spec.md section 6
    // forbids. It is still classed `external-write` by `runActionStep` like
    // every other action step, so the built-in policy boundary requires an
    // approval -- and the queue writes the payload hash that approval bound onto
    // every row.
    //
    // Idempotent on (workspace, seat, kind, target), so the engine's retry of an
    // action whose outcome was unknown cannot queue a target twice.
    //
    // No `queuedByUserId`: this executor runs an already-approved action, which
    // can happen outside any live request (an automation rule executing its own
    // delegated approval), so there is no captured human actor to attribute the
    // row to here. The route that replays the same approved payload synchronously
    // (`POST /api/linkedin/campaigns/:id/queue`, app.ts) DOES set it, from
    // `req.auth.userId` -- see `LinkedInActionRecord.queuedByUserId`.
    const payload = linkedinQueuePayloadSchema.parse(input.payload);
    const result = await queueCampaign(
      db,
      {
        workspaceId: input.workspaceId,
        plan: payload.plan,
        sequence: payload.sequence,
        ...(payload.contacts === undefined ? {} : { contacts: payload.contacts }),
        campaignId: payload.campaignId ?? null,
        payloadHash: input.payloadHash
      },
      new Date()
    );
    return {
      provider: 'trevra-linkedin-worker',
      externalRef: `linkedin-queue:${payload.campaignId ?? result.seatKey}:${result.recorded.written}/${result.recorded.attempted}`,
      actionType
    };
  }

  const adapter = listRemoteActionAdapters().find((candidate) => candidate.actionType === actionType);
  if (!adapter) throw new Error(`No approved action adapter is configured for ${actionType}`);
  validateRemotePayload(adapter, input.payload);
  const delivery = await executeRemoteActionAdapter(adapter, {
    workspaceId: input.workspaceId,
    actionType,
    payload: input.payload,
    payloadHash: input.payloadHash
  });
  return { ...delivery, actionType };
}

/**
 * Mirror a delivered community reply into the CRM, if one is connected and the
 * thread's author is somebody it already knows.
 *
 * Never throws. The reply has already been posted by the time this runs; a
 * failure here is a bookkeeping problem, not a delivery problem, and letting it
 * propagate would fail the action step and trigger a retry of an action whose
 * external write already succeeded.
 *
 * The common outcome is `skipped` — a random GitHub handle belongs to nobody in
 * the CRM, and Trevra does not create a contact to have somewhere to write.
 */
async function recordOutreachInCrm(
  db: Db,
  workspaceId: string,
  payload: z.infer<typeof communityReplyPayloadSchema>,
  outcome: { status: string; postId: string },
  now: Date
): Promise<void> {
  try {
    const metadata = payload.metadata ?? {};
    const author = typeof metadata.threadAuthor === 'string' ? metadata.threadAuthor : null;
    const threadTitle = typeof metadata.threadTitle === 'string' ? metadata.threadTitle : payload.threadUrl;
    const verb = outcome.status === 'posted' ? 'Replied' : 'Reply prepared';

    await logCrmActivity(
      db,
      workspaceId,
      {
        contact: { handle: author, handleProvider: payload.platform, email: null, domain: null },
        activityType: 'community_reply',
        subject: `${verb} on ${payload.platform}: ${threadTitle}`.slice(0, 300),
        body: payload.body,
        url: payload.threadUrl,
        occurredAt: now.toISOString(),
        sourceType: 'outreach_post',
        sourceId: outcome.postId
      },
      now
    );
  } catch {
    // Swallowed on purpose. See the doc comment.
  }
}

export function listRemoteActionAdapters(env: NodeJS.ProcessEnv = process.env): RemoteActionAdapterConfig[] {
  const raw = env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('TREVRA_REMOTE_ACTION_ADAPTERS_JSON must contain valid JSON'); }
  const adapters = z.array(remoteActionAdapterSchema).max(100).parse(parsed);
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.actionType)) throw new Error(`Duplicate remote action adapter: ${adapter.actionType}`);
    seen.add(adapter.actionType);
    const endpoint = new URL(adapter.endpoint);
    if (env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
      throw new Error(`Remote action adapter ${adapter.actionType} must use HTTPS in production`);
    }
  }
  return adapters;
}

async function executeRemoteActionAdapter(
  adapter: RemoteActionAdapterConfig,
  input: { workspaceId: string; actionType: string; payload: unknown; payloadHash: string }
): Promise<{ provider: string; externalRef: string }> {
  const token = process.env[adapter.tokenEnv]?.trim();
  if (!token) throw new Error(`Remote action adapter ${adapter.actionType} requires ${adapter.tokenEnv}`);
  const body = {
    actionType: input.actionType,
    workspaceId: input.workspaceId,
    idempotencyKey: input.payloadHash,
    payload: input.payload
  };
  const serialized = stableJson(body);
  const signature = createHmac('sha256', token).update(serialized).digest('hex');
  const response = await fetch(adapter.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Trevra-Action': input.actionType,
      'X-Trevra-Idempotency-Key': input.payloadHash,
      'X-Trevra-Signature': `sha256=${signature}`
    },
    body: serialized,
    redirect: 'error',
    signal: AbortSignal.timeout(adapter.timeoutSeconds * 1000)
  });
  const result = await response.json().catch(() => ({ error: response.statusText })) as {
    provider?: unknown;
    externalRef?: unknown;
    id?: unknown;
    error?: unknown;
  };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Action adapter returned ${response.status}`);
  const externalRef = result.externalRef ?? result.id;
  if (typeof externalRef !== 'string' || !externalRef.trim()) {
    throw new Error(`Remote action adapter ${adapter.actionType} returned no external reference`);
  }
  return {
    provider: typeof result.provider === 'string' && result.provider.trim() ? result.provider : adapter.provider ?? 'custom',
    externalRef
  };
}

function validateRemotePayload(adapter: RemoteActionAdapterConfig, payload: unknown): void {
  if (!adapter.payloadSchema) return;
  let validator: ValidateFunction;
  try { validator = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true }).compile(adapter.payloadSchema); }
  catch (error) {
    throw new Error(`Payload schema for ${adapter.actionType} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (validator(payload)) return;
  const issues = (validator.errors ?? []).map((item) => `${item.instancePath || '/'} ${item.message ?? 'is invalid'}`).join('; ');
  throw new Error(`Payload for ${adapter.actionType} failed validation: ${issues}`);
}
