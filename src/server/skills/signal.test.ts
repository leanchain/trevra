import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import {
  captureSnapshot,
  contentHash,
  diffSnapshots,
  extractCustomerProofItems,
  extractIntegrationItems,
  extractJobPostings,
  extractPricingFacts,
  extractReleaseNotesFacts,
  watchSignals,
  type ResearchSnapshot
} from './signal.js';
import type { FetchLike } from './guard.js';
import type { SkillContext } from './types.js';

// Two hand-written snapshots. Every diff assertion below runs against these
// with no network involved at all.
const BEFORE: ResearchSnapshot = {
  domain: 'acme.test',
  capturedAt: '2026-06-01T00:00:00.000Z',
  headline: 'Shipping software faster',
  jobsUrl: 'https://acme.test/careers',
  jobCount: 3,
  jobTitles: ['Backend Engineer', 'Designer', 'Support Lead'],
  pricingUrl: 'https://acme.test/pricing',
  pricingHash: 'aaaaaaaaaaaaaaaa',
  productUrl: 'https://acme.test/products.json?limit=250',
  productCount: 2,
  productCapped: false,
  productItems: [
    { key: '1', label: 'Alpha' },
    { key: '2', label: 'Beta' }
  ],
  tech: ['hubspot', 'nextjs']
};

const AFTER: ResearchSnapshot = {
  domain: 'acme.test',
  capturedAt: '2026-07-01T00:00:00.000Z',
  headline: 'The revenue platform for operators',
  jobsUrl: 'https://acme.test/careers',
  jobCount: 5,
  jobTitles: ['Backend Engineer', 'Designer', 'Head of RevOps', 'Sales Engineer', 'Support Lead'],
  pricingUrl: 'https://acme.test/pricing',
  pricingHash: 'bbbbbbbbbbbbbbbb',
  productUrl: 'https://acme.test/products.json?limit=250',
  productCount: 2,
  productCapped: false,
  productItems: [
    { key: '1', label: 'Alpha' },
    { key: '2', label: 'Beta' }
  ],
  tech: ['nextjs', 'segment']
};

