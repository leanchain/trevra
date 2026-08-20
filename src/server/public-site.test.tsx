import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDatabase, type Db } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { renderAppIndex, renderNotFoundPage } from './public-site.js';
import {
  renderSecurityText,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE
} from '../shared/site-metadata.js';
import { MarketingApp } from '../client/MarketingApp';

const HOSTED = 'https://app.usetrevra.example/#get-started';

// The template file only carries the head and an empty #root; what actually
// ships is that template with MarketingScreen's own markup rendered into it,
// which is exactly what scripts/prerender-marketing.tsx does at build time.
const template = await readFile(resolve('index.html'), 'utf8');
const indexHtml = template.replace(
  '<div id="root"></div>',
  `<div id="root">${renderToStaticMarkup(<MarketingApp />)}</div>`
);
const marketingCss = await readFile(resolve('public/marketing.css'), 'utf8');

/**
 * The legal surface is these files and nothing else. /privacy and /terms used
 * to be Express routes rendering a second, differently dated set of clauses;
 * the clauses were merged into the shipped documents and the routes deleted,
 * so every clause assertion below reads the file a visitor actually gets.
 */
const privacyDoc = await readFile(resolve('public/privacy/index.html'), 'utf8');
const termsDoc = await readFile(resolve('public/terms/index.html'), 'utf8');
const securityDoc = await readFile(resolve('public/security/index.html'), 'utf8');
const howItWorksDoc = await readFile(resolve('public/how-it-works/index.html'), 'utf8');
const redirects = await readFile(resolve('public/_redirects'), 'utf8');

// public/.well-known/security.txt used to be a hand-maintained copy with a
// hardcoded expiry; scripts/build-marketing-seo.ts now generates the only
// version, into dist/, from this same renderSecurityText() renderer -- so
// the static-deploy-target assertion below renders the equivalent text
// directly instead of reading a file that no longer exists.
const securityTxt = renderSecurityText(
  {
    origin: 'https://usetrevra.com',
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    supportEmail: 'support@usetrevra.com',
    securityEmail: 'security@usetrevra.com'
  },
  '2099-01-01T00:00:00Z'
);

let db: Db | undefined;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
afterEach(async () => {
  await db?.close();
  db = undefined;
  delete process.env.VITE_HOSTED_APP_URL;
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.PUBLIC_SITE_DESCRIPTION;
});

async function publicApp() {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  return createApp(db);
}

/** Every `class="..."` token the page emits, deduplicated. */
function classesIn(html: string): string[] {
  const found = new Set<string>();
  for (const [, value] of html.matchAll(/class="([^"]+)"/g)) {
    for (const token of value.split(/\s+/).filter(Boolean)) found.add(token);
  }
  return [...found];
}

/** Does the stylesheet actually carry a rule for this class name? */
function styled(className: string): boolean {
  return new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(
    marketingCss
  );
}

