import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Db } from './db.js';
import { id } from './db.js';
import { listPublicModulePopularity, listPublicRegistryModules } from './registry/service.js';

const PRODUCT_DESCRIPTION = 'Trevra is the open-source operating system and control plane for agent-run go-to-market. Give Claude Code or Codex a revenue outcome, compose modular skills, record every run with evidence, and gate consequential work behind workspace policy.';
const PUBLIC_PATHS = ['/', '/how-it-works', '/security', '/privacy', '/terms'] as const;

export type MarketingEventName =
  | 'page_view'
  | 'signup_started'
  | 'email_signup_submitted'
  | 'google_auth_started'
  | 'signup_completed'
  | 'demo_started'
  | 'integration_connect_started'
  | 'document_imported'
  | 'marketplace_imported'
  | 'action_prepared'
  | 'action_approved'
  | 'action_executed'
  | 'marketing_primary_cta'
  | 'marketing_source_cta'
  | 'marketing_catalog_json'
  | 'marketing_self_host_cta'
  | 'marketing_founder_cta';

export interface SiteConfig {
  origin: string;
  name: string;
  legalName: string;
  title: string;
  description: string;
  supportEmail: string;
  securityEmail: string;
  googleVerification: string;
  bingVerification: string;
  indexNowKey: string;
}

