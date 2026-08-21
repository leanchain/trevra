import { z } from 'zod';
import type { Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { projectPreparedConversationEmail } from '../conversations.js';
import { communityReplyPayloadSchema, publishCommunityReply } from '../outreach/publish.js';
import { crmActivityPayloadSchema, logCrmActivity } from '../crm/activity.js';
/**
 * External execution is intentionally a closed GTM action set.
 *
 * Trevra is not a generic webhook/action runtime. Adding a new action here means
 * adding a named GTM capability with its own payload schema, approval semantics,
 * execution adapter, and tests. Arbitrary action names are rejected.
 */
export const EXECUTION_ACTION_TYPES = [
  'email.send',
  'community.reply',
  'crm.log-activity'
] as const;
export type ExecutionActionType = (typeof EXECUTION_ACTION_TYPES)[number];
const actionTypeSchema = z.enum(EXECUTION_ACTION_TYPES);

const emailPayloadSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional()
});

export async function executePreparedPlaybookAction(
  db: Db,
  input: {
    workspaceId: string;
    actionType: ExecutionActionType | string;
    payload: unknown;
    payloadHash: string;
  }
): Promise<{ provider: string; externalRef: string; actionType: ExecutionActionType }> {
  const actionType = actionTypeSchema.parse(input.actionType);

  if (actionType === 'email.send') {
    const payload = emailPayloadSchema.parse(input.payload);
    const metadata = payload.metadata ?? {};
    const delivery = await executeConnectedAction(db, input.workspaceId, {
      type: 'email_draft',
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      structured_payload_json: JSON.stringify(metadata),
      payload_hash: input.payloadHash
    });
    const conversationId =
      typeof metadata.conversationId === 'string' ? metadata.conversationId : '';
    const personId = typeof metadata.personId === 'string' ? metadata.personId : '';
    if (conversationId && personId) {
      // The provider write has already succeeded. Shared Conversation is a
      // projection, so a projection failure must never turn this into a retry
      // of an external email side effect.
      try {
        await projectPreparedConversationEmail(db, {
          workspaceId: input.workspaceId,
          conversationId,
          personId,
          provider: delivery.provider,
          externalRef: delivery.externalRef,
          recipient: payload.recipient,
          subject: payload.subject,
          body: payload.body,
          payloadHash: input.payloadHash,
          actorType: 'system'
        });
      } catch {
        /* idempotent derived-state projection can be reconciled later */
      }
    }
    return { ...delivery, actionType };
  }

  if (actionType === 'community.reply') {
    const payload = communityReplyPayloadSchema.parse(input.payload);
    const now = new Date();
    const outcome = await publishCommunityReply(
      db,
      input.workspaceId,
      payload,
      input.payloadHash,
      now
    );

    // CRM mirroring happens after the public reply. It is best-effort so a CRM
    // outage can never cause Trevra to retry an external write that already happened.
    await recordOutreachInCrm(db, input.workspaceId, payload, outcome, now);
    return { provider: outcome.provider, externalRef: outcome.externalRef, actionType };
  }

  const payload = crmActivityPayloadSchema.parse(input.payload);
  const result = await logCrmActivity(db, input.workspaceId, payload, new Date());
  if (result.status === 'failed') throw new Error(result.reason ?? 'CRM activity write failed');
  return {
    provider: result.provider ?? 'none',
    externalRef: result.externalRef ?? `skipped:${result.reason ?? 'no CRM contact'}`,
    actionType
  };
}

/**
 * Mirror a delivered community reply into the CRM, if one is connected and the
 * thread author is somebody it already knows. Trevra never creates a contact
 * merely to have somewhere to write an activity.
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
    const threadTitle =
      typeof metadata.threadTitle === 'string' ? metadata.threadTitle : payload.threadUrl;
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
    // Swallowed on purpose. The external reply has already happened.
  }
}
