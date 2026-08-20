import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Db } from './db.js';
import { id } from './db.js';
import { listPublicModulePopularity, listPublicRegistryModules } from './registry/service.js';
import {
  buildStructuredData,
  buildWebPageStructuredData,
  renderHumansText,
  renderLlmsText,
  renderPublicAgents,
  renderSecurityText,
  renderSitemap,
  SITE_DESCRIPTION,
  SITE_TITLE,
  SOCIAL_IMAGE
} from '../shared/site-metadata.js';

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
  | 'marketing_founder_cta'
  | 'marketing_hosted_cta';

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
  /** Hosted workspace entry point, or '' when this deployment has none. */
  hostedAppUrl: string;
  /** GitHub org/repo URL for Organization.sameAs, or '' when unset. */
  githubUrl: string;
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
  'marketing_founder_cta',
  'marketing_hosted_cta'
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
  const rawOrigin =
    env.PUBLIC_SITE_URL ??
    env.BETTER_AUTH_URL ??
    env.APP_ORIGIN?.split(',')[0]?.trim() ??
    'http://localhost:43173';
  const origin = new URL(rawOrigin).origin;
  const hostname = new URL(origin).hostname;
  return {
    origin,
    name: env.PUBLIC_SITE_NAME?.trim() || 'Trevra',
    legalName: env.PUBLIC_LEGAL_NAME?.trim() || 'Trevra',
    title: env.PUBLIC_SITE_TITLE?.trim() || SITE_TITLE,
    description: env.PUBLIC_SITE_DESCRIPTION?.trim() || SITE_DESCRIPTION,
    supportEmail: env.PUBLIC_SUPPORT_EMAIL?.trim() || `support@${hostname}`,
    securityEmail:
      env.SECURITY_CONTACT_EMAIL?.trim() ||
      env.PUBLIC_SUPPORT_EMAIL?.trim() ||
      `security@${hostname}`,
    googleVerification: env.GOOGLE_SITE_VERIFICATION?.trim() || '',
    bingVerification: env.BING_SITE_VERIFICATION?.trim() || '',
    indexNowKey: env.INDEXNOW_KEY?.trim() || '',
    hostedAppUrl: hostedWorkspaceUrl(env),
    githubUrl: env.PUBLIC_GITHUB_URL?.trim() || env.VITE_GITHUB_URL?.trim() || ''
  };
}

/**
 * Where "Launch hosted workspace" actually goes.
 *
 * Read from VITE_HOSTED_APP_URL -- the same variable src/client/App.tsx reads
 * into MarketingScreen's `hostedAppUrl` prop. Not a second setting: the same
 * one, read on the server so the shipped href and the React href cannot
 * disagree.
 *
 * Anything that is not http(s) or root-relative is treated as unconfigured.
 * This value is written straight into an href, and `javascript:` is a scheme.
 */
function hostedWorkspaceUrl(env: NodeJS.ProcessEnv): string {
  const value = env.VITE_HOSTED_APP_URL?.trim();
  if (!value || value.startsWith('//')) return '';
  if (value.startsWith('/')) return value;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol) ? value : '';
  } catch {
    return '';
  }
}

