/**
 * One source of truth for site copy and structured data.
 *
 * Dependency-free: no node builtins, no express, no db, no React. Imported by
 * the client bundle, the Express server, and tsx build scripts alike.
 */

export const SITE_NAME = 'Trevra';
export const SITE_TITLE = 'Trevra — Agent-Run GTM With Human Approval';
export const SITE_DESCRIPTION =
  'Trevra lets Claude Code and Codex research and prepare GTM work. You approve consequential actions before they execute, and every outcome is recorded.';

export const SOCIAL_IMAGE = {
  path: '/og/trevra-social.png',
  width: 1200,
  height: 630,
  alt: 'Trevra — Agent-Run GTM With Human Approval'
} as const;

export const PUBLIC_PATHS = ['/', '/how-it-works', '/security', '/privacy', '/terms'] as const;

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: ReadonlyArray<FaqItem> = [
  {
    question: 'What is Trevra?',
    answer:
      'Trevra sits between your GTM agent and the systems it can affect. The agent does the research and preparation; Trevra holds consequential actions for your decision.'
  },
  {
    question: 'What can my agent do?',
    answer:
      'It can research accounts and people, score evidence, plan work, and prepare outreach or CRM activity through MCP. Agent tokens cannot approve or execute consequential actions.'
  },
  {
    question: 'Can it send outreach without me?',
    answer:
      'No. Trevra checks workspace policy and locks the exact action. A human must approve it before a named execution adapter can run.'
  },
  {
    question: 'Do I need a CRM?',
    answer: 'No. Trevra can be your founder GTM workspace or work alongside an existing CRM.'
  },
  {
    question: 'What gets recorded?',
    answer:
      'Sources, inputs, policy decisions, approvals, execution attempts, and outcomes stay in the ledger.'
  },
  {
    question: 'Can I self-host?',
    answer: 'Yes. Trevra is open source, PostgreSQL-only, and can run in your own infrastructure.'
  }
];

export interface StructuredDataConfig {
  origin: string;
  name: string;
  legalName: string;
  description: string;
  supportEmail: string;
  /** '' when this deployment has no GitHub URL to link to. */
  githubUrl: string;
}

/**
 * The `@graph` served in the JSON-LD block: Organization, WebSite,
 * WebApplication, and FAQPage, sharing the same `@id` shape used everywhere
 * on the site.
 */
export function buildStructuredData(config: StructuredDataConfig) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${config.origin}/#organization`,
        name: config.legalName,
        url: config.origin,
        email: config.supportEmail,
        logo: {
          '@type': 'ImageObject',
          url: `${config.origin}/icons/trevra-512.png`,
          width: 512,
          height: 512
        },
        ...(config.githubUrl ? { sameAs: [config.githubUrl] } : {})
      },
      {
        '@type': 'WebSite',
        '@id': `${config.origin}/#website`,
        url: config.origin,
        name: config.name,
        description: config.description,
        publisher: { '@id': `${config.origin}/#organization` },
        inLanguage: 'en'
      },
      {
        '@type': 'WebApplication',
        '@id': `${config.origin}/#application`,
        name: config.name,
        url: config.origin,
        description: config.description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript and a modern web browser',
        featureList: [
          'Ledger and deterministic control plane for agent-run GTM',
          'MCP tools for Claude Code, Codex, and compatible agents',
          'Account and people research with source provenance',
          'Outreach campaigns, inbox work, and opportunity state',
          'Durable GTM playbooks with resumable step history',
          'Workspace policy evaluation before consequential actions',
          'Exact-payload approval with cryptographic hashing',
          'Named, idempotent execution adapters for external writes',
          'Append-only events and inspectable run outcomes',
          'Open source and self-hostable on PostgreSQL'
        ],
        publisher: { '@id': `${config.origin}/#organization` }
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ_ITEMS.map(({ question, answer }) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer }
        }))
      }
    ]
  };
}

export interface WebPageStructuredDataConfig {
  origin: string;
  path: string;
  title: string;
  description: string;
}

export function buildWebPageStructuredData(config: WebPageStructuredDataConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    // Addressable rather than anonymous: an `@id` lets the WebSite and
    // WebApplication nodes -- and anything else consuming the graph -- refer
    // to this page instead of re-describing it.
    '@id': `${config.origin}${config.path}/#webpage`,
    name: config.title,
    description: config.description,
    url: `${config.origin}${config.path}`,
    isPartOf: { '@id': `${config.origin}/#website` },
    about: { '@id': `${config.origin}/#application` }
  };
}

/**
 * The subset of site config the text/markdown renderers below need. Deliberately
 * narrower than the server's own `SiteConfig` (which has plenty of fields these
 * renderers don't use) so build scripts can construct one from a handful of env
 * vars without importing anything server-side.
 */
export interface SiteRenderConfig {
  origin: string;
  name: string;
  description: string;
  supportEmail: string;
  securityEmail: string;
}

/**
 * `llms.txt` (`full: false`) and `llms-full.txt` (`full: true`), the two
 * machine-readable context documents answer engines are expected to fetch.
 * `llms-full.txt` folds in `FAQ_ITEMS` as a `## Questions` section verbatim,
 * since it's the document most likely to be quoted directly.
 */