describe('diffSnapshots', () => {
  it('reports a first capture when there is no prior snapshot', () => {
    const signals = diffSnapshots(null, BEFORE);
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('first-capture');
    expect(signals[0].previous).toBeNull();
    expect(signals[0].detail).toContain('3 open role(s)');
  });

  it('emits every typed signal between two real snapshots, in a stable order', () => {
    const signals = diffSnapshots(BEFORE, AFTER);
    expect(signals.map((signal) => signal.kind)).toEqual([
      'hiring-up',
      'pricing-changed',
      'headline-changed',
      'tech-added',
      'tech-removed'
    ]);

    const hiring = signals[0];
    expect(hiring.detail).toBe(
      'Open roles on https://acme.test/careers went from 3 to 5 (new: Head of RevOps; Sales Engineer).'
    );
    expect(hiring.previous).toBe('3');
    expect(hiring.current).toBe('5');

    expect(signals[1].detail).toContain('aaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbb');
    expect(signals[2].detail).toContain(
      '"Shipping software faster" to "The revenue platform for operators"'
    );
    expect(signals[3].detail).toContain('added segment');
    expect(signals[4].detail).toContain('dropped hubspot');
  });

  it('explains pricing changes with visible facts and ignores surrounding copy churn', () => {
    const before: ResearchSnapshot = {
      ...BEFORE,
      headline: AFTER.headline,
      jobCount: AFTER.jobCount,
      jobTitles: AFTER.jobTitles,
      tech: AFTER.tech,
      pricingFacts: ['Starter €29 / month', 'Enterprise plan']
    };
    const after: ResearchSnapshot = {
      ...AFTER,
      pricingFacts: ['Starter €39 / month', 'Enterprise plan']
    };
    const pricing = diffSnapshots(before, after).find(
      (signal) => signal.kind === 'pricing-changed'
    );
    expect(pricing?.detail).toContain('removed “Starter €29 / month”');
    expect(pricing?.detail).toContain('added “Starter €39 / month”');
    expect(pricing?.previous).toBe(BEFORE.pricingHash);
    expect(pricing?.current).toBe(AFTER.pricingHash);

    const copyOnly = diffSnapshots(before, {
      ...after,
      pricingFacts: before.pricingFacts,
      pricingHash: 'cccccccccccccccc'
    });
    expect(copyOnly.map((signal) => signal.kind)).not.toContain('pricing-changed');
  });

  it('keeps hash-based pricing wording when either snapshot predates pricing facts', () => {
    const previous: ResearchSnapshot = {
      ...BEFORE,
      headline: AFTER.headline,
      jobCount: AFTER.jobCount,
      jobTitles: AFTER.jobTitles,
      tech: AFTER.tech
    };
    const current: ResearchSnapshot = { ...AFTER, pricingFacts: ['€39 / month'] };
    const pricing = diffSnapshots(previous, current).find(
      (signal) => signal.kind === 'pricing-changed'
    );
    expect(pricing?.detail).toContain('aaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbb');
  });

  it('emits release-note movement only when stable release facts move', () => {
    const before: ResearchSnapshot = {
      ...AFTER,
      headline: BEFORE.headline,
      jobCount: BEFORE.jobCount,
      jobTitles: BEFORE.jobTitles,
      pricingHash: BEFORE.pricingHash,
      tech: BEFORE.tech,
      releaseNotesUrl: 'https://acme.test/changelog',
      releaseNotesHash: 'release-before',
      releaseNotesFacts: ['Faster exports', 'Role-based access']
    };
    const after: ResearchSnapshot = {
      ...before,
      capturedAt: '2026-07-02T00:00:00.000Z',
      releaseNotesHash: 'release-after',
      releaseNotesFacts: ['AI summaries', 'Faster exports', 'Role-based access']
    };
    const release = diffSnapshots(before, after).find(
      (signal) => signal.kind === 'release-notes-changed'
    );
    expect(release?.detail).toContain('added “AI summaries”');
    expect(release?.previous).toBe('release-before');
    expect(release?.current).toBe('release-after');

    const copyOnly = diffSnapshots(before, {
      ...after,
      releaseNotesHash: 'release-copy-only',
      releaseNotesFacts: before.releaseNotesFacts
    });
    expect(copyOnly.map((signal) => signal.kind)).not.toContain('release-notes-changed');
  });

  it('does not turn hash churn into a release when both captures have no stable release headings', () => {
    const before: ResearchSnapshot = {
      ...AFTER,
      releaseNotesUrl: 'https://acme.test/changelog',
      releaseNotesHash: 'release-before',
      releaseNotesFacts: []
    };
    const after: ResearchSnapshot = {
      ...before,
      releaseNotesHash: 'release-after',
      releaseNotesFacts: []
    };
    expect(diffSnapshots(before, after).map((signal) => signal.kind)).not.toContain(
      'release-notes-changed'
    );
  });

  it('diffs first-party integration inventory without confusing removals and additions', () => {
    const before: ResearchSnapshot = {
      ...AFTER,
      headline: BEFORE.headline,
      jobCount: BEFORE.jobCount,
      jobTitles: BEFORE.jobTitles,
      pricingHash: BEFORE.pricingHash,
      tech: BEFORE.tech,
      integrationsUrl: 'https://acme.test/integrations',
      integrationItems: [
        { key: '/integrations/salesforce', label: 'Salesforce' },
        { key: '/integrations/slack', label: 'Slack' }
      ]
    };
    const after: ResearchSnapshot = {
      ...before,
      capturedAt: '2026-07-02T00:00:00.000Z',
      integrationItems: [
        { key: '/integrations/salesforce', label: 'Salesforce' },
        { key: '/integrations/snowflake', label: 'Snowflake' }
      ]
    };
    const signals = diffSnapshots(before, after);
    expect(signals.map((signal) => signal.kind)).toEqual([
      'integration-added',
      'integration-removed'
    ]);
    expect(signals[0].detail).toContain('Snowflake');
    expect(signals[1].detail).toContain('Slack');
    expect(signals[0].previous).toBe(signals[1].previous);
    expect(signals[0].current).toBe(signals[1].current);
  });

  it('diffs customer proof inventory as commercial traction evidence', () => {
    const before: ResearchSnapshot = {
      ...AFTER,
      headline: BEFORE.headline,
      jobCount: BEFORE.jobCount,
      jobTitles: BEFORE.jobTitles,
      pricingHash: BEFORE.pricingHash,
      tech: BEFORE.tech,
      customerProofUrl: 'https://acme.test/customers',
      customerProofItems: [
        { key: '/customers/orbit', label: 'Orbit' },
        { key: '/customers/northstar', label: 'Northstar' }
      ]
    };
    const after: ResearchSnapshot = {
      ...before,
      capturedAt: '2026-07-02T00:00:00.000Z',
      customerProofItems: [
        { key: '/customers/orbit', label: 'Orbit' },
        { key: '/customers/contoso', label: 'Contoso' }
      ]
    };
    const signals = diffSnapshots(before, after);
    expect(signals.map((signal) => signal.kind)).toEqual([
      'customer-proof-added',
      'customer-proof-removed'
    ]);
    expect(signals[0].detail).toContain('Contoso');
    expect(signals[1].detail).toContain('Northstar');
  });

  it('emits storefront-rebuild only for high-confidence commerce-platform migrations', () => {
    const shopify: ResearchSnapshot = {
      ...BEFORE,
      storefrontPlatform: 'shopify',
      storefrontPlatformConfidence: 1
    };
    const woo: ResearchSnapshot = {
      ...AFTER,
      headline: BEFORE.headline,
      jobCount: BEFORE.jobCount,
      jobTitles: BEFORE.jobTitles,
      pricingHash: BEFORE.pricingHash,
      tech: BEFORE.tech,
      storefrontPlatform: 'woocommerce',
      storefrontPlatformConfidence: 0.9
    };
    expect(diffSnapshots(shopify, woo).map((signal) => signal.kind)).toEqual([
      'storefront-rebuild'
    ]);
    expect(diffSnapshots(shopify, woo)[0].detail).toContain('shopify to woocommerce');

    expect(
      diffSnapshots(shopify, { ...woo, storefrontPlatformConfidence: 0.7 }).map(
        (signal) => signal.kind
      )
    ).not.toContain('storefront-rebuild');
    expect(
      diffSnapshots(shopify, {
        ...woo,
        storefrontPlatform: 'webflow',
        storefrontPlatformConfidence: 1
      }).map((signal) => signal.kind)
    ).not.toContain('storefront-rebuild');
    expect(
      diffSnapshots({ ...shopify, storefrontPlatform: undefined }, woo).map((signal) => signal.kind)
    ).not.toContain('storefront-rebuild');
  });

  it('detects product launches from the public catalog without treating a baseline as a launch', () => {
    const launched: ResearchSnapshot = {
      ...AFTER,
      productCount: 3,
      productItems: [...AFTER.productItems, { key: '3', label: 'Gamma Drop' }]
    };
    const signals = diffSnapshots(AFTER, launched);
    expect(signals.map((signal) => signal.kind)).toEqual(['product-launch']);
    expect(signals[0].detail).toContain('Gamma Drop');
    expect(signals[0].previous).not.toBe(signals[0].current);
  });

  it('emits explicit first-party newsletter and social presence changes without calling them activity or growth', () => {
    const before: ResearchSnapshot = {
      ...AFTER,
      newsletterSignups: [],
      socialProfiles: []
    };
    const after: ResearchSnapshot = {
      ...AFTER,
      capturedAt: '2026-07-02T00:00:00.000Z',
      newsletterSignups: [
        {
          sourceUrl: 'https://acme.test/newsletter',
          provider: 'klaviyo',
          key: 'klaviyo@https://acme.test/newsletter'
        }
      ],
      socialProfiles: [
        {
          platform: 'instagram',
          handle: 'acme',
          url: 'https://www.instagram.com/acme'
        }
      ]
    };
    const signals = diffSnapshots(before, after);
    expect(signals.map((signal) => signal.kind)).toEqual([
      'newsletter-signup-added',
      'social-profile-added'
    ]);
    expect(signals[0].detail).toContain('using klaviyo');
    expect(signals[1].detail).toContain('instagram:acme');
    expect(signals.map((signal) => signal.kind)).not.toContain('newsletter-started');
    expect(signals.map((signal) => signal.kind)).not.toContain('social-growth');
  });

  it('does not manufacture surface changes when upgrading from a snapshot that never captured them', () => {
    const current: ResearchSnapshot = {
      ...AFTER,
      newsletterSignups: [
        {
          sourceUrl: 'https://acme.test/',
          provider: null,
          key: 'first-party@https://acme.test/'
        }
      ],
      socialProfiles: [{ platform: 'tiktok', handle: 'acme', url: 'https://www.tiktok.com/@acme' }]
    };
    expect(diffSnapshots(AFTER, current)).toEqual([]);
  });

  it('separates ecommerce app changes from generic stack churn', () => {
    const changed: ResearchSnapshot = {
      ...BEFORE,
      tech: ['hubspot', 'klaviyo', 'recharge']
    };
    const signals = diffSnapshots(BEFORE, changed);
    expect(signals.map((signal) => signal.kind)).toEqual(['commerce-app-added', 'tech-removed']);
    expect(signals[0].detail).toContain('klaviyo');
    expect(signals[0].detail).toContain('recharge');
    expect(signals[1].detail).toContain('nextjs');
  });

  it('is deterministic: the same pair diffs identically every time', () => {
    expect(diffSnapshots(BEFORE, AFTER)).toEqual(diffSnapshots(BEFORE, AFTER));
  });

  it('names the roles that closed when hiring goes down', () => {
    const signals = diffSnapshots(AFTER, BEFORE);
    expect(signals[0].kind).toBe('hiring-down');
    expect(signals[0].detail).toContain('gone: Head of RevOps; Sales Engineer');
  });

  it('reports nothing when the snapshots agree', () => {
    expect(diffSnapshots(BEFORE, { ...BEFORE, capturedAt: '2026-07-01T00:00:00.000Z' })).toEqual(
      []
    );
  });

  it('never diffs a field that was not captured', () => {
    // The careers page timed out this run. "3 roles -> 0 roles" would be an
    // urgent-looking signal invented by a flaky fetch.
    const missed: ResearchSnapshot = {
      ...AFTER,
      jobCount: null,
      jobTitles: [],
      pricingHash: null,
      headline: null,
      tech: null
    };
    expect(diffSnapshots(BEFORE, missed)).toEqual([]);
    expect(diffSnapshots(missed, BEFORE)).toEqual([]);
  });

  it('distinguishes "no roles" from "not captured"', () => {
    const empty: ResearchSnapshot = { ...BEFORE, jobCount: 0, jobTitles: [] };
    const signals = diffSnapshots(BEFORE, empty);
    expect(signals.map((signal) => signal.kind)).toEqual(['hiring-down']);
    expect(signals[0].current).toBe('0');
  });
});

