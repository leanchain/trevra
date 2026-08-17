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

export async function sendOrganizationInvitationEmail(input: {
  to: string;
  inviteLink: string;
  inviterName: string;
  inviterEmail: string;
  organizationName: string;
  role: string | string[];
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

  const role = Array.isArray(input.role) ? input.role.join(', ') : input.role;
  const subject = `${input.inviterName} invited you to ${input.organizationName} on Trevra`;
  const text = [
    `${input.inviterName} (${input.inviterEmail}) invited you to join ${input.organizationName} as ${role}.`,
    '',
    'Open this link to review and accept the invitation:',
    input.inviteLink,
    '',
    'You will need to sign in with the invited email address before accepting.'
  ].join('\n');
  const html = `
    <p><strong>${escapeHtml(input.inviterName)}</strong> (${escapeHtml(input.inviterEmail)}) invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(role)}.</p>
    <p><a href="${escapeHtml(input.inviteLink)}">Review and accept the invitation</a></p>
    <p>You will need to sign in with the invited email address before accepting.</p>
  `.trim();

  await transporter.sendMail({
    from: { name: config.fromName, address: config.from },
    to: input.to,
    subject,
    text,
    html
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