export function renderLlmsText(config: SiteRenderConfig, full: boolean): string {
  const base = `# Trevra\n\n> ${config.description}\n\n## Primary pages\n- [Trevra](${config.origin}/): Product overview and workspace access.\n- [How Trevra works](${config.origin}/how-it-works): Product workflow, evidence model, integrations, and automation boundaries.\n- [Security](${config.origin}/security): Security architecture and responsible disclosure.\n- [Privacy](${config.origin}/privacy): Data categories, purposes, analytics, retention, and requests.\n- [Terms](${config.origin}/terms): Baseline service terms.\n\n## Machine-readable resources\n- [Sitemap](${config.origin}/sitemap.xml)\n- [Robots](${config.origin}/robots.txt)\n- [Full LLM context](${config.origin}/llms-full.txt)\n- [Agent guidance](${config.origin}/agents.md)\n- [Security contact](${config.origin}/.well-known/security.txt)\n\n## Contact\n- Product support: ${config.supportEmail}\n- Security reports: ${config.securityEmail}\n`;
  if (!full) return base;
  const questions = FAQ_ITEMS.map(({ question, answer }) => `### ${question}\n${answer}`).join(
    '\n\n'
  );
  const fullOnly = `## Product model
${config.description} Claude Code and Codex can research, interpret commercial content, and prepare bounded GTM work over MCP. Trevra deterministically controls permissions, policy, approvals, state transitions, external execution, and the durable outcome record.

## Product boundary
Trevra is focused on go-to-market operations: research, outreach, conversations, opportunity state, and the evidence-backed playbooks that connect them. It is not an accounting, project-management, billing, or generic automation system.

## Modules and playbooks
A module is a versioned, typed unit of GTM work with declared inputs, outputs, side effects, and approval requirements. Durable playbooks persist step state, attempts, evidence, policy decisions, retries, and outcomes. Installing a module never grants permission to write externally.

## Approval and evidence
Agent tokens cannot approve or execute consequential actions. Trevra freezes the complete prepared payload behind a cryptographic hash; human approval applies only to that exact payload. Named execution adapters use deterministic idempotency keys, and every attempt and outcome is appended to the ledger.

## Integrations
Integration plumbing is delegated to Nango or official provider SDKs for GTM systems such as Gmail, Microsoft 365, CRM providers, public communities, and research sources. Trevra owns normalization, source provenance, policy, approvals, and outcomes rather than rebuilding OAuth or token storage.

## Ownership
Trevra is open source, PostgreSQL-only, and self-hostable. The workspace, playbook state, ledger, evidence, and configuration can stay in infrastructure you control.

## Questions
${questions}

## Important limitations
Trevra provides operational assistance, not legal, tax, accounting, investment, medical, or other regulated professional advice. It does not expose private workspace records through public discovery files. Public agents must not attempt to access authenticated API routes or infer customer data.
`;
  return `${base}\n${fullOnly}`;
}

/** `agents.md`, guidance for agents crawling the public site directly. */
export function renderPublicAgents(config: SiteRenderConfig): string {
  return `# Trevra public agent guidance\n\nCanonical site: ${config.origin}\n\n## Allowed public retrieval\nAgents may read the public pages, sitemap, robots.txt, llms.txt, llms-full.txt, security.txt, and public image assets. Use canonical URLs when citing Trevra.\n\n## Restricted areas\nDo not attempt to access /api routes without an authenticated user request and valid authorization. Do not probe connected providers, enumerate workspaces, submit fabricated marketing events, or treat public product descriptions as permission to execute commercial actions.\n\n## Product description\n${config.description}\n\n## Preferred sources\n1. ${config.origin}/how-it-works\n2. ${config.origin}/security\n3. ${config.origin}/privacy\n4. ${config.origin}/terms\n5. ${config.origin}/llms-full.txt\n\n## Contact\nProduct: ${config.supportEmail}\nSecurity: ${config.securityEmail}\n`;
}

/** `humans.txt`, the human-readable counterpart to `llms.txt`. */
export function renderHumansText(config: SiteRenderConfig): string {
  return `/* TEAM */\nProduct: ${config.name}\nContact: ${config.supportEmail}\n\n/* PRODUCT */\n${config.description}\n\n/* STANDARDS */\nHTML5, accessibility-minded React, PostgreSQL, robots.txt, sitemap.xml, llms.txt, and RFC 9116 security.txt.\n`;
}

/**
 * `sitemap.xml`, covering every path in `PUBLIC_PATHS` with a `<lastmod>`.
 *
 * `lastmod` is taken as an ISO timestamp rather than computed here (`new
 * Date()` inside a shared, dependency-free renderer would make it neither
 * pure nor deterministic to test) and truncated to `YYYY-MM-DD`.
 */
export function renderSitemap(origin: string, lastmod: string): string {
  const date = lastmod.slice(0, 10);
  const urls = PUBLIC_PATHS.map(
    (path) => `  <url><loc>${escapeXml(`${origin}${path}`)}</loc><lastmod>${date}</lastmod></url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * `robots.txt`. One renderer for both origins: the Express route serves it
 * per request and scripts/build-marketing-seo.ts writes it into `dist/`, so a
 * preview deploy advertises its own sitemap and host instead of production's.
 */
export function renderRobotsTxt(origin: string): string {
  return `${[
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    `Host: ${new URL(origin).host}`,
    ''
  ].join('\n')}`;
}

/**
 * `/.well-known/security.txt` (RFC 9116). `expires` is taken as an ISO
 * timestamp rather than computed here, for the same purity reason as
 * `renderSitemap`'s `lastmod`.
 */
export function renderSecurityText(config: SiteRenderConfig, expires: string): string {
  const secureOrigin = config.origin.startsWith('https://');
  const lines = [
    `Contact: mailto:${config.securityEmail}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en'
  ];
  if (secureOrigin)
    lines.push(
      `Canonical: ${config.origin}/.well-known/security.txt`,
      `Policy: ${config.origin}/security`
    );
  return `${lines.join('\n')}\n`;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!
  );
}