interface MarketingEventInput {
  eventName: MarketingEventName;
  visitorId?: string | null;
  workspaceId?: string | null;
  path?: string | null;
  referrer?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

const eventNameSchema = z.enum([
  'page_view',
  'signup_started',
  'email_signup_submitted',
  'google_auth_started',
  'signup_completed',
  'demo_started',
  'integration_connect_started',
  'document_imported',
  'marketplace_imported',
  'action_prepared',
  'action_approved',
  'action_executed',
  'marketing_primary_cta',
  'marketing_source_cta',
  'marketing_catalog_json',
  'marketing_self_host_cta',
  'marketing_founder_cta'
]);

const marketingEventSchema = z.object({
  eventName: eventNameSchema,
  visitorId: z.string().min(8).max(128).optional(),
  path: z.string().max(500).optional(),
  referrer: z.string().max(2000).optional(),
  source: z.string().max(120).optional(),
  medium: z.string().max(120).optional(),
  campaign: z.string().max(200).optional(),
  content: z.string().max(200).optional(),
  term: z.string().max(200).optional(),
  metadata: z.record(z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional()
});

export function getSiteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const rawOrigin = env.PUBLIC_SITE_URL ?? env.BETTER_AUTH_URL ?? env.APP_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:43173';
  const origin = new URL(rawOrigin).origin;
  const hostname = new URL(origin).hostname;
  return {
    origin,
    name: env.PUBLIC_SITE_NAME?.trim() || 'Trevra',
    legalName: env.PUBLIC_LEGAL_NAME?.trim() || 'Trevra',
    title: env.PUBLIC_SITE_TITLE?.trim() || 'Trevra — Spawn Your Agent-Run GTM Team',
    description: env.PUBLIC_SITE_DESCRIPTION?.trim() || PRODUCT_DESCRIPTION,
    supportEmail: env.PUBLIC_SUPPORT_EMAIL?.trim() || `support@${hostname}`,
    securityEmail: env.SECURITY_CONTACT_EMAIL?.trim() || env.PUBLIC_SUPPORT_EMAIL?.trim() || `security@${hostname}`,
    googleVerification: env.GOOGLE_SITE_VERIFICATION?.trim() || '',
    bingVerification: env.BING_SITE_VERIFICATION?.trim() || '',
    indexNowKey: env.INDEXNOW_KEY?.trim() || ''
  };
}

export function registerPublicSiteRoutes(app: Express, db: Db): void {
  const config = getSiteConfig();
  const publicLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

  const registryCorsOrigins = new Set((process.env.PUBLIC_REGISTRY_CORS_ORIGIN || config.origin).split(',').map((item) => item.trim()).filter(Boolean));
  const publicRegistryHeaders = (req: express.Request, res: Response) => {
    const requestOrigin = req.header('origin');
    const allowedOrigin = requestOrigin && registryCorsOrigins.has(requestOrigin) ? requestOrigin : [...registryCorsOrigins][0] ?? config.origin;
    res.set({
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      Vary: 'Origin'
    });
  };
  app.get('/api/public/module-popularity', publicLimiter, async (req, res, next) => {
    try {
      publicRegistryHeaders(req, res);
      res.json({ schemaVersion: '1.0.0', generatedAt: new Date().toISOString(), modules: await listPublicModulePopularity(db) });
    } catch (error) { next(error); }
  });
  app.get('/api/public/modules', publicLimiter, async (req, res, next) => {
    try {
      publicRegistryHeaders(req, res);
      res.json({ schemaVersion: '1.0.0', generatedAt: new Date().toISOString(), modules: await listPublicRegistryModules(db) });
    } catch (error) { next(error); }
  });
  app.get('/api/public/modules/:id', publicLimiter, async (req, res, next) => {
    try {
      publicRegistryHeaders(req, res);
      const modules = await listPublicRegistryModules(db);
      const module = modules.find((item) => item.id === String(req.params.id));
      if (!module) return res.status(404).json({ error: 'Public module not found' });
      res.json({ module });
    } catch (error) { next(error); }
  });

  app.get('/robots.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send([
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      '',
      `Sitemap: ${config.origin}/sitemap.xml`,
      `Host: ${new URL(config.origin).host}`,
      ''
    ].join('\n'));
  });

  app.get('/sitemap.xml', (_req, res) => {
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    const urls = PUBLIC_PATHS.map((path) => `  <url><loc>${escapeXml(`${config.origin}${path}`)}</loc></url>`).join('\n');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get('/llms.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send(renderLlmsText(config, false));
  });

  app.get('/llms-full.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send(renderLlmsText(config, true));
  });

  app.get('/agents.md', (_req, res) => {
    res.type('text/markdown; charset=utf-8').set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.send(renderPublicAgents(config));
  });

  app.get('/humans.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send(`/* TEAM */\nProduct: Trevra\nContact: ${config.supportEmail}\n\n/* PRODUCT */\nTrevra is the open-source ledger and control plane founders point their agents at. The agent does the work; Trevra records the evidence and holds the approval gate.\n\n/* STANDARDS */\nHTML5, accessibility-minded React, PostgreSQL, robots.txt, sitemap.xml, llms.txt, and RFC 9116 security.txt.\n`);
  });

  app.get('/.well-known/security.txt', (_req, res) => {
    setTextResponse(res, 86400);
    const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().replace('.000Z', 'Z');
    const secureOrigin = config.origin.startsWith('https://');
    const lines = [
      `Contact: mailto:${config.securityEmail}`,
      `Expires: ${expires}`,
      'Preferred-Languages: en'
    ];
    if (secureOrigin) lines.push(`Canonical: ${config.origin}/.well-known/security.txt`, `Policy: ${config.origin}/security`);
    res.send(`${lines.join('\n')}\n`);
  });

  app.get('/security.txt', (_req, res) => res.redirect(308, '/.well-known/security.txt'));

  if (config.indexNowKey) {
    app.get(`/${config.indexNowKey}.txt`, (_req, res) => {
      setTextResponse(res, 86400);
      res.send(config.indexNowKey);
    });
  }

  app.get('/how-it-works', (_req, res) => sendPublicPage(res, config, {
    path: '/how-it-works',
    title: 'How Trevra Works | Agentic GTM Ledger and Control Plane',
    description: 'See how Trevra records agent runs, reconstructs the revenue loop from source to paid, builds proof packs, and holds every consequential action at an approval gate.',
    eyebrow: 'How it works',
    heading: 'Claude runs the loop. Trevra keeps the record.',
    intro: 'Trevra is the memory and the control plane behind agent-operated go-to-market: every run recorded, every action evidenced, every consequential step gated on your approval.',
    body: `<section class="launch-grid launch-grid-four">
      ${feature('1', 'Connect the source systems', 'Email, calendar, accounting, payment, and client-management systems remain the systems of record. Trevra normalizes their commercial events into one graph you own.')}
      ${feature('2', 'Build the revenue memory', 'Leads, proposals, clauses, scope items, client requests, milestones, invoices, and payments become one evidence-linked graph spanning source to paid.')}
      ${feature('3', 'Let the skills do the work', 'Skills are small, typed, testable units of go-to-market work. Claude calls them; Trevra records the inputs, outputs, evidence, and verdict of every run.')}
      ${feature('4', 'Approve what leaves the workspace', 'Trevra prepares the message, invoice, or change order and holds it. Consequential work stays approval-gated unless you write a narrow standing instruction with explicit ceilings.')}
    </section>
    <section class="launch-copy-section" id="skills"><h2>The skills catalog</h2><p>A skill is a small deterministic unit of go-to-market work with a typed input, a typed output, and recorded evidence — a library function first and an agent second. The catalog covers the founder revenue loop end to end: source, enrich, score, audit, draft, send, reply, ladder, guard, position, publish, measure, close, and collect. Close and collect — proposal follow-up, scope protection, unbilled milestones, and overdue invoices — are shipped in Trevra today. The sourcing and outreach skills are in progress. Every skill is meant to be read, forked, and tested, not trusted blindly.</p></section>
    <section class="launch-copy-section"><h2>Evidence before automation</h2><p>Every agent action carries a Revenue Proof Pack: why the agent acted, the agreement and scope it relied on, the client request and delivery evidence, the billing obligation, the payment state, and the exact payload you approved. The approved payload is cryptographically hashed before execution, so a modified payload is rejected.</p></section>
    <section class="launch-copy-section"><h2>Designed to work with the existing stack</h2><p>Trevra supports live integration patterns for Gmail, Microsoft 365, Google Calendar, Stripe, QuickBooks, Xero, HoneyBook, and Bonsai. CSV exports can be imported when a direct API is unavailable. Run the whole thing on your own PostgreSQL and keep the ledger.</p></section>`
  }));

  app.get('/security', (_req, res) => sendPublicPage(res, config, {
    path: '/security',
    title: 'Security and Responsible Disclosure | Trevra',
    description: 'How Trevra protects commercial data, constrains automation, verifies webhooks, isolates workspaces, and receives responsible vulnerability reports.',
    eyebrow: 'Security',
    heading: 'Commercial automation needs explicit boundaries.',
    intro: 'Trevra is designed around evidence, least privilege, approval integrity, and auditable execution.',
    body: `<section class="launch-grid">
      ${feature('01', 'Approval integrity', 'The exact approved payload, including structured financial fields, is hashed before execution. Modified payloads are rejected.')}
      ${feature('02', 'Workspace isolation', 'Application queries are scoped by workspace, authentication data and commercial records use PostgreSQL, and external credentials are delegated to the integration layer.')}
      ${feature('03', 'Verified events', 'Stripe and Nango webhooks are signature-verified, deduplicated, and processed idempotently.')}
    </section>
    <section class="launch-copy-section"><h2>Responsible disclosure</h2><p>Report a suspected vulnerability to <a href="mailto:${escapeAttr(config.securityEmail)}">${escapeHtml(config.securityEmail)}</a>. Include reproduction steps, affected URLs, and the potential impact. Do not access data that is not yours, disrupt service availability, or use destructive testing.</p><p>The canonical machine-readable disclosure channel is <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p></section>`
  }));

  app.get('/privacy', (_req, res) => sendPublicPage(res, config, {
    path: '/privacy',
    title: 'Privacy Notice | Trevra',
    description: 'A plain-language overview of the account, connected-service, commercial, document, audit, and technical data Trevra processes.',
    eyebrow: 'Privacy notice',
    heading: 'What Trevra processes and why.',
    intro: 'This notice explains the information Trevra processes, why it is used, and the controls available to workspace owners.',
    body: `<section class="launch-legal">
      <h2>Information processed</h2><p>Trevra processes account identity, workspace settings, connected-account records authorized by the user, uploaded agreements, client and project information, invoices and payment states, prepared actions, approval history, and security or operational logs.</p>
      <h2>Purposes</h2><p>Data is used to provide the service, reconstruct commercial history, detect revenue work, prepare and execute authorized actions, maintain audit records, secure the service, and measure aggregate product adoption.</p>
      <h2>Connected services and processors</h2><p>Connected providers remain independent third parties. Depending on deployment configuration, infrastructure and processing may involve cloud hosting, PostgreSQL, Nango, model providers explicitly enabled for document extraction, email or accounting providers, and payment services.</p>
      <h2>Analytics</h2><p>Trevra’s built-in traction measurement does not store IP addresses. It stores a salted hash of a session-scoped random identifier, the landing path, referral domain, campaign parameters, and product conversion events. Browser Do Not Track and Global Privacy Control signals disable client-side marketing events.</p>
      <h2>Retention and deletion</h2><p>Commercial records are retained while a workspace is active and as needed for security, dispute, backup, or legal obligations. Workspace owners may request account export or deletion through the support contact below. Backup deletion can follow a delayed rotation schedule.</p>
      <h2>Data rights and contact</h2><p>Applicable privacy rights vary by location. Requests may be sent to <a href="mailto:${escapeAttr(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>. Identity verification may be required before fulfilling a request.</p>
      <p class="launch-updated">Last updated: July 23, 2026.</p>
    </section>`
  }));

  app.get('/terms', (_req, res) => sendPublicPage(res, config, {
    path: '/terms',
    title: 'Terms of Service | Trevra',
    description: 'Baseline terms covering account responsibility, authorized automation, third-party integrations, acceptable use, availability, and commercial decisions.',
    eyebrow: 'Terms of service',
    heading: 'Use Trevra as an authorized commercial operator.',
    intro: 'These terms govern access to Trevra and the commercial actions users authorize through the service.',
    body: `<section class="launch-legal">
      <h2>Service</h2><p>Trevra analyzes authorized business records and can prepare or execute commercial actions according to user approvals and standing instructions. Users remain responsible for reviewing material commercial, legal, tax, financial, and client-relationship decisions.</p>
      <h2>Accounts and authorization</h2><p>Users must provide accurate account information, protect credentials, and connect only systems and data they are authorized to access. Workspace owners are responsible for team access and configured automation rules.</p>
      <h2>Acceptable use</h2><p>The service may not be used to violate law, impersonate others, access unauthorized data, distribute malware, conduct abusive collection activity, evade provider restrictions, or interfere with service security or availability.</p>
      <h2>Third-party services</h2><p>Integrations are governed by their providers’ terms and availability. Trevra is not responsible for provider outages, changed APIs, revoked permissions, or actions a provider refuses to execute.</p>
      <h2>No professional advice</h2><p>Trevra provides operational assistance, not legal, tax, accounting, investment, medical, or other regulated professional advice. Contract interpretation and pricing recommendations should be independently reviewed when consequences are material.</p>
      <h2>Availability and liability</h2><p>The service may change, be interrupted, or contain errors. To the extent permitted by applicable law, ${escapeHtml(config.legalName)} disclaims implied warranties and is not liable for indirect, special, or consequential loss. Mandatory legal rights remain unaffected.</p>
      <h2>Contact</h2><p>Questions may be sent to <a href="mailto:${escapeAttr(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>.</p>
      <p class="launch-updated">Last updated: July 23, 2026.</p>
    </section>`
  }));

  app.post('/api/marketing/events', publicLimiter, express.json({ limit: '32kb' }), async (req, res) => {
    const fetchSite = req.header('sec-fetch-site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return res.status(403).json({ error: 'Cross-site events are not accepted' });
    const input = marketingEventSchema.parse(req.body ?? {});
    await recordMarketingEvent(db, input);
    res.status(202).json({ accepted: true });
  });

  app.get('/api/internal/traction', async (req, res) => {
    const expected = process.env.TRACTION_ADMIN_TOKEN?.trim();
    if (!expected) return res.status(404).json({ error: 'Not found' });
    const supplied = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!safeTokenEqual(supplied, expected)) return res.status(401).json({ error: 'Invalid token' });
    const days = z.coerce.number().int().min(1).max(730).default(90).parse(req.query.days ?? 90);
    res.json(await getTractionReport(db, days));
  });
}