describe('extractJobPostings', () => {
  it('reads JSON-LD JobPosting titles and per-role links, ignoring navigation', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Head of RevOps' })}</script>
      <a href="/careers/sales-engineer">Sales Engineer</a>
      <a href="https://jobs.lever.co/acme/abc">Backend Engineer</a>
      <a href="/careers">All jobs</a>
      <a href="/about">About</a>`;
    expect(extractJobPostings(html, 'https://acme.test/careers')).toEqual([
      'Backend Engineer',
      'Head of RevOps',
      'Sales Engineer'
    ]);
  });

  it('does not turn ATS board filters/categories into job titles', () => {
    const html = `<a href="?">All</a>
      <a href="?department=Engineering">Engineering</a>
      <a href="?department=&team=Business%20Technology">Business Technology</a>
      <a href="https://jobs.lever.co/acme/ff939e62-6ea6-4502-b8e3-8ce35b6964bf">Apply</a>
      <a href="https://jobs.lever.co/acme/ff939e62-6ea6-4502-b8e3-8ce35b6964bf">AI Engineer</a>`;
    expect(extractJobPostings(html, 'https://jobs.lever.co/acme')).toEqual(['AI Engineer']);
  });
});

describe('release-note facts', () => {
  it('keeps release-entry headings and drops page labels and date-only headings', () => {
    expect(
      extractReleaseNotesFacts(`<h1>Changelog</h1>
        <h2>September 12, 2026</h2>
        <h3>AI summaries for every account</h3>
        <h3>Release notes</h3>
        <h3>Faster CSV exports</h3>`)
    ).toEqual(['AI summaries for every account', 'Faster CSV exports']);
  });
});

describe('integration inventory', () => {
  it('keeps named same-origin detail links and drops CTAs, roots and off-origin links', () => {
    expect(
      extractIntegrationItems(
        `<h3><a href="/integrations/analytics">Analytics</a></h3>
         <a href="/integrations/salesforce">Salesforce By Salesforce Sync CRM records</a>
         <a href="/integrations/salesforce">Learn more</a>
         <a href="/integrations/snowflake">Snowflake</a>
         <a href="/integrations">All integrations</a>
         <a href="https://evil.example/integrations/hubspot">HubSpot</a>`,
        'https://acme.test/integrations'
      )
    ).toEqual([
      { key: '/integrations/salesforce', label: 'Salesforce' },
      { key: '/integrations/snowflake', label: 'Snowflake' }
    ]);
  });
});
describe('customer proof inventory', () => {
  it('keeps same-origin customer stories and drops category links, CTAs and off-origin stories', () => {
    expect(
      extractCustomerProofItems(
        `<h3><a href="/customers/enterprise">Enterprise</a></h3>
         <a href="/customers/orbit">Orbit Read case study</a>
         <a href="/customers/northstar">Northstar</a>
         <a href="/customers">All customers</a>
         <a href="https://evil.example/customers/contoso">Contoso</a>`,
        'https://acme.test/customers'
      )
    ).toEqual([
      { key: '/customers/northstar', label: 'Northstar' },
      { key: '/customers/orbit', label: 'Orbit' }
    ]);
  });

  it('drops navigation tabs and canonicalizes noisy card copy from the story path', () => {
    expect(
      extractCustomerProofItems(
        `<nav><a href="/customers/all">All customer stories</a></nav>
         <a data-active="false" href="/customers/ai">AI</a>
         <a href="/customers/amazon">Amazon logo Watch video Amazon simplifies payments</a>
         <a href="/customers/atlassian">1 more</a>
         <a href="/customers/dandelion-chocolate">How Dandelion Chocolate scales craft</a>`,
        'https://acme.test/customers'
      )
    ).toEqual([
      { key: '/customers/amazon', label: 'Amazon' },
      { key: '/customers/atlassian', label: 'Atlassian' },
      { key: '/customers/dandelion-chocolate', label: 'Dandelion Chocolate' }
    ]);
  });
});

describe('contentHash', () => {
  it('hashes visible text, so a changed build id is not a pricing change', () => {
    const a =
      '<html><script src="/_next/static/abc123/main.js"></script><body><h2>29 EUR</h2></body></html>';
    const b =
      '<html><script src="/_next/static/zzz999/main.js"></script><body><h2>29 EUR</h2></body></html>';
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(a.replace('29', '39')));
  });

  it('extracts bounded human-readable price and plan facts without script noise', () => {
    expect(
      extractPricingFacts(`<script>window.price = '$999'</script>
        <h2>Starter</h2><p>€29 / month</p>
        <h2>Enterprise plan</h2><p>Contact sales</p>
        <p>30 day free trial</p><div>$ 1 0 per user/month</div>`)
    ).toEqual(['Contact sales', 'Enterprise plan', '€29 / month']);
  });
});

function site(routes: Record<string, () => Response>): FetchLike {
  return async (url: string) => {
    const route = routes[new URL(url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
}

function html(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('captureSnapshot', () => {
  const routes: Record<string, () => Response> = {
    '/': () =>
      html(
        '<html><head><script src="https://cdn.segment.com/a.js"></script></head>' +
          '<body><h1>The revenue platform</h1><a href="/company/open-roles">Careers</a><a href="/pricing">Pricing</a></body></html>'
      ),
    '/company/open-roles': () => html('<a href="/careers/head-of-revops">Head of RevOps</a>'),
    '/pricing': () => html('<body><h2>29 EUR per seat</h2></body>')
  };

  it("captures every watched field, following the site's own links", async () => {
    const snapshot = await captureSnapshot('acme.test', {
      fetchImpl: site(routes),
      now: new Date('2026-07-27T00:00:00.000Z')
    });

    expect(snapshot.domain).toBe('acme.test');
    expect(snapshot.capturedAt).toBe('2026-07-27T00:00:00.000Z');
    expect(snapshot.headline).toBe('The revenue platform');
    expect(snapshot.jobsUrl).toBe('https://acme.test/company/open-roles');
    expect(snapshot.jobCount).toBe(1);
    expect(snapshot.jobTitles).toEqual(['Head of RevOps']);
    expect(snapshot.pricingUrl).toBe('https://acme.test/pricing');
    expect(snapshot.pricingHash).toHaveLength(16);
    expect(snapshot.pricingFacts).toEqual(['29 EUR per seat']);
    expect(snapshot.tech).toEqual(['segment']);
  });

  it('captures an explicitly published first-party customer stories page', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<h1>Acme</h1><a href="/customers">Customers</a>');
      if (url.pathname === '/customers')
        return html(
          '<h1>Customer stories</h1><a href="/customers/orbit">Orbit</a><a href="/customers/northstar">Northstar</a>'
        );
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['customers'],
      fetchImpl,
      pageBudget: 4
    });
    expect(snapshot.customerProofUrl).toBe('https://acme.test/customers');
    expect(snapshot.customerProofItems).toEqual([
      { key: '/customers/northstar', label: 'Northstar' },
      { key: '/customers/orbit', label: 'Orbit' }
    ]);
    expect(seen.filter((path) => path === '/customers')).toHaveLength(1);
  });

  it('rejects an unrelated customer-page fallback that does not identify as customer proof', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<h1>Acme</h1>');
      if (url.pathname === '/customers')
        return html('<h1>Account login</h1><a href="/customers/orbit">Orbit</a>');
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['customers'],
      fetchImpl,
      pageBudget: 5
    });
    expect(snapshot.customerProofUrl).toBeNull();
    expect(snapshot.customerProofItems).toBeNull();
  });

  it('captures an explicitly published first-party integrations marketplace', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/')
        return html('<h1>Acme</h1><a href="/integrations">Integrations</a>');
      if (url.pathname === '/integrations')
        return html(
          '<h1>Integrations</h1><a href="/integrations/salesforce">Salesforce</a><a href="/integrations/snowflake">Snowflake</a>'
        );
      return new Response('not found', { status: 404 });
    };

    const snapshot = await captureSnapshot('acme.test', {
      watch: ['integrations'],
      fetchImpl,
      pageBudget: 4
    });

    expect(snapshot.integrationsUrl).toBe('https://acme.test/integrations');
    expect(snapshot.integrationItems).toEqual([
      { key: '/integrations/salesforce', label: 'Salesforce' },
      { key: '/integrations/snowflake', label: 'Snowflake' }
    ]);
    expect(seen.filter((path) => path === '/integrations')).toHaveLength(1);
  });

  it('rejects an unrelated integrations fallback that does not identify itself as a marketplace', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<h1>Acme</h1>');
      if (url.pathname === '/integrations')
        return html('<h1>Partners</h1><a href="/integrations/salesforce">Salesforce</a>');
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['integrations'],
      fetchImpl,
      pageBudget: 4
    });
    expect(snapshot.integrationsUrl).toBeNull();
    expect(snapshot.integrationItems).toBeNull();
  });

  it('captures an explicitly published first-party changelog with stable release facts', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      seen.push(url.pathname);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<h1>Acme</h1><a href="/changelog">Changelog</a>');
      if (url.pathname === '/changelog')
        return html(
          '<h1>Changelog</h1><h2>September 12, 2026</h2><h3>AI summaries</h3><h3>Faster exports</h3>'
        );
      return new Response('not found', { status: 404 });
    };

    const snapshot = await captureSnapshot('acme.test', {
      watch: ['releases'],
      fetchImpl,
      pageBudget: 4
    });

    expect(snapshot.releaseNotesUrl).toBe('https://acme.test/changelog');
    expect(snapshot.releaseNotesHash).toHaveLength(16);
    expect(snapshot.releaseNotesFacts).toEqual(['AI summaries', 'Faster exports']);
    expect(seen.filter((path) => path === '/changelog')).toHaveLength(1);
  });

  it('does not treat an unrelated fallback response as a release-notes page', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<h1>Acme</h1>');
      if (url.pathname === '/changelog') return html('<h1>Company news</h1><h2>Office party</h2>');
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['releases'],
      fetchImpl,
      pageBudget: 5
    });
    expect(snapshot.releaseNotesUrl).toBeNull();
    expect(snapshot.releaseNotesHash).toBeNull();
    expect(snapshot.releaseNotesFacts).toBeNull();
  });

  it('follows one explicitly published external ATS board under its own robots/request budget', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      seen.push(url.toString());
      if (url.hostname === 'acme.test') {
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/')
          return html('<h1>Acme</h1><a href="https://jobs.lever.co/acme">Careers</a>');
        return new Response('not found', { status: 404 });
      }
      if (url.hostname === 'jobs.lever.co') {
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/acme')
          return html(
            '<a href="https://jobs.lever.co/acme/one">Backend Engineer</a>' +
              '<a href="https://jobs.lever.co/acme/two">Head of Sales</a>'
          );
      }
      return new Response('not found', { status: 404 });
    };

    const snapshot = await captureSnapshot('acme.test', {
      watch: ['hiring'],
      fetchImpl,
      pageBudget: 5
    });

    expect(snapshot.jobsUrl).toBe('https://jobs.lever.co/acme');
    expect(snapshot.jobCount).toBe(2);
    expect(snapshot.jobTitles).toEqual(['Backend Engineer', 'Head of Sales']);
    expect(seen).toContain('https://jobs.lever.co/robots.txt');
    expect(seen).not.toContain('https://acme.test/careers');
    expect(seen).not.toContain('https://acme.test/jobs');
  });

  it('does not report zero hiring when a careers landing page delegates to an unreadable ATS', async () => {
    let atsPageReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.hostname === 'acme.test') {
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/') return html('<a href="/careers">Careers</a>');
        if (url.pathname === '/careers')
          return html('<a href="https://jobs.ashbyhq.com/acme">View jobs</a>');
        return new Response('not found', { status: 404 });
      }
      if (url.hostname === 'jobs.ashbyhq.com') {
        if (url.pathname === '/robots.txt') {
          return new Response('User-agent: *\nDisallow: /', {
            status: 200,
            headers: { 'content-type': 'text/plain' }
          });
        }
        atsPageReads += 1;
        return html('<a href="/acme/role">Backend Engineer</a>');
      }
      return new Response('not found', { status: 404 });
    };

    const snapshot = await captureSnapshot('acme.test', {
      watch: ['hiring'],
      fetchImpl,
      pageBudget: 5
    });

    expect(snapshot.jobsUrl).toBeNull();
    expect(snapshot.jobCount).toBeNull();
    expect(snapshot.jobTitles).toEqual([]);
    expect(atsPageReads).toBe(0);
  });

  it('never follows an arbitrary off-origin careers link outside the ATS allowlist', async () => {
    let evilReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.hostname === 'evil.example') evilReads += 1;
      if (url.hostname === 'acme.test' && url.pathname === '/robots.txt')
        return new Response('', { status: 404 });
      if (url.hostname === 'acme.test' && url.pathname === '/')
        return html('<a href="https://evil.example/jobs">Careers</a>');
      return new Response('not found', { status: 404 });
    };

    const snapshot = await captureSnapshot('acme.test', {
      watch: ['hiring'],
      fetchImpl,
      pageBudget: 5
    });
    expect(snapshot.jobCount).toBeNull();
    expect(evilReads).toBe(0);
  });

  it('captures first-party newsletter signup and published social profiles from the shared crawl', async () => {
    const surfaces = site({
      '/': () =>
        html(`<html><body><h1>Acme</h1>
          <form><h2>Subscribe to our newsletter</h2><input type="email" name="email"></form>
          <a href="https://instagram.com/acme">Instagram</a>
          <a href="https://www.tiktok.com/@acme">TikTok</a>
        </body></html>`)
    });
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['newsletter', 'social'],
      fetchImpl: surfaces
    });
    expect(snapshot.newsletterSignups).toEqual([
      {
        sourceUrl: 'https://acme.test/',
        provider: null,
        key: 'first-party@https://acme.test/'
      }
    ]);
    expect(
      snapshot.socialProfiles?.map((profile) => `${profile.platform}:${profile.handle}`)
    ).toEqual(['instagram:acme', 'tiktok:acme']);
  });

  it('follows the newsletter page for publication feeds even when the homepage already has a signup', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      seen.push(path);
      if (path === '/robots.txt') return new Response('', { status: 404 });
      if (path === '/')
        return html(`<form><h2>Subscribe to our newsletter</h2><input type="email"></form>
          <a href="/newsletter">Newsletter</a>`);
      if (path === '/newsletter')
        return html(
          '<link rel="alternate" type="application/rss+xml" href="https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml">'
        );
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['newsletter'],
      fetchImpl,
      pageBudget: 4
    });
    expect(snapshot.newsletterSignups).toHaveLength(1);
    expect(snapshot.newsletterPublications).toEqual([
      {
        platform: 'beehiiv',
        url: 'https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml',
        feedUrl: 'https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml'
      }
    ]);
    expect(seen.filter((path) => path === '/newsletter')).toHaveLength(1);
  });

  it('captures a same-origin RSS feed only after following the explicit newsletter page', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      seen.push(path);
      if (path === '/robots.txt') return new Response('', { status: 404 });
      if (path === '/')
        return html(
          '<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml"><a href="/newsletter">Newsletter</a>'
        );
      if (path === '/newsletter')
        return html(
          '<link rel="alternate" type="application/rss+xml" href="/newsletter/feed.xml">'
        );
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['newsletter'],
      fetchImpl,
      pageBudget: 4
    });
    expect(snapshot.newsletterPublications).toEqual([
      {
        platform: 'public-feed',
        url: 'https://acme.test/newsletter',
        feedUrl: 'https://acme.test/newsletter/feed.xml'
      }
    ]);
    expect(seen.filter((path) => path === '/newsletter')).toHaveLength(1);
  });

  it('follows at most one same-origin newsletter page when the homepage only links to it', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(new URL(url).pathname);
      const path = new URL(url).pathname;
      if (path === '/robots.txt') return new Response('', { status: 404 });
      if (path === '/') return html('<a href="/newsletter">Newsletter</a>');
      if (path === '/newsletter')
        return html('<form><h2>Join our newsletter</h2><input type="email"></form>');
      return new Response('not found', { status: 404 });
    };
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['newsletter'],
      fetchImpl,
      pageBudget: 4
    });
    expect(snapshot.newsletterSignups?.[0]?.sourceUrl).toBe('https://acme.test/newsletter');
    expect(seen.filter((path) => path === '/newsletter')).toHaveLength(1);
  });

  it('captures Shopify products from the bounded public endpoint', async () => {
    const shop = site({
      '/': () =>
        html(
          '<html><head><script src="https://cdn.shopify.com/shop.js"></script></head><body><h1>Store</h1></body></html>'
        ),
      '/products.json': () =>
        json({
          products: [
            { id: 1, title: 'Alpha' },
            { id: 2, title: 'Beta' }
          ]
        })
    });
    const snapshot = await captureSnapshot('shop.test', { watch: ['products'], fetchImpl: shop });
    expect(snapshot.productUrl).toBe('https://shop.test/products.json?limit=250');
    expect(snapshot.productCount).toBe(2);
    expect(snapshot.productCapped).toBe(false);
    expect(snapshot.productItems).toEqual([
      { key: '1', label: 'Alpha' },
      { key: '2', label: 'Beta' }
    ]);
  });

  it('uses reviewed platform evidence to watch a headless Shopify catalog', async () => {
    const shop = site({
      '/': () => html('<html><body><h1>Headless storefront</h1></body></html>'),
      '/products.json': () => json({ products: [{ id: 11, title: 'Hidden Platform Product' }] })
    });
    const snapshot = await captureSnapshot('headless.test', {
      watch: ['products'],
      platformHint: 'shopify',
      fetchImpl: shop
    });
    expect(snapshot.productCount).toBe(1);
    expect(snapshot.productItems[0]).toEqual({ key: '11', label: 'Hidden Platform Product' });
  });

  it('captures only what was asked for, leaving the rest uncaptured', async () => {
    const snapshot = await captureSnapshot('acme.test', {
      watch: ['headline'],
      fetchImpl: site(routes)
    });
    expect(snapshot.headline).toBe('The revenue platform');
    expect(snapshot.jobCount).toBeNull();
    expect(snapshot.pricingHash).toBeNull();
    expect(snapshot.productCount).toBeNull();
    expect(snapshot.storefrontPlatform).toBeNull();
    expect(snapshot.storefrontPlatformConfidence).toBeNull();
    expect(snapshot.tech).toBeNull();
  });

  it('records nulls rather than zeros when the site is unreachable', async () => {
    const snapshot = await captureSnapshot('down.test', {
      fetchImpl: async () => {
        throw new TypeError('network down');
      }
    });
    expect(snapshot.jobCount).toBeNull();
    expect(snapshot.pricingHash).toBeNull();
    expect(snapshot.productCount).toBeNull();
    expect(snapshot.headline).toBeNull();
    expect(snapshot.tech).toBeNull();
  });

  it('rejects a non-public host before any probe runs', async () => {
    await expect(captureSnapshot('localhost', { fetchImpl: site({}) })).rejects.toThrow(
      'localhost not allowed'
    );
  });
});

describe('gtm.watch-signal persistence', () => {
  /** Minimal `Db` stand-in: records the insert, replays one stored snapshot. */
  function fakeDb(stored: ResearchSnapshot | null): { db: Db; inserts: unknown[][] } {
    const inserts: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          get: async () =>
            sql.includes('SELECT') && stored ? { snapshot_json: stored } : undefined,
          all: async () => [],
          run: async (...params: unknown[]) => {
            if (sql.includes('INSERT')) inserts.push(params);
            return { changes: 1 };
          }
        };
      }
    } as unknown as Db;
    return { db, inserts };
  }

  const clock = new Date('2026-07-27T12:00:00.000Z');

  const routes: Record<string, () => Response> = {
    '/': () => html('<html><body><h1>Shipping software faster</h1></body></html>'),
    '/careers': () => html('<a href="/careers/designer">Designer</a>')
  };

  it('diffs against the stored snapshot and persists the new one', async () => {
    const { db, inserts } = fakeDb(BEFORE);
    const ctx: SkillContext = { db, workspaceId: 'ws_test', now: () => clock };
    const result = await watchSignals('acme.test', ctx, { fetchImpl: site(routes) });

    expect(result.previousCapturedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(result.signals.map((signal) => signal.kind)).toContain('hiring-down');
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toBe('ws_test');
    expect(inserts[0][2]).toBe('acme.test');
    expect(JSON.parse(inserts[0][4] as string).capturedAt).toBe('2026-07-27T12:00:00.000Z');
    expect(result.evidence.length).toBe(result.signals.length);
  });

  it('reports a first capture and still persists when nothing is stored', async () => {
    const { db, inserts } = fakeDb(null);
    const ctx: SkillContext = { db, workspaceId: 'ws_test', now: () => clock };
    const result = await watchSignals('acme.test', ctx, { fetchImpl: site(routes) });

    expect(result.previousCapturedAt).toBeNull();
    expect(result.signals.map((signal) => signal.kind)).toEqual(['first-capture']);
    expect(inserts).toHaveLength(1);
  });
});