export function registerPublicSiteRoutes(app: Express, db: Db): void {
  const config = getSiteConfig();
  const publicLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  });

  const registryCorsOrigins = new Set(
    (process.env.PUBLIC_REGISTRY_CORS_ORIGIN || config.origin)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const publicRegistryHeaders = (req: express.Request, res: Response) => {
    const requestOrigin = req.header('origin');
    const allowedOrigin =
      requestOrigin && registryCorsOrigins.has(requestOrigin)
        ? requestOrigin
        : ([...registryCorsOrigins][0] ?? config.origin);
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
      res.json({
        schemaVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        modules: await listPublicModulePopularity(db)
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/public/modules', publicLimiter, async (req, res, next) => {
    try {
      publicRegistryHeaders(req, res);
      res.json({
        schemaVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        modules: await listPublicRegistryModules(db)
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/public/modules/:id', publicLimiter, async (req, res, next) => {
    try {
      publicRegistryHeaders(req, res);
      const modules = await listPublicRegistryModules(db);
      const module = modules.find((item) => item.id === String(req.params.id));
      if (!module) return res.status(404).json({ error: 'Public module not found' });
      res.json({ module });
    } catch (error) {
      next(error);
    }
  });

  app.get('/robots.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        '',
        `Sitemap: ${config.origin}/sitemap.xml`,
        `Host: ${new URL(config.origin).host}`,
        ''
      ].join('\n')
    );
  });

  app.get('/sitemap.xml', (_req, res) => {
    res
      .type('application/xml')
      .set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.send(renderSitemap(config.origin, new Date().toISOString()));
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
    res
      .type('text/markdown; charset=utf-8')
      .set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.send(renderPublicAgents(config));
  });

  app.get('/humans.txt', (_req, res) => {
    setTextResponse(res, 3600);
    res.send(renderHumansText(config));
  });

  app.get('/.well-known/security.txt', (_req, res) => {
    setTextResponse(res, 86400);
    const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().replace('.000Z', 'Z');
    res.send(renderSecurityText(config, expires));
  });

  app.get('/security.txt', (_req, res) => res.redirect(308, '/.well-known/security.txt'));

  if (config.indexNowKey) {
    app.get(`/${config.indexNowKey}.txt`, (_req, res) => {
      setTextResponse(res, 86400);
      res.send(config.indexNowKey);
    });
  }

  app.get('/how-it-works', (_req, res) =>
    sendPublicPage(res, config, {
      path: '/how-it-works',
      title: 'How Trevra Works | Agentic GTM Ledger and Control Plane',
      description:
        'See how Trevra records agent runs, reconstructs the revenue loop from source to paid, builds proof packs, and holds every consequential action at an approval gate.',
      heading: 'Claude runs the loop. Trevra keeps the record.',
      intro:
        'Trevra is the memory and the control plane behind agent-operated go-to-market: every run recorded, every action evidenced, every consequential step gated on your approval.',
      body: `<div class="launch-faq">
      ${docRow('1', 'Connect the source systems', 'Email, calendar, accounting, payment, and client-management systems remain the systems of record. Trevra normalizes their commercial events into one graph you own.')}
      ${docRow('2', 'Build the revenue memory', 'Leads, proposals, clauses, scope items, client requests, milestones, invoices, and payments become one evidence-linked graph spanning source to paid.')}
      ${docRow('3', 'Let the skills do the work', 'Skills are small, typed, testable units of go-to-market work. Claude calls them; Trevra records the inputs, outputs, evidence, and verdict of every run.')}
      ${docRow('4', 'Approve what leaves the workspace', 'Trevra prepares the message, invoice, or change order and holds it. Consequential work stays approval-gated unless you write a narrow standing instruction with explicit ceilings.')}
      <details open id="skills"><summary>The skills catalog</summary><p>A skill is a small deterministic unit of go-to-market work with a typed input, a typed output, and recorded evidence — a library function first and an agent second. The catalog covers the founder revenue loop end to end: source, enrich, score, audit, draft, send, reply, ladder, guard, position, publish, measure, close, and collect. Close and collect — proposal follow-up, scope protection, unbilled milestones, and overdue invoices — are shipped in Trevra today. The sourcing and outreach skills are in progress. Every skill is meant to be read, forked, and tested, not trusted blindly.</p></details>
      <details open><summary>Evidence before automation</summary><p>Every agent action carries a Revenue Proof Pack: why the agent acted, the agreement and scope it relied on, the client request and delivery evidence, the billing obligation, the payment state, and the exact payload you approved. The approved payload is cryptographically hashed before execution, so a modified payload is rejected.</p></details>
      <details open><summary>Designed to work with the existing stack</summary><p>Trevra supports live integration patterns for Gmail, Microsoft 365, Google Calendar, Stripe, QuickBooks, Xero, HoneyBook, and Bonsai. CSV exports can be imported when a direct API is unavailable. Run the whole thing on your own PostgreSQL and keep the ledger.</p></details>
    </div>`
    })
  );

  app.get('/security', (_req, res) =>
    sendPublicPage(res, config, {
      path: '/security',
      title: 'Security and Responsible Disclosure | Trevra',
      description:
        'How Trevra protects commercial data, constrains automation, verifies webhooks, isolates workspaces, and receives responsible vulnerability reports.',
      heading: 'Commercial automation needs explicit boundaries.',
      intro:
        'Trevra is designed around evidence, least privilege, approval integrity, and auditable execution.',
      body: `<div class="launch-faq">
      ${docRow('01', 'Approval integrity', 'The exact approved payload, including structured financial fields, is hashed before execution. Modified payloads are rejected.')}
      ${docRow('02', 'Workspace isolation', 'Application queries are scoped by workspace, authentication data and commercial records use PostgreSQL, and external credentials are delegated to the integration layer.')}
      ${docRow('03', 'Verified events', 'Stripe and Nango webhooks are signature-verified, deduplicated, and processed idempotently.')}
      <details open id="disclosure"><summary>Responsible disclosure</summary><p>Report a suspected vulnerability to <a href="mailto:${escapeAttr(config.securityEmail)}">${escapeHtml(config.securityEmail)}</a>. Include reproduction steps, affected URLs, and the potential impact. Do not access data that is not yours, disrupt service availability, or use destructive testing.</p><p>The canonical machine-readable disclosure channel is <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p></details>
    </div>`
    })
  );

  // /privacy and /terms are shipped documents, not routes: public/privacy/index.html
  // and public/terms/index.html are the single legal surface on every deploy
  // target, served here by the static middleware in src/server/index.ts.

  app.post(
    '/api/marketing/events',
    publicLimiter,
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const fetchSite = req.header('sec-fetch-site');
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite))
        return res.status(403).json({ error: 'Cross-site events are not accepted' });
      const input = marketingEventSchema.parse(req.body ?? {});
      await recordMarketingEvent(db, input);
      res.status(202).json({ accepted: true });
    }
  );

  app.get('/api/internal/traction', async (req, res) => {
    const expected = process.env.TRACTION_ADMIN_TOKEN?.trim();
    if (!expected) return res.status(404).json({ error: 'Not found' });
    const supplied = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!safeTokenEqual(supplied, expected))
      return res.status(401).json({ error: 'Invalid token' });
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(730)
      .default(90)
      .parse(req.query.days ?? 90);
    res.json(await getTractionReport(db, days));
  });
}