export async function recordMarketingEvent(db: Db, input: MarketingEventInput): Promise<void> {
  try {
    const salt = process.env.MARKETING_HASH_SALT ?? process.env.BETTER_AUTH_SECRET ?? 'development-marketing-salt';
    const visitorHash = input.visitorId ? createHash('sha256').update(`${salt}:${input.visitorId}`).digest('hex') : null;
    await db.prepare(`
      INSERT INTO marketing_events (
        id,visitor_hash,workspace_id,event_name,path,referrer_domain,source,medium,campaign,content,term,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id('mkt'), visitorHash, input.workspaceId ?? null, input.eventName,
      cleanText(input.path, 500), referrerDomain(input.referrer), cleanText(input.source, 120), cleanText(input.medium, 120),
      cleanText(input.campaign, 200), cleanText(input.content, 200), cleanText(input.term, 200),
      JSON.stringify(input.metadata ?? {}), new Date().toISOString()
    );
  } catch (error) {
    console.warn('Marketing event recording failed', error instanceof Error ? error.message : error);
  }
}

export async function getTractionReport(db: Db, days = 90) {
  const totals = await db.prepare(`
    SELECT event_name, COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS visitors, COUNT(DISTINCT workspace_id) AS workspaces
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day')
    GROUP BY event_name ORDER BY events DESC
  `).all<{ event_name: string; events: number; visitors: number; workspaces: number }>(days);
  const daily = await db.prepare(`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, event_name, COUNT(*) AS events
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day')
    GROUP BY 1,2 ORDER BY 1,2
  `).all<{ day: string; event_name: string; events: number }>(days);
  const sources = await db.prepare(`
    SELECT COALESCE(NULLIF(source,''),'direct') AS source, COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS visitors
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day') AND source IS NOT NULL
    GROUP BY 1 ORDER BY visitors DESC, events DESC LIMIT 25
  `).all<{ source: string; events: number; visitors: number }>(days);
  const stat = (name: string) => totals.find((item) => item.event_name === name);
  const count = (name: string) => Number(stat(name)?.events ?? 0);
  const workspaces = (name: string) => Number(stat(name)?.workspaces ?? 0);
  const pageViews = count('page_view');
  const signupStarts = count('signup_started') + count('google_auth_started');
  const signupsCompleted = workspaces('signup_completed');
  const integrationsStarted = workspaces('integration_connect_started');
  const actionsExecuted = workspaces('action_executed');
  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    funnel: {
      pageViews,
      uniqueVisitors: Number(stat('page_view')?.visitors ?? 0),
      signupStarts,
      workspacesCreated: signupsCompleted,
      workspacesConnecting: integrationsStarted,
      workspacesExecuting: actionsExecuted
    },
    conversionRates: {
      signupIntentPerPageView: ratio(signupStarts, pageViews),
      workspaceCreationPerPageView: ratio(signupsCompleted, pageViews),
      connectionPerCreatedWorkspace: ratio(integrationsStarted, signupsCompleted),
      executionPerCreatedWorkspace: ratio(actionsExecuted, signupsCompleted)
    },
    totals,
    sources,
    daily
  };
}

export function renderAppIndex(template: string, nonce: string): string {
  const config = getSiteConfig();
  const jsonLd = JSON.stringify(structuredData(config)).replaceAll('<', '\\u003c');
  const verification = [
    config.googleVerification ? `<meta name="google-site-verification" content="${escapeAttr(config.googleVerification)}" />` : '',
    config.bingVerification ? `<meta name="msvalidate.01" content="${escapeAttr(config.bingVerification)}" />` : ''
  ].filter(Boolean).join('\n    ');
  return template
    .replaceAll('http://localhost:43173', config.origin)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeAttr(config.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeAttr(config.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeAttr(config.description)}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeAttr(config.title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeAttr(config.description)}" />`)
    .replace('<!-- TREVRA_VERIFICATION -->', verification)
    .replace('<!-- TREVRA_JSON_LD -->', `<script type="application/ld+json" nonce="${escapeAttr(nonce)}">${jsonLd}</script>`);
}

export function renderNotFoundPage(nonce: string): string {
  return renderPublicDocument(getSiteConfig(), {
    path: '/404',
    title: 'Page not found | Trevra',
    description: 'The requested Trevra page could not be found.',
    eyebrow: '404',
    heading: 'That page is not part of the revenue brief.',
    intro: 'Return to Trevra to create a workspace or continue your commercial work.',
    body: '<p><a class="launch-button" href="/">Return to Trevra</a></p>',
    noindex: true
  }, nonce);
}

function sendPublicPage(res: Response, config: SiteConfig, page: PublicPage): void {
  res.type('html').set({
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    'Content-Language': 'en',
    Link: `<${config.origin}${page.path}>; rel="canonical"`
  });
  res.send(renderPublicDocument(config, page, String(res.locals.cspNonce ?? '')));
}

interface PublicPage {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  heading: string;
  intro: string;
  body: string;
  noindex?: boolean;
}

function renderPublicDocument(config: SiteConfig, page: PublicPage, nonce: string): string {
  const canonical = `${config.origin}${page.path}`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.title,
    description: page.description,
    url: canonical,
    isPartOf: { '@id': `${config.origin}/#website` },
    about: { '@id': `${config.origin}/#application` }
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeAttr(page.description)}" />
<meta name="robots" content="${page.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1'}" />
<link rel="canonical" href="${escapeAttr(canonical)}" /><link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/marketing.css" /><meta name="theme-color" content="#1f6f4a" />
<script defer src="/marketing-analytics.js"></script>
<meta property="og:type" content="website" /><meta property="og:site_name" content="${escapeAttr(config.name)}" />
<meta property="og:title" content="${escapeAttr(page.title)}" /><meta property="og:description" content="${escapeAttr(page.description)}" />
<meta property="og:url" content="${escapeAttr(canonical)}" /><meta property="og:image" content="${escapeAttr(`${config.origin}/og/trevra-social.png`)}" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="Trevra — the open-source ledger and control plane for agentic GTM" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${escapeAttr(page.title)}" /><meta name="twitter:description" content="${escapeAttr(page.description)}" /><meta name="twitter:image" content="${escapeAttr(`${config.origin}/og/trevra-social.png`)}" />
<script type="application/ld+json" nonce="${escapeAttr(nonce)}">${jsonLd}</script>
<script src="/theme.js"></script>
</head><body class="launch-body">
<header class="launch-nav"><div class="launch-brand"><a class="launch-logo" href="/"><span>T</span>Trevra</a>${themeToggleHtml()}</div><nav><a href="/how-it-works">How it works</a><a href="/security">Security</a><a class="launch-nav-cta" href="/#get-started">Connect your workspace</a></nav></header><main class="launch-page"><section class="launch-page-hero"><span class="launch-eyebrow">${escapeHtml(page.eyebrow)}</span><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.intro)}</p></section>${page.body}</main>
${siteFooter(config)}
</body></html>`;
}

/** The toggle control, identical markup on every server-rendered surface. */
export function themeToggleHtml(): string {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch theme">${THEME_ICONS}</button>`;
}

