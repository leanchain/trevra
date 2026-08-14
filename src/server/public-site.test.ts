import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase, type Db } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { renderAppIndex, renderNotFoundPage } from './public-site.js';

const HOSTED = 'https://app.usetrevra.example/#get-started';

const indexHtml = await readFile(resolve('index.html'), 'utf8');
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
const securityTxt = await readFile(resolve('public/.well-known/security.txt'), 'utf8');
const redirects = await readFile(resolve('public/_redirects'), 'utf8');

let db: Db | undefined;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
afterEach(async () => {
  await db?.close();
  db = undefined;
  delete process.env.VITE_HOSTED_APP_URL;
  delete process.env.PUBLIC_SITE_URL;
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
  return new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(marketingCss);
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
   * `#hosted`, the deploy card -- the honest next step when no hosted
   * workspace is configured. The NAV button says Login and falls back to
   * `/login`, the auth screen's own address, because "Login" scrolling the
   * page is the bug that made a pre-JS visitor think the button was dead.
   * Both are `data-hosted-cta`: where a hosted workspace IS configured, it is
   * the better destination for either.
   */
  it('rewrites every marked CTA the shipped index.html actually carries', () => {
    const shipped = indexHtml.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(shipped.length).toBeGreaterThan(0);
    for (const tag of shipped) expect(tag).toMatch(/href="(?:#hosted|\/login)"/);
    expect(shipped.filter((tag) => tag.includes('href="/login"'))).toHaveLength(1);

    process.env.VITE_HOSTED_APP_URL = HOSTED;
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    const marked = rendered.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(marked).toHaveLength(shipped.length);
    for (const tag of marked) expect(tag).toContain(`href="${HOSTED}"`);
    // The rest of the serve-time injection still works on the real file.
    expect(rendered).toContain('application/ld+json');
    expect(rendered).not.toContain('<!-- TREVRA_JSON_LD -->');
  });

  it('leaves the shipped CTAs on their own fallback when nothing is configured', () => {
    const rendered = renderAppIndex(indexHtml, 'test-nonce');
    const marked = rendered.match(/<a\b[^>]*\bdata-hosted-cta\b[^>]*>/gi) ?? [];
    expect(marked.length).toBeGreaterThan(0);
    for (const tag of marked) expect(tag).toMatch(/href="(?:#hosted|\/login)"/);
    // The nav's Login keeps naming the auth screen rather than a scroll target.
    expect(marked.filter((tag) => tag.includes('href="/login"'))).toHaveLength(1);
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
    for (const clause of [
      'Information processed', 'Purposes', 'Connected services and processors',
      'Analytics', 'Retention and deletion', 'Data rights and contact',
      // Static-only clauses that had to survive the merge too.
      'Hosted workspace data', 'Self-hosting'
    ]) expect(privacyDoc).toContain(clause);
    expect(privacyDoc).toContain('does not store IP addresses');
    expect(privacyDoc).toContain('are not measured at all');
    expect(privacyDoc).toContain('Identity verification may be required before fulfilling a request');

    for (const clause of [
      'Service', 'Accounts and authorization', 'Acceptable use', 'Third-party services',
      'No professional advice', 'Availability and liability', 'Contact',
      // Static-only clauses that had to survive the merge too.
      'Your responsibility', 'External actions'
    ]) expect(termsDoc).toContain(clause);
    expect(termsDoc).toContain('disclaims implied warranties');
    expect(termsDoc).toContain('Open-source components are provided under the license included with their source');
  });

  it('leaves exactly one legal surface, dated once', async () => {
    const app = await publicApp();
    await request(app).get('/privacy').expect(404);
    await request(app).get('/terms').expect(404);

    for (const [name, doc] of [['privacy', privacyDoc], ['terms', termsDoc]] as const) {
      const dates = doc.match(/Last updated[^<]*/g) ?? [];
      expect(dates, name).toEqual(['Last updated August 5, 2026.']);
      expect(doc.match(/<h1[ >]/g) ?? [], name).toHaveLength(1);
    }
  });

  it('styles the shipped documents the same way as the landing page', () => {
    for (const [name, doc] of [['privacy', privacyDoc], ['terms', termsDoc], ['security', securityDoc]] as const) {
      expect(doc, name).toMatch(/<main class="static-launch"[ >]/);
      expect(classesIn(doc).filter((className) => !styled(className)), name).toEqual([]);
    }
  });

  it('styles /security and /how-it-works the same way as the landing page', async () => {
    const app = await publicApp();
    for (const path of ['/security', '/how-it-works']) {
      const html = (await request(app).get(path).expect(200)).text;
      expect(html, path).toMatch(/<main class="static-launch"[ >]/);
      expect(classesIn(html).filter((name) => !styled(name)), path).toEqual([]);
    }
  });

  it('keeps the responsible-disclosure page security.txt points at', async () => {
    process.env.PUBLIC_SITE_URL = 'https://trevra.example';
    const app = await publicApp();
    const policy = (await request(app).get('/.well-known/security.txt').expect(200)).text;
    expect(policy).toContain('Policy: https://trevra.example/security');
    expect((await request(app).get('/security').expect(200)).text).toContain('Responsible disclosure');

    // The static deploy target has to resolve the same RFC 9116 Policy target.
    expect(securityTxt).toContain('Policy: https://usetrevra.com/security');
    expect(securityDoc).toContain('Responsible disclosure');
    expect(redirects).not.toMatch(/^\/security\b/m);
  });
});