export async function recordMarketingEvent(db: Db, input: MarketingEventInput): Promise<void> {
  try {
    const salt =
      process.env.MARKETING_HASH_SALT ??
      process.env.BETTER_AUTH_SECRET ??
      'development-marketing-salt';
    const visitorHash = input.visitorId
      ? createHash('sha256').update(`${salt}:${input.visitorId}`).digest('hex')
      : null;
    await db
      .prepare(
        `
      INSERT INTO marketing_events (
        id,visitor_hash,workspace_id,event_name,path,referrer_domain,source,medium,campaign,content,term,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        id('mkt'),
        visitorHash,
        input.workspaceId ?? null,
        input.eventName,
        cleanText(input.path, 500),
        referrerDomain(input.referrer),
        cleanText(input.source, 120),
        cleanText(input.medium, 120),
        cleanText(input.campaign, 200),
        cleanText(input.content, 200),
        cleanText(input.term, 200),
        JSON.stringify(input.metadata ?? {}),
        new Date().toISOString()
      );
  } catch (error) {
    console.warn(
      'Marketing event recording failed',
      error instanceof Error ? error.message : error
    );
  }
}

export async function getTractionReport(db: Db, days = 90) {
  const totals = await db
    .prepare(
      `
    SELECT event_name, COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS visitors, COUNT(DISTINCT workspace_id) AS workspaces
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day')
    GROUP BY event_name ORDER BY events DESC
  `
    )
    .all<{ event_name: string; events: number; visitors: number; workspaces: number }>(days);
  const daily = await db
    .prepare(
      `
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, event_name, COUNT(*) AS events
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day')
    GROUP BY 1,2 ORDER BY 1,2
  `
    )
    .all<{ day: string; event_name: string; events: number }>(days);
  const sources = await db
    .prepare(
      `
    SELECT COALESCE(NULLIF(source,''),'direct') AS source, COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS visitors
    FROM marketing_events
    WHERE created_at >= CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day') AND source IS NOT NULL
    GROUP BY 1 ORDER BY visitors DESC, events DESC LIMIT 25
  `
    )
    .all<{ source: string; events: number; visitors: number }>(days);
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
  // The hosted product build has its own HTML shell. Do not turn it back into
  // a marketing document on the server: no marketing title, JSON-LD, CTA
  // rewrite, or public-site metadata belongs on app.usetrevra.com.
  if (template.includes('data-trevra-app-shell')) {
    return template.replaceAll('http://localhost:43173', config.origin);
  }
  const jsonLd = JSON.stringify(
    buildStructuredData({
      origin: config.origin,
      name: config.name,
      legalName: config.legalName,
      description: config.description,
      supportEmail: config.supportEmail,
      githubUrl: config.githubUrl
    })
  ).replaceAll('<', '\\u003c');
  const verification = [
    config.googleVerification
      ? `<meta name="google-site-verification" content="${escapeAttr(config.googleVerification)}" />`
      : '',
    config.bingVerification
      ? `<meta name="msvalidate.01" content="${escapeAttr(config.bingVerification)}" />`
      : ''
  ]
    .filter(Boolean)
    .join('\n    ');
  const html = template
    .replaceAll('http://localhost:43173', config.origin)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.title)}</title>`)
    // \s+ rather than a literal space: this tag's copy runs past Prettier's
    // printWidth, so the shipped index.html wraps it across three lines with
    // one attribute per line -- and only this tag, since <title> and the two
    // shorter og/twitter title tags stay on one line.
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${escapeAttr(config.description)}" />`
    )
    .replace(
      /<meta property="og:title" content="[^"]*" \/>/,
      `<meta property="og:title" content="${escapeAttr(config.title)}" />`
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*" \/>/,
      `<meta name="twitter:title" content="${escapeAttr(config.title)}" />`
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:description" content="${escapeAttr(config.description)}" />`
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
      `<meta name="twitter:description" content="${escapeAttr(config.description)}" />`
    )
    .replace('<!-- TREVRA_VERIFICATION -->', verification)
    .replace(
      '<!-- TREVRA_JSON_LD -->',
      `<script type="application/ld+json" nonce="${escapeAttr(nonce)}">${jsonLd}</script>`
    );
  return withHostedWorkspaceHrefs(html, config.hostedAppUrl);
}