const THEME_ICONS =
  '<svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
  '<svg class="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function structuredData(config: SiteConfig) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization', '@id': `${config.origin}/#organization`, name: config.legalName, url: config.origin, email: config.supportEmail,
        logo: { '@type': 'ImageObject', url: `${config.origin}/icons/trevra-512.png`, width: 512, height: 512 }
      },
      {
        '@type': 'WebSite', '@id': `${config.origin}/#website`, url: config.origin, name: config.name,
        description: config.description, publisher: { '@id': `${config.origin}/#organization` }, inLanguage: 'en'
      },
      {
        '@type': 'WebApplication', '@id': `${config.origin}/#application`, name: config.name, url: config.origin,
        description: config.description, applicationCategory: 'BusinessApplication', operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript and a modern web browser',
        featureList: [
          'Modular agent-run revenue loop from source to paid', 'Public GitHub-synced module catalog',
          'Scope-creep detection and change-order preparation', 'Unbilled milestone detection and invoice preparation',
          'Overdue invoice follow-up', 'Revenue Proof Packs behind every agent action',
          'Approval-gated execution with cryptographic payload hashing',
          'Delegation scoped by action type, confidence, amount, and delay',
          'Open-source, self-hostable GTM runtime and revenue ledger'
        ],
        publisher: { '@id': `${config.origin}/#organization` }
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqItems().map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } }))
      }
    ]
  };
}

