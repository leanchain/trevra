import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every hand-edited `public/**\/index.html` document -- privacy, terms,
 * security, how-it-works, and whatever is added after them -- ships the same
 * head contract: a title, a description, a canonical link, OG/Twitter
 * preview tags that repeat exactly those two strings, and a `WebPage` JSON-LD
 * block whose `@id` is the page's own.
 *
 * Non-empty is not the contract. These documents are copy-pasted from each
 * other, and the failure that actually happens is a paste that keeps the
 * previous page's title, canonical, or og:description -- every one of which
 * passes a "tag exists" check.
 *
 * This is a plain fs/vitest test, not a server test: it needs no Express app
 * and no database, so it runs under bare `vitest run`, unlike
 * public-site.test.tsx (which needs scripts/test-with-postgres.ts).
 *
 * What stops the next hand-edited page from shipping bare, the way /security
 * and /privacy did before this head shape existed.
 */
async function findIndexHtmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === 'index.html')
    .map((entry) => join(entry.parentPath ?? dir, entry.name))
    .sort();
}

/** The single capture of `pattern` in `html`, asserted to be there at all. */
function capture(html: string, pattern: RegExp, file: string): string {
  const match = html.match(pattern);
  expect(match, `${file}: ${pattern}`).not.toBeNull();
  return match![1];
}

/** `public/privacy/index.html` -> `/privacy`, the path the page is served at. */
function servedPath(file: string): string {
  const dir = dirname(file).replace(/^public/, '');
  return dir === '' ? '/' : dir;
}

describe('public/**/index.html head contract', () => {
  it('ships one title and one description, repeated exactly across OG and Twitter', async () => {
    const files = await findIndexHtmlFiles('public');
    // Guards the guard: a glob that silently matched nothing would pass
    // every assertion below for the wrong reason.
    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const html = await readFile(file, 'utf8');

      const title = capture(html, /<title>([^<]+)<\/title>/, file);
      const description = capture(html, /<meta\s+name="description"\s+content="([^"]+)"/, file);

      expect(capture(html, /<meta\s+property="og:title"\s+content="([^"]+)"/, file), file).toBe(
        title
      );
      expect(capture(html, /<meta\s+name="twitter:title"\s+content="([^"]+)"/, file), file).toBe(
        title
      );
      expect(
        capture(html, /<meta\s+property="og:description"\s+content="([^"]+)"/, file),
        file
      ).toBe(description);
      expect(
        capture(html, /<meta\s+name="twitter:description"\s+content="([^"]+)"/, file),
        file
      ).toBe(description);

      expect(html, file).toMatch(/<meta\s+property="og:image"\s+content="[^"]+"/);
      expect(html, file).toMatch(/<meta\s+name="twitter:card"\s+content="summary_large_image"/);

      // The paste that keeps the previous page's canonical is the failure this
      // catches: /terms claiming to be the canonical URL of /privacy.
      const canonical = capture(html, /<link\s+rel="canonical"\s+href="([^"]+)"/, file);
      expect(
        canonical.endsWith(servedPath(file)),
        `${file}: canonical ${canonical} is not ${servedPath(file)}`
      ).toBe(true);
      expect(capture(html, /<meta\s+property="og:url"\s+content="([^"]+)"/, file), file).toBe(
        canonical
      );

      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(jsonLdMatch, file).not.toBeNull();
      expect(() => JSON.parse(jsonLdMatch![1]), file).not.toThrow();
      const jsonLd = JSON.parse(jsonLdMatch![1]);
      expect(jsonLd['@type'], file).toBe('WebPage');
      // Addressable, not anonymous: the node has to name the page it describes.
      expect(jsonLd['@id'], file).toBe(`${canonical}/#webpage`);
      expect(jsonLd.url, file).toBe(canonical);
      expect(jsonLd.name, file).toBe(title);
      expect(jsonLd.description, file).toBe(description);
    }
  });
});