/**
 * Point the shipped hosted-workspace CTAs at the real destination.
 *
 * index.html marks each one `data-hosted-cta` and keeps `href="#hosted"` as
 * the degraded fallback. That fallback is what a crawler, a link unfurler and
 * a pre-JS visitor actually get: src/client/main.tsx calls createRoot().render()
 * rather than hydrateRoot(), so React discards the static DOM instead of
 * repairing it, and MarketingScreen's own hostedAppUrl fix never reaches them.
 *
 * With no hosted workspace configured the markup is returned untouched, so the
 * button still scrolls to the deploy card rather than pointing at nothing.
 */
function withHostedWorkspaceHrefs(html: string, hostedAppUrl: string): string {
  if (!hostedAppUrl) return html;
  const href = `href="${escapeAttr(hostedAppUrl)}"`;
  return html.replace(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi, (tag) =>
    tag.replace(/\bhref\s*=\s*"[^"]*"/i, href)
  );
}

export function renderNotFoundPage(nonce: string): string {
  return renderPublicDocument(
    getSiteConfig(),
    {
      path: '/404',
      title: 'Page not found | Trevra',
      description: 'The requested Trevra page could not be found.',
      heading: 'That page is not part of the revenue brief.',
      intro: 'Return to Trevra to create a workspace or continue your commercial work.',
      body: '<p><a class="launch-button" href="/">Return to Trevra</a></p>',
      noindex: true
    },
    nonce
  );
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
  heading: string;
  intro: string;
  body: string;
  noindex?: boolean;
}