function renderLlmsText(config: SiteConfig, full: boolean): string {
  const base = `# Trevra\n\n> ${config.description}\n\n## Primary pages\n- [Trevra](${config.origin}/): Product overview and workspace access.\n- [How Trevra works](${config.origin}/how-it-works): Product workflow, evidence model, integrations, and automation boundaries.\n- [Security](${config.origin}/security): Security architecture and responsible disclosure.\n- [Privacy](${config.origin}/privacy): Data categories, purposes, analytics, retention, and requests.\n- [Terms](${config.origin}/terms): Baseline service terms.\n\n## Machine-readable resources\n- [Sitemap](${config.origin}/sitemap.xml)\n- [Robots](${config.origin}/robots.txt)\n- [Full LLM context](${config.origin}/llms-full.txt)\n- [Agent guidance](${config.origin}/agents.md)\n- [Security contact](${config.origin}/.well-known/security.txt)\n\n## Contact\n- Product support: ${config.supportEmail}\n- Security reports: ${config.securityEmail}\n`;
  if (!full) return base;
  return `${base}\n## Product model\nTrevra is built for founders and small teams running their own go-to-market. It is not a generic chatbot and not a replacement accounting ledger. Claude Code is the intended operator: the agent calls skills, and Trevra is the ledger and control plane that stores what was sourced, qualified, proposed, agreed, delivered, invoiced, and paid, and that gates what the agent is allowed to execute. The web application is where a founder watches and approves, not a workflow tool to click through.\n\n## Skills catalog\nA skill is a small deterministic unit of go-to-market work with a typed input, a typed output, and recorded evidence. The catalog spans source, enrich, score, audit, draft, send, reply, ladder, guard, position, publish, measure, close, and collect. Close and collect are shipped inside Trevra today. Sourcing and outreach skills are in progress and should not be described as shipped product surface.\n\n## Core detections\n1. Stale proposal: a proposal or buying conversation needs a timely follow-up.\n2. Scope creep: a client request appears outside the accepted scope or revision allowance.\n3. Unbilled milestone: delivery evidence exists but a corresponding invoice does not.\n4. Overdue invoice: a payment obligation is past due and needs an appropriate follow-up.\n\n## Revenue Proof Pack\nThe evidence pack behind any agent action. It can include agreement clauses, included and excluded scope, client requests, delivery evidence, invoice terms, payment state, confidence, estimated financial impact, and the proposed action. Evidence is shown before execution.\n\n## Automation boundaries\nTrevra can suggest, prepare, schedule, or execute actions. Scope changes always require manual approval. Other action types can be delegated only through explicit workspace rules containing action type, minimum confidence, maximum amount, and delay. The exact approved payload is hashed before execution and a modified payload is rejected.\n\n## Ownership\nTrevra is open source and self-hostable. It runs on your own PostgreSQL, skills are modular and forkable, and workspace data can be exported or deleted. The ledger, the evidence, and the approval gates are not cloud-only.\n\n## Integrations\nIntegration plumbing is delegated to Nango or official provider SDKs. Supported product patterns include Gmail, Microsoft 365, Google Calendar, Stripe, QuickBooks, Xero, HoneyBook, and Bonsai. Marketplace and generic CSV exports can be normalized when direct APIs are unavailable.\n\n## Important limitations\nTrevra provides operational assistance, not legal, tax, accounting, investment, medical, or other regulated professional advice. It does not expose private workspace records through public discovery files. Public agents must not attempt to access authenticated API routes or infer customer data.\n`;
}

