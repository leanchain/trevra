import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectMarketingHead, inlineScriptHashes } from './marketing-head.js';
import { SITE_DESCRIPTION, SITE_TITLE, SOCIAL_IMAGE } from './site-metadata.js';

// og:description is deliberately wrapped one-attribute-per-line, the way
// Prettier wraps any tag whose copy runs past printWidth in the real file.
const TEMPLATE = `<!doctype html><html><head>
<title>stale title</title>
<meta name="description" content="stale description" />
<link rel="canonical" href="https://usetrevra.com/" />
<meta property="og:url" content="https://usetrevra.com/" />
<meta property="og:image" content="https://usetrevra.com/og/trevra-social.png" />
<meta property="og:title" content="stale title" />
<meta
  property="og:description"
  content="stale description"
/>
<meta property="og:image:alt" content="stale alt" />
<meta name="twitter:title" content="stale title" />
<meta name="twitter:description" content="stale description" />
<!-- TREVRA_VERIFICATION -->
<!-- TREVRA_JSON_LD -->
</head><body><div id="root"></div></body></html>`;

const INJECT = {
  origin: 'https://preview.usetrevra.com',
  verification: '',
  jsonLd: {}
};

describe('injectMarketingHead', () => {
  it('fills both markers and rewrites the hardcoded production origin everywhere it appears', () => {
    const html = injectMarketingHead(TEMPLATE, {
      origin: 'https://preview.usetrevra.com',
      verification: '<meta name="google-site-verification" content="abc" />',
      jsonLd: { '@type': 'WebSite' }
    });
    expect(html).not.toContain('TREVRA_VERIFICATION');
    expect(html).not.toContain('TREVRA_JSON_LD');
    expect(html).toContain('href="https://preview.usetrevra.com/"');
    expect(html).toContain('content="https://preview.usetrevra.com/"');
    expect(html).toContain('content="https://preview.usetrevra.com/og/trevra-social.png"');
    expect(html).not.toContain('https://usetrevra.com');
    expect(html).toContain('<meta name="google-site-verification" content="abc" />');
    expect(html).toContain('<script type="application/ld+json">{"@type":"WebSite"}</script>');
  });

  it('escapes < inside the serialized JSON-LD so the script cannot be closed early', () => {
    const html = injectMarketingHead(TEMPLATE, {
      origin: 'https://usetrevra.com',
      verification: '',
      jsonLd: { name: '</script><script>alert(1)</script>' }
    });
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
  });

  it('leaves verification empty when none is configured', () => {
    const html = injectMarketingHead(TEMPLATE, {
      origin: 'https://usetrevra.com',
      verification: '',
      jsonLd: {}
    });
    expect(html).not.toMatch(/google-site-verification|msvalidate/);
  });

  it('throws when the verification marker is missing', () => {
    const missing = TEMPLATE.replace('<!-- TREVRA_VERIFICATION -->', '');
    expect(() =>
      injectMarketingHead(missing, {
        origin: 'https://usetrevra.com',
        verification: '',
        jsonLd: {}
      })
    ).toThrow(/TREVRA_VERIFICATION/);
  });

  it('throws when the json-ld marker is missing', () => {
    const missing = TEMPLATE.replace('<!-- TREVRA_JSON_LD -->', '');
    expect(() =>
      injectMarketingHead(missing, {
        origin: 'https://usetrevra.com',
        verification: '',
        jsonLd: {}
      })
    ).toThrow(/TREVRA_JSON_LD/);
  });
});

/**
 * index.html hardcodes the title and description in six places and the social
 * image's alt text in a seventh. Nothing bound them to the shared constants,
 * so changing SITE_TITLE shipped the old title in the head next to the new one
 * inside the JSON-LD -- with the whole suite green.
 */
describe('injectMarketingHead head copy', () => {
  it('rewrites every title, description and image-alt tag from the shared constants', () => {
    const html = injectMarketingHead(TEMPLATE, INJECT);
    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${SITE_DESCRIPTION}" />`);
    expect(html).toContain(`<meta property="og:title" content="${SITE_TITLE}" />`);
    expect(html).toContain(`<meta property="og:description" content="${SITE_DESCRIPTION}" />`);
    expect(html).toContain(`<meta property="og:image:alt" content="${SOCIAL_IMAGE.alt}" />`);
    expect(html).toContain(`<meta name="twitter:title" content="${SITE_TITLE}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${SITE_DESCRIPTION}" />`);
    expect(html).not.toContain('stale');
  });

  it.each([
    ['<title>', '<title>stale title</title>'],
    ['og:title', '<meta property="og:title" content="stale title" />'],
    ['twitter:description', '<meta name="twitter:description" content="stale description" />']
  ])('throws rather than silently skipping a missing %s tag', (label, tag) => {
    expect(() => injectMarketingHead(TEMPLATE.replace(tag, ''), INJECT)).toThrow(
      new RegExp(label.replace(/[<>]/g, ''))
    );
  });

  /**
   * The real file, not a fixture: these patterns have to survive however
   * Prettier has wrapped the shipped index.html at the current copy length.
   */
  it('rewrites the shipped index.html on disk, however Prettier wrapped it', async () => {
    const html = await readFile(resolve('index.html'), 'utf8');
    const injected = injectMarketingHead(html, {
      origin: 'https://preview.example',
      verification: '',
      jsonLd: {}
    });
    expect(injected).toContain(`<title>${SITE_TITLE}</title>`);
    expect(injected).toContain(`<meta name="description" content="${SITE_DESCRIPTION}" />`);
    expect(injected).toContain(`<meta property="og:title" content="${SITE_TITLE}" />`);
    expect(injected).toContain(`<meta property="og:description" content="${SITE_DESCRIPTION}" />`);
    expect(injected).toContain(`<meta property="og:image:alt" content="${SOCIAL_IMAGE.alt}" />`);
    expect(injected).toContain(`<meta name="twitter:title" content="${SITE_TITLE}" />`);
    expect(injected).toContain(`<meta name="twitter:description" content="${SITE_DESCRIPTION}" />`);
    expect(injected).not.toContain('https://usetrevra.com');
  });
});

describe('inlineScriptHashes', () => {
  it('hashes inline scripts and ignores ones with a src attribute', () => {
    const html =
      '<script src="/theme.js"></script><script type="application/ld+json">{"a":1}</script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it('matches a hash independently computed from the exact byte content', () => {
    const content = '{"a":1}';
    const html = `<script type="application/ld+json">${content}</script>`;
    const expected = `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`;
    expect(inlineScriptHashes(html)).toEqual([expected]);
  });

  it('returns one hash per inline script, in document order', () => {
    const html = '<script>a()</script><script>b()</script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toEqual(hashes[1]);
  });

  it('returns an empty array when there are no inline scripts', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script>')).toEqual([]);
  });
});