function renderPublicDocument(config: SiteConfig, page: PublicPage, nonce: string): string {
  const canonical = `${config.origin}${page.path}`;
  const socialImage = `${config.origin}${SOCIAL_IMAGE.path}`;
  const jsonLd = JSON.stringify(
    buildWebPageStructuredData({
      origin: config.origin,
      path: page.path,
      title: page.title,
      description: page.description
    })
  ).replaceAll('<', '\\u003c');
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
<meta property="og:url" content="${escapeAttr(canonical)}" /><meta property="og:image" content="${escapeAttr(socialImage)}" />
<meta property="og:image:width" content="${SOCIAL_IMAGE.width}" /><meta property="og:image:height" content="${SOCIAL_IMAGE.height}" /><meta property="og:image:alt" content="${escapeAttr(SOCIAL_IMAGE.alt)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${escapeAttr(page.title)}" /><meta name="twitter:description" content="${escapeAttr(page.description)}" /><meta name="twitter:image" content="${escapeAttr(socialImage)}" />
<script type="application/ld+json" nonce="${escapeAttr(nonce)}">${jsonLd}</script>
<script src="/theme.js"></script>
</head><body>
<a class="skip-link" href="#main">Skip to content</a>
<main class="static-launch" id="main" tabindex="-1">
<header class="launch-nav">${brandLink()}<nav aria-label="Primary navigation">${SITE_LINKS}</nav><div class="launch-nav-actions"><details class="launch-nav-menu"><summary aria-label="Open section navigation">${MENU_ICON}</summary><nav aria-label="Sections">${SITE_LINKS}<a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></details>${themeToggleHtml()}<a class="launch-nav-cta" href="/">Back to Trevra</a></div></header>
<section class="launch-section"><div class="split-heading"><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.intro)}</p></div>${page.body}</section>
${siteFooter(config)}
</main>
</body></html>`;
}

/**
 * The landing page's own section links. Anchors rather than routes, so the
 * same nav works on the static deploy target, where these sections are the
 * only place `/how-it-works` and `/security` exist.
 */
const SITE_LINKS = '<a href="/#approval">The gate</a><a href="/#deploy">Deploy</a>';

/** Below 1050px `.launch-nav > nav` is hidden, so the links live here instead. */
const MENU_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>';

/**
 * The wordmark, structurally identical to the one index.html and the static
 * legal documents ship, because `.launch-logo` styles `> span` and `strong`.
 */
function brandLink(): string {
  return '<a class="launch-logo" href="/" aria-label="Trevra home"><span><svg viewBox="0 0 42 34" aria-hidden="true" focusable="false" fill="currentColor"><rect width="11" height="11" rx="3"/><rect x="31" width="11" height="11" rx="3"/><rect x="14.5" width="13" height="34" rx="3.4"/></svg></span><strong>Trevra</strong></a>';
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

/**
 * The landing page's own footer shape (`.footer-brand`, three link columns,
 * `.footer-note`). `.launch-footer > div > a` is the only footer-link rule
 * marketing.css has; the `<nav>` this used to emit matched nothing.
 */
function siteFooter(config: SiteConfig): string {
  return (
    `<footer class="launch-footer">` +
    `<div class="footer-brand">${brandLink()}<p>The open-source runtime, ledger and approval gate for agent-run go-to-market.</p></div>` +
    `<div><strong>Product</strong><a href="/#approval">The gate</a><a href="/#deploy">Deploy</a></div>` +
    `<div><strong>Source</strong><a href="https://github.com/leanchain/trevra" target="_blank" rel="noreferrer">GitHub repository</a><a href="/catalog/modules.json">Catalog JSON</a><a href="/catalog/trevra.sbom.cdx.json">SBOM (CycloneDX)</a><a href="/llms.txt">Context for language models</a></div>` +
    `<div><strong>Company</strong><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${escapeAttr(config.supportEmail)}">Talk to the founder</a></div>` +
    `<p class="footer-note">&copy; ${new Date().getUTCFullYear()} ${escapeHtml(config.name)}. Built in the open.</p>` +
    `</footer>`
  );
}

/**
 * One row of a `.launch-faq` disclosure list -- the long-form pattern the
 * static /privacy and /terms documents use and the only one marketing.css
 * actually styles. `.launch-feature`, `.launch-grid` and `.launch-copy-section`
 * had zero rules behind them.
 */
function docRow(number: string, title: string, copy: string): string {
  return `<details open><summary>${escapeHtml(number)}. ${escapeHtml(title)}</summary><p>${escapeHtml(copy)}</p></details>`;
}

function setTextResponse(res: Response, seconds: number): void {
  res
    .type('text/plain; charset=utf-8')
    .set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const cleaned = value?.trim().slice(0, max);
  return cleaned || null;
}

function referrerDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.slice(0, 255) || null;
  } catch {
    return null;
  }
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
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!
  );
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