function renderPublicAgents(config: SiteConfig): string {
  return `# Trevra public agent guidance\n\nCanonical site: ${config.origin}\n\n## Allowed public retrieval\nAgents may read the public pages, sitemap, robots.txt, llms.txt, llms-full.txt, security.txt, and public image assets. Use canonical URLs when citing Trevra.\n\n## Restricted areas\nDo not attempt to access /api routes without an authenticated user request and valid authorization. Do not probe connected providers, enumerate workspaces, submit fabricated marketing events, or treat public product descriptions as permission to execute commercial actions.\n\n## Product description\n${config.description}\n\n## Preferred sources\n1. ${config.origin}/how-it-works\n2. ${config.origin}/security\n3. ${config.origin}/privacy\n4. ${config.origin}/terms\n5. ${config.origin}/llms-full.txt\n\n## Contact\nProduct: ${config.supportEmail}\nSecurity: ${config.securityEmail}\n`;
}

function faqItems(): Array<[string, string]> {
  return [
    ['How do I actually use Trevra?', 'Give Claude Code, Codex, or another capable agent a go-to-market outcome. The agent calls typed Trevra modules for research, scoring, preparation, governance, and execution. Trevra records the run and stops at the approval boundary when the work could change an external system.'],
    ['Can an agent send messages or create invoices by itself?', 'Only inside the policy you set. Consequential actions can require manual approval, and the exact approved payload is cryptographically hashed before execution. Changed payloads and out-of-scope actions are rejected.'],
    ['How are community modules shared safely?', 'Modules are versioned through GitHub and declare their input and output schemas, side-effect class, approval requirement, and version. Validation and tests run before a catalog release. Publishing a module does not grant it external-write permission.'],
    ['Can I self-host Trevra and keep my data?', 'Yes. Trevra runs on PostgreSQL, the module runner is open, and workspace data, ledger entries, evidence, configuration, and exports can remain in infrastructure you control.']
  ];
}

function siteFooter(config: SiteConfig): string {
  return `<footer class="launch-footer"><div><a class="launch-logo" href="/"><span>T</span>Trevra</a><p>Open-source operating system and control plane for agent-run GTM.</p></div><nav><a href="/how-it-works">How it works</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${escapeAttr(config.supportEmail)}">Talk to founder</a></nav></footer>`;
}

function feature(number: string, title: string, copy: string): string {
  return `<article class="launch-feature"><span>${escapeHtml(number)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></article>`;
}

function setTextResponse(res: Response, seconds: number): void {
  res.type('text/plain; charset=utf-8').set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const cleaned = value?.trim().slice(0, max);
  return cleaned || null;
}

function referrerDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.slice(0, 255) || null; }
  catch { return null; }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

function escapeAttr(value: string): string { return escapeHtml(value); }
function escapeXml(value: string): string { return escapeHtml(value); }
