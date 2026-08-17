import type { Db } from './db.js';
import {
  sendActionFailureEmail,
  sendIntegrationNeedsReauthEmail,
  smtpConfigured
} from './email.js';

interface OwnerRecipient {
  email: string;
  name: string;
}

function appBaseUrl(): string {
  return (process.env.BETTER_AUTH_URL ?? process.env.APP_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:43173').replace(/\/$/, '');
}

async function workspaceOwners(db: Db, workspaceId: string): Promise<OwnerRecipient[]> {
  if (!smtpConfigured()) return [];
  const owners = await db.prepare(`
    SELECT u.email,u.name
    FROM member m JOIN "user" u ON u.id=m."userId"
    WHERE m."organizationId"=? AND m.role='owner'
    ORDER BY m."createdAt" ASC
  `).all<{ email: string; name: string }>(workspaceId);
  if (owners.length > 0) return owners;

  // Legacy/self-hosted fallback. Hosted team workspaces should have Better Auth
  // membership rows, but a pre-organization workspace still has its original
  // Trevra owner row and should not silently lose an operational alert.
  return db.prepare('SELECT email,name FROM users WHERE workspace_id=? ORDER BY created_at ASC LIMIT 1')
    .all<OwnerRecipient>(workspaceId);
}

async function workspaceName(db: Db, workspaceId: string): Promise<string> {
  const row = await db.prepare('SELECT name FROM workspaces WHERE id=?').get<{ name: string }>(workspaceId);
  return row?.name || 'your workspace';
}

async function deliverOwners(owners: OwnerRecipient[], deliver: (owner: OwnerRecipient) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(owners.map(deliver));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) throw new Error(`Failed to deliver ${failed.length} of ${results.length} owner notification emails`);
}

export function safeOperationalReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/^Connect .+ before executing this action/i.test(message)) return message;
  if (/needs a Nango action script called '([^']+)'/i.test(message)) {
    const action = message.match(/needs a Nango action script called '([^']+)'/i)?.[1];
    return action ? `The required provider action '${action}' is not configured.` : 'The required provider action is not configured.';
  }
  if (/approval|payload no longer matches/i.test(message)) return 'The approved payload could not be safely executed. Review the action in Trevra.';
  if (/scheduled for later/i.test(message)) return 'The action is still scheduled for a later time.';
  return 'The connected provider did not confirm the action. Open Trevra for the full error details.';
}

export async function notifyActionFailure(db: Db, input: {
  workspaceId: string;
  actionType: string;
  recipient: string;
  messageSubject: string;
  provider: string;
  error: unknown;
}): Promise<void> {
  if (!smtpConfigured()) return;
  const owners = await workspaceOwners(db, input.workspaceId);
  if (owners.length === 0) return;
  const name = await workspaceName(db, input.workspaceId);
  const reviewUrl = appBaseUrl();
  const reason = safeOperationalReason(input.error);
  const label = input.actionType === 'email_draft'
    ? 'Send email'
    : input.actionType === 'invoice_draft'
      ? 'Create invoice'
      : input.actionType === 'change_order_draft'
        ? 'Create change order'
        : input.actionType;

  await deliverOwners(owners, (owner) => sendActionFailureEmail({
    to: owner.email,
    workspaceName: name,
    actionLabel: label,
    recipient: input.recipient,
    messageSubject: input.messageSubject,
    provider: input.provider,
    reason,
    reviewUrl
  }));
}

export async function notifyIntegrationNeedsReauth(db: Db, input: {
  workspaceId: string;
  provider: string;
  accountLabel?: string | null;
  reason?: string | null;
}): Promise<void> {
  if (!smtpConfigured()) return;
  const owners = await workspaceOwners(db, input.workspaceId);
  if (owners.length === 0) return;
  const name = await workspaceName(db, input.workspaceId);
  const reconnectUrl = `${appBaseUrl()}/setup/data`;
  const reason = input.reason?.trim() || 'The provider authorization expired or was rejected.';
  await deliverOwners(owners, (owner) => sendIntegrationNeedsReauthEmail({
    to: owner.email,
    workspaceName: name,
    provider: input.provider,
    accountLabel: input.accountLabel,
    reason,
    reconnectUrl
  }));
}