describe('the hosted-workspace CTA in shipped HTML', () => {
  /**
   * The contract with index.html: the real CTAs carry `data-hosted-cta` and
   * keep `href="#hosted"` as the degraded fallback. Anything else pointing at
   * `#hosted` -- the deploy card's own anchor, a section link -- is not a CTA
   * and must come through untouched.
   */
  const markup = [
    '<a class="launch-button" data-hosted-cta href="#hosted">Launch hosted workspace</a>',
    '<a href="#hosted" data-hosted-cta class="launch-nav-cta">Launch Trevra</a>',
    '<a href="#hosted">not a CTA</a>',
    '<a href="#modules">Explore the modules</a>'
  ].join('');

  it('rewrites only the marked CTAs, whatever order the attributes come in', () => {
    process.env.VITE_HOSTED_APP_URL = HOSTED;
    const rendered = renderAppIndex(markup, 'test-nonce');
    expect(rendered).toContain(`<a class="launch-button" data-hosted-cta href="${HOSTED}">`);
    expect(rendered).toContain(`<a href="${HOSTED}" data-hosted-cta class="launch-nav-cta">`);
    expect(rendered).toContain('<a href="#hosted">not a CTA</a>');
    expect(rendered).toContain('<a href="#modules">');
  });

  it('leaves the scroll fallback alone when no hosted workspace is configured', () => {
    const rendered = renderAppIndex(markup, 'test-nonce');
    expect(rendered.match(/href="#hosted"/g)).toHaveLength(3);
  });

  it('refuses a hosted URL that is not http(s), because the value lands in an href', () => {
    process.env.VITE_HOSTED_APP_URL = 'javascript:alert(1)';
    expect(renderAppIndex(markup, 'test-nonce')).not.toContain('javascript:');
  });

  /**
   * TWO FALLBACKS, AND THEY MEAN DIFFERENT THINGS.
   *
   * The hero and closing CTAs say "Launch hosted workspace" and fall back to
   * `#hosted`, the deploy card. The NAV button says Login and ships with the
   * live hosted login URL so a pre-JS visitor can sign in immediately. Both
   * are `data-hosted-cta`: where a different hosted workspace URL is configured
   * at serve time, it remains the better destination for either.
   */
  it('rewrites every marked CTA the shipped index.html actually carries', () => {
    const shipped = indexHtml.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(shipped.length).toBeGreaterThan(0);
    for (const tag of shipped)
      expect(tag).toMatch(/href="(?:#hosted|\/login|https:\/\/app\.usetrevra\.com\/login)"/);
    expect(
      shipped.filter((tag) => /href="(?:\/login|https:\/\/app\.usetrevra\.com\/login)"/.test(tag))
    ).toHaveLength(1);

    process.env.VITE_HOSTED_APP_URL = HOSTED;
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    const marked = rendered.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(marked).toHaveLength(shipped.length);
    for (const tag of marked) expect(tag).toContain(`href="${HOSTED}"`);
    // The rest of the serve-time injection still works on the real file.
    expect(rendered).toContain('application/ld+json');
    expect(rendered).not.toContain('<!-- TREVRA_JSON_LD -->');
  });

  /**
   * The shipped `<meta name="description">` tag's content runs past
   * Prettier's printWidth, so index.html wraps its attributes one per line;
   * the replace has to tolerate that instead of assuming one space between
   * `name="description"` and `content="..."`.
   */
  it('replaces the real, wrapped description meta tag on the shipped file', () => {
    expect(indexHtml).toMatch(/<meta\s+name="description"[\s\S]*?\/>/);
    process.env.PUBLIC_SITE_DESCRIPTION = 'a distinct configured description';
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    expect(rendered).toContain(
      '<meta name="description" content="a distinct configured description" />'
    );
  });

  /**
   * og:description and twitter:description used to be the page's own,
   * different copy, deliberately left untouched. There is one description
   * now: these two get the same config-driven rewrite as <meta
   * name="description">, and both are wrapped by Prettier the same way.
   */
  it('rewrites the wrapped og:description and twitter:description tags too', () => {
    expect(indexHtml).toMatch(/<meta\s+property="og:description"[\s\S]*?\/>/);
    expect(indexHtml).toMatch(/<meta\s+name="twitter:description"[\s\S]*?\/>/);
    process.env.PUBLIC_SITE_DESCRIPTION = 'a distinct configured description';
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    expect(rendered).toContain(
      '<meta property="og:description" content="a distinct configured description" />'
    );
    expect(rendered).toContain(
      '<meta name="twitter:description" content="a distinct configured description" />'
    );
  });

  it('defaults the title to SITE_TITLE, one title everywhere', () => {
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    expect(rendered).toContain(`<title>${SITE_TITLE}</title>`);
    expect(rendered).toContain(`<meta property="og:title" content="${SITE_TITLE}" />`);
    expect(rendered).toContain(`<meta name="twitter:title" content="${SITE_TITLE}" />`);
  });

  it('defaults the description to SITE_DESCRIPTION everywhere it appears', () => {
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    expect(rendered).toContain(`<meta name="description" content="${SITE_DESCRIPTION}" />`);
    expect(rendered).toContain(`<meta property="og:description" content="${SITE_DESCRIPTION}" />`);
    expect(rendered).toContain(`<meta name="twitter:description" content="${SITE_DESCRIPTION}" />`);
  });

  it('leaves the shipped CTAs on their own fallback when nothing is configured', () => {
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    const marked = rendered.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(marked.length).toBeGreaterThan(0);
    for (const tag of marked)
      expect(tag).toMatch(/href="(?:#hosted|\/login|https:\/\/app\.usetrevra\.com\/login)"/);
    // The nav's Login keeps naming the live auth screen rather than a scroll target.
    expect(
      marked.filter((tag) => /href="(?:\/login|https:\/\/app\.usetrevra\.com\/login)"/.test(tag))
    ).toHaveLength(1);
  });

  it('leaves the hosted app shell as an app document rather than marketing it', () => {
    process.env.VITE_HOSTED_APP_URL = HOSTED;
    process.env.PUBLIC_SITE_URL = 'https://usetrevra.example';
    const shell =
      '<!doctype html><html data-trevra-app-shell><head><title>Trevra — Sign in</title><meta name="description" content="Open your workspace." /></head><body><div id="root">Opening Trevra…</div></body></html>';
    const rendered = renderAppIndex(shell, 'test-nonce');
    expect(rendered).toContain('<title>Trevra — Sign in</title>');
    expect(rendered).toContain('Open your workspace.');
    expect(rendered).not.toContain('application/ld+json');
    expect(rendered).not.toContain(HOSTED);
  });
});

