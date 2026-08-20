import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { injectMarketingHead, inlineScriptHashes } from './marketing-head.js';

const TEMPLATE = `<!doctype html><html><head>
<link rel="canonical" href="https://usetrevra.com/" />
<meta property="og:url" content="https://usetrevra.com/" />
<meta property="og:image" content="https://usetrevra.com/og/trevra-social.png" />
<!-- TREVRA_VERIFICATION -->
<!-- TREVRA_JSON_LD -->
</head><body><div id="root"></div></body></html>`;

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
