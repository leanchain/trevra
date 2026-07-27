import { describe, expect, it } from 'vitest';
import {
  extractJsonLd,
  extractLinks,
  extractMailtos,
  firstHeading,
  jsonLdTypes,
  metaContent,
  pageTitle,
  parseRobots,
  robotsAllows,
  sameOriginPath,
  socialProfile,
  stripTags
} from './html.js';

describe('JSON-LD extraction', () => {
  it('flattens arrays and @graph containers into one list', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [{ '@type': 'Organization', name: 'Acme' }, { '@type': 'WebSite' }]
    })}</script><script type="application/ld+json">${JSON.stringify([{ '@type': 'Product', name: 'Shoe' }])}</script>`;
    expect([...jsonLdTypes(extractJsonLd(html))].sort()).toEqual(['Organization', 'Product', 'WebSite']);
  });

  it('skips a malformed block instead of throwing', () => {
    const html = '<script type="application/ld+json">{ nope </script><script type="application/ld+json">{"@type":"Organization"}</script>';
    expect(extractJsonLd(html)).toHaveLength(1);
  });
});

describe('meta and heading readers', () => {
  const html = '<title>  Acme &amp; Co  </title><meta name="description" content="Shoes."><meta property="og:title" content="Acme"><h1>Run <em>faster</em> &amp; further</h1>';

  it('reads title and meta content', () => {
    expect(metaContent(html, 'name', 'description')).toBe('Shoes.');
    expect(metaContent(html, 'property', 'og:title')).toBe('Acme');
    expect(metaContent(html, 'name', 'missing')).toBeNull();
  });

  it('leaves entities encoded in the title, because the audit measures its length', () => {
    // Decoding here would move a store across the meta-quality size threshold
    // in audit.ts without anything about that store changing.
    expect(pageTitle(html)).toBe('Acme &amp; Co');
  });

  it('reads the first h1 as visible, decoded text', () => {
    expect(firstHeading(html)).toBe('Run faster & further');
  });

  it('strips scripts, styles, and comments from visible text', () => {
    expect(stripTags('<style>a{}</style><p>Hi</p><!-- x --><script>var a=1</script>')).toBe('Hi');
  });
});

describe('links and mailto addresses', () => {
  it('reads href and visible text', () => {
    expect(extractLinks('<a href="/about" class="x">About <b>us</b></a>')).toEqual([{ href: '/about', text: 'About us' }]);
  });

  it('takes mailto addresses only, never bare text that looks like one', () => {
    const html = '<a href="mailto:Hello@Acme.test?subject=Hi">write</a><p>press@acme.test</p><a href="/x">x</a>';
    expect(extractMailtos(html)).toEqual(['hello@acme.test']);
  });

  it('decodes an obfuscated mailto href', () => {
    expect(extractMailtos('<a href="mailto:info&#64;acme.test">mail</a>')).toEqual(['info@acme.test']);
  });
});

describe('socialProfile', () => {
  it('reads a handle past a container segment', () => {
    expect(socialProfile('https://www.linkedin.com/company/acme/')).toEqual({
      platform: 'linkedin',
      handle: 'acme',
      url: 'https://www.linkedin.com/company/acme'
    });
  });

  it('strips a leading @ and resolves a relative href against the page', () => {
    expect(socialProfile('https://youtube.com/@acmetv')?.handle).toBe('acmetv');
    expect(socialProfile('//x.com/acme', 'https://acme.test/')?.platform).toBe('x');
  });

  it('rejects a bare network homepage, because it names no account', () => {
    expect(socialProfile('https://facebook.com/')).toBeNull();
    expect(socialProfile('https://acme.test/about')).toBeNull();
    expect(socialProfile('mailto:a@b.test')).toBeNull();
  });
});

describe('sameOriginPath', () => {
  const base = new URL('https://acme.test');

  it('keeps same-origin paths and drops query and trailing slash', () => {
    expect(sameOriginPath(base, '/contact/?ref=nav')).toBe('/contact');
    expect(sameOriginPath(base, 'https://acme.test/team')).toBe('/team');
    expect(sameOriginPath(base, '/')).toBe('/');
  });

  it('refuses anything off-origin or non-http', () => {
    expect(sameOriginPath(base, 'https://other.test/contact')).toBeNull();
    expect(sameOriginPath(base, 'https://sub.acme.test/contact')).toBeNull();
    expect(sameOriginPath(base, 'javascript:alert(1)')).toBeNull();
  });
});

describe('robotsAllows', () => {
  it('lets the longest matching rule win, with allow breaking a tie', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /contact\n');
    expect(robotsAllows(rules, 'TrevraGrowthBot', '/contact')).toBe(true);
    expect(robotsAllows(rules, 'TrevraGrowthBot', '/about')).toBe(false);
  });

  it('prefers a group naming the agent over the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: TrevraGrowthBot\nAllow: /\n');
    expect(robotsAllows(rules, 'TrevraGrowthBot', '/team')).toBe(true);
    expect(robotsAllows(rules, 'SomeoneElse', '/team')).toBe(false);
  });

  it('treats an empty Disallow and a missing group as no restriction', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), 'TrevraGrowthBot', '/contact')).toBe(true);
    expect(robotsAllows(parseRobots(''), 'TrevraGrowthBot', '/contact')).toBe(true);
  });

  it('honours * and $ in a pattern', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/x\n');
    expect(robotsAllows(rules, 'bot', '/a.pdf')).toBe(false);
    expect(robotsAllows(rules, 'bot', '/a.pdf.html')).toBe(true);
    expect(robotsAllows(rules, 'bot', '/private-42/x')).toBe(false);
  });
});