describe('the server-rendered public documents', () => {
  it('render inside .static-launch and use only classes marketing.css styles', () => {
    const html = renderNotFoundPage('test-nonce');
    expect(html).toMatch(/<main class="static-launch"[ >]/);
    const unstyled = classesIn(html).filter((name) => !styled(name));
    expect(unstyled).toEqual([]);
  });

  it('keeps every clause of the privacy notice and the terms', () => {
    // Prettier wraps long paragraphs across lines, so compare against
    // whitespace-collapsed text rather than the raw (indentation-sensitive) HTML.
    const flatPrivacy = privacyDoc.replace(/\s+/g, ' ');
    const flatTerms = termsDoc.replace(/\s+/g, ' ');
    for (const clause of [
      'Information processed',
      'Purposes',
      'Connected services and processors',
      'Analytics',
      'Retention and deletion',
      'Data rights and contact',
      // Static-only clauses that had to survive the merge too.
      'Hosted workspace data',
      'Self-hosting'
    ])
      expect(flatPrivacy).toContain(clause);
    expect(flatPrivacy).toContain('does not store IP addresses');
    expect(flatPrivacy).toContain('are not measured at all');
    expect(flatPrivacy).toContain(
      'Identity verification may be required before fulfilling a request'
    );

    for (const clause of [
      'Service',
      'Accounts and authorization',
      'Acceptable use',
      'Third-party services',
      'No professional advice',
      'Availability and liability',
      'Contact',
      // Static-only clauses that had to survive the merge too.
      'Your responsibility',
      'External actions'
    ])
      expect(flatTerms).toContain(clause);
    expect(flatTerms).toContain('disclaims implied warranties');
    expect(flatTerms).toContain(
      'Open-source components are provided under the license included with their source'
    );
  });

  it('leaves exactly one legal surface, dated once', async () => {
    const app = await publicApp();
    await request(app).get('/privacy').expect(404);
    await request(app).get('/terms').expect(404);

    for (const [name, doc] of [
      ['privacy', privacyDoc],
      ['terms', termsDoc]
    ] as const) {
      const dates = doc.match(/Last updated[^<]*/g) ?? [];
      expect(dates, name).toEqual(['Last updated August 5, 2026.']);
      expect(doc.match(/<h1[ >]/g) ?? [], name).toHaveLength(1);
    }
  });

  it('styles the shipped documents the same way as the landing page', () => {
    for (const [name, doc] of [
      ['privacy', privacyDoc],
      ['terms', termsDoc],
      ['security', securityDoc],
      ['how-it-works', howItWorksDoc]
    ] as const) {
      expect(doc, name).toMatch(/<main class="static-launch"[ >]/);
      expect(
        classesIn(doc).filter((className) => !styled(className)),
        name
      ).toEqual([]);
    }
  });

  it('serves /security and /how-it-works only as static documents, not Express routes', async () => {
    const app = await publicApp();
    const security = await request(app).get('/security').expect(404);
    expect(security.text).not.toContain('Responsible disclosure');
    expect(security.headers.link).toBeUndefined();
    const howItWorks = await request(app).get('/how-it-works').expect(404);
    expect(howItWorks.text).not.toContain('static-launch');
    expect(howItWorks.headers.link).toBeUndefined();
  });

  it('keeps the responsible-disclosure page security.txt points at', async () => {
    process.env.PUBLIC_SITE_URL = 'https://trevra.example';
    const app = await publicApp();
    const policy = (await request(app).get('/.well-known/security.txt').expect(200)).text;
    expect(policy).toContain('Policy: https://trevra.example/security');

    // The static deploy target has to resolve the same RFC 9116 Policy target.
    expect(securityTxt).toContain('Policy: https://usetrevra.com/security');
    expect(securityDoc).toContain('Responsible disclosure');
    expect(redirects).not.toMatch(/^\/security\b/m);
  });
});
