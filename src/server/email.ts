import nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  fromName: string;
}

const SMTP_KEYS = ['SMTP_SERVER', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'EMAIL_FROM'] as const;

export function smtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const present = SMTP_KEYS.filter((key) => Boolean(env[key]?.trim()));
  if (present.length === 0) return null;
  if (present.length !== SMTP_KEYS.length) {
    const missing = SMTP_KEYS.filter((key) => !env[key]?.trim());
    throw new Error(`SMTP configuration is incomplete; missing ${missing.join(', ')}`);
  }

  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }

  return {
    host: env.SMTP_SERVER!.trim(),
    port,
    username: env.SMTP_USERNAME!.trim(),
    password: env.SMTP_PASSWORD!,
    from: env.EMAIL_FROM!.trim(),
    fromName: env.EMAIL_FROM_NAME?.trim() || 'Trevra'
  };
}

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return smtpConfig(env) !== null;
}

export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const config = smtpConfig();
  if (!config) return;

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: {
      user: config.username,
      pass: config.password
    },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000
  });

  await transporter.sendMail({
    from: { name: config.fromName, address: config.from },
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html
  });
}

export async function sendOrganizationInvitationEmail(input: {
  to: string;
  inviteLink: string;
  inviterName: string;
  inviterEmail: string;
  organizationName: string;
  role: string | string[];
  expiresAt?: Date | string | null;
}): Promise<void> {
  const role = Array.isArray(input.role) ? input.role.join(', ') : input.role;
  const subject = `${input.inviterName} invited you to ${input.organizationName} on Trevra`;
  const expires = input.expiresAt ? `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(input.expiresAt))} UTC` : null;
  const text = [
    `${input.inviterName} (${input.inviterEmail}) invited you to join ${input.organizationName} as ${role}.`,
    '',
    'Open this link to review and accept the invitation:',
    input.inviteLink,
    '',
    'You will need to sign in with the invited email address before accepting.',
    expires ? `Invitation expires: ${expires}` : '',
    'If you were not expecting this invitation, you can ignore this email.'
  ].filter(Boolean).join('\n');
  const html = `
    <p><strong>${escapeHtml(input.inviterName)}</strong> (${escapeHtml(input.inviterEmail)}) invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(role)}.</p>
    <p><a href="${escapeHtml(input.inviteLink)}">Accept invitation</a></p>
    <p>You will need to sign in with the invited email address before accepting.</p>
    ${expires ? `<p>Invitation expires: ${escapeHtml(expires)}</p>` : ''}
    <p>If you were not expecting this invitation, you can ignore this email.</p>
  `.trim();
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendInvitationAcceptedEmail(input: {
  to: string;
  memberName: string;
  memberEmail: string;
  organizationName: string;
  role: string | string[];
  manageTeamUrl: string;
}): Promise<void> {
  const role = Array.isArray(input.role) ? input.role.join(', ') : input.role;
  const subject = `${input.memberName} joined ${input.organizationName}`;
  const text = [
    `${input.memberName} (${input.memberEmail}) accepted your Trevra invitation and joined ${input.organizationName} as ${role}.`,
    '',
    `Manage team: ${input.manageTeamUrl}`
  ].join('\n');
  const html = `
    <p><strong>${escapeHtml(input.memberName)}</strong> (${escapeHtml(input.memberEmail)}) accepted your invitation and joined <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(role)}.</p>
    <p><a href="${escapeHtml(input.manageTeamUrl)}">Manage team</a></p>
  `.trim();
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendWorkspaceAccessRemovedEmail(input: {
  to: string;
  memberName: string;
  organizationName: string;
  signInUrl: string;
  supportEmail?: string | null;
}): Promise<void> {
  const subject = `Your access to ${input.organizationName} was removed`;
  const support = input.supportEmail?.trim();
  const text = [
    `Hi ${input.memberName},`,
    '',
    `Your access to the ${input.organizationName} workspace in Trevra was removed.`,
    'Your Trevra account remains available, including any other workspaces you can access.',
    '',
    `Trevra: ${input.signInUrl}`,
    support ? `Questions? Contact ${support}.` : ''
  ].filter(Boolean).join('\n');
  const html = `
    <p>Hi ${escapeHtml(input.memberName)},</p>
    <p>Your access to the <strong>${escapeHtml(input.organizationName)}</strong> workspace in Trevra was removed.</p>
    <p>Your Trevra account remains available, including any other workspaces you can access.</p>
    <p><a href="${escapeHtml(input.signInUrl)}">Open Trevra</a></p>
    ${support ? `<p>Questions? Contact ${escapeHtml(support)}.</p>` : ''}
  `.trim();
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendActionFailureEmail(input: {
  to: string;
  workspaceName: string;
  actionLabel: string;
  recipient: string;
  messageSubject: string;
  provider: string;
  reason: string;
  reviewUrl: string;
}): Promise<void> {
  const subject = `Trevra could not complete an approved action`;
  const text = [
    `An approved action in ${input.workspaceName} could not be confirmed as completed.`,
    '',
    `Action: ${input.actionLabel}`,
    `Recipient: ${input.recipient}`,
    `Subject: ${input.messageSubject}`,
    `Provider: ${input.provider}`,
    `Reason: ${input.reason}`,
    '',
    'Trevra did not receive a successful completion confirmation. If the provider may have accepted the request before the error, check the provider before retrying to avoid a duplicate.',
    '',
    `Review in Trevra: ${input.reviewUrl}`
  ].join('\n');
  const html = `
    <p>An approved action in <strong>${escapeHtml(input.workspaceName)}</strong> could not be confirmed as completed.</p>
    <p><strong>Action:</strong> ${escapeHtml(input.actionLabel)}<br />
    <strong>Recipient:</strong> ${escapeHtml(input.recipient)}<br />
    <strong>Subject:</strong> ${escapeHtml(input.messageSubject)}<br />
    <strong>Provider:</strong> ${escapeHtml(input.provider)}<br />
    <strong>Reason:</strong> ${escapeHtml(input.reason)}</p>
    <p>Trevra did not receive a successful completion confirmation. If the provider may have accepted the request before the error, check the provider before retrying to avoid a duplicate.</p>
    <p><a href="${escapeHtml(input.reviewUrl)}">Review in Trevra</a></p>
  `.trim();
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendIntegrationNeedsReauthEmail(input: {
  to: string;
  workspaceName: string;
  provider: string;
  accountLabel?: string | null;
  reason: string;
  reconnectUrl: string;
}): Promise<void> {
  const providerName = humanProvider(input.provider);
  const subject = `${providerName} needs to be reconnected in Trevra`;
  const text = [
    `${providerName}${input.accountLabel ? ` (${input.accountLabel})` : ''} can no longer be used by ${input.workspaceName}.`,
    '',
    `Reason: ${input.reason}`,
    'Until it is reconnected, Trevra may continue preparing work but cannot reliably sync or execute actions through this connection.',
    '',
    `Reconnect: ${input.reconnectUrl}`
  ].join('\n');
  const html = `
    <p><strong>${escapeHtml(providerName)}</strong>${input.accountLabel ? ` (${escapeHtml(input.accountLabel)})` : ''} can no longer be used by <strong>${escapeHtml(input.workspaceName)}</strong>.</p>
    <p><strong>Reason:</strong> ${escapeHtml(input.reason)}</p>
    <p>Until it is reconnected, Trevra may continue preparing work but cannot reliably sync or execute actions through this connection.</p>
    <p><a href="${escapeHtml(input.reconnectUrl)}">Reconnect ${escapeHtml(providerName)}</a></p>
  `.trim();
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

function humanProvider(provider: string): string {
  const key = provider.toLowerCase();
  if (['gmail', 'google-mail'].includes(key)) return 'Gmail';
  if (['microsoft', 'outlook'].includes(key)) return 'Microsoft 365';
  if (key === 'quickbooks') return 'QuickBooks';
  if (key === 'xero') return 'Xero';
  if (key === 'stripe') return 'Stripe';
  if (key === 'hubspot') return 'HubSpot';
  if (key === 'attio') return 'Attio';
  if (key === 'reddit') return 'Reddit';
  return provider;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
