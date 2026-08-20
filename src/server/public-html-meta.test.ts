import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every hand-edited `public/**\/index.html` document -- privacy, terms,
 * security, how-it-works, and whatever is added after them -- ships the same
 * head contract: a title, a description, a canonical link, OG/Twitter
 * preview tags, and a parseable `WebPage` JSON-LD block.
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

describe('public/**/index.html head contract', () => {
  it('ships a title, description, canonical, OG/Twitter tags, and JSON-LD on every page', async () => {
    const files = await findIndexHtmlFiles('public');
    // Guards the guard: a glob that silently matched nothing would pass
    // every assertion below for the wrong reason.
    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const html = await readFile(file, 'utf8');

      expect(html, file).toMatch(/<title>[^<]+<\/title>/);
      expect(html, file).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
      expect(html, file).toMatch(/<link\s+rel="canonical"\s+href="[^"]+"/);
      expect(html, file).toMatch(/<meta\s+property="og:title"\s+content="[^"]+"/);
      expect(html, file).toMatch(/<meta\s+property="og:image"\s+content="[^"]+"/);
      expect(html, file).toMatch(/<meta\s+name="twitter:card"\s+content="summary_large_image"/);

      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(jsonLdMatch, file).not.toBeNull();
      expect(() => JSON.parse(jsonLdMatch![1]), file).not.toThrow();
      const jsonLd = JSON.parse(jsonLdMatch![1]);
      expect(jsonLd, file).toHaveProperty('@type');
    }
  });
});
