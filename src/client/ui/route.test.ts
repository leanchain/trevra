import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAccountsPath, isAppPath, isLoginPath, parseRoute } from './route';

/* --------------------------------------------------------------------------
 * The route is the path, and it STAYS the path.
 *
 * The second describe block is not a unit test in the usual sense -- it is the
 * guard on a decision that kept being reverted. Hash routing is what an SPA
 * reaches for when nobody has told it the server will answer real URLs, so an
 * agent reading this codebase cold will reach for it again. It now fails the
 * suite instead of shipping.
 * -------------------------------------------------------------------------- */

describe('parseRoute', () => {
  it('reads a section, a sub-screen and a deep-link id off the pathname', () => {
    expect(parseRoute('/outreach/inbox')).toMatchObject({ section: 'outreach', sub: 'inbox', id: null, path: '/outreach/inbox' });
    expect(parseRoute('/ledger/run/run_abc')).toMatchObject({ section: 'ledger', sub: 'run', id: 'run_abc', path: '/ledger/run/run_abc' });
  });

  it('answers the default route for the site root', () => {
    expect(parseRoute('/')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
    expect(parseRoute('')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
  });

  it('falls back to the section root for a sub-screen that does not exist', () => {
    expect(parseRoute('/outreach/replies')).toMatchObject({ section: 'outreach', sub: '', path: '/outreach' });
  });

  it('sends an unknown section to the default rather than rendering nothing', () => {
    expect(parseRoute('/nope/nope')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
  });

  it('refuses a run link that names no run', () => {
    expect(parseRoute('/ledger/run')).toMatchObject({ section: 'ledger', sub: '', path: '/ledger' });
  });

  it('ignores a trailing slash, so a pasted URL and a typed one are one screen', () => {
    expect(parseRoute('/outreach/inbox/').path).toBe('/outreach/inbox');
  });

  /**
   * A hash-route URL is NOT read back. See ui/route.ts's header: honouring it
   * would keep alive the ambiguity this change exists to remove.
   */
  it('does not honour an old hash-route URL', () => {
    expect(parseRoute('/').path).toBe('/loop');
  });
});

describe('isAppPath', () => {
  it('claims every section and shell path', () => {
    for (const path of ['/loop', '/outreach/inbox', '/money', '/ledger/run/x', '/setup/team', '/leads', '/login', '/']) {
      expect(isAppPath(path), path).toBe(true);
    }
  });

  /**
   * MUST STAY IN STEP WITH `APP_PATH_HEADS` in src/server/index.ts. A path the
   * client claims and the server 404s is a broken reload.
   */
  it('leaves shipped documents, files and API routes to the server', () => {
    for (const path of ['/privacy', '/terms', '/security', '/catalog/modules.json', '/logo.svg', '/robots.txt', '/api/dashboard']) {
      expect(isAppPath(path), path).toBe(false);
    }
  });

  it('names the two shell paths that are not sections', () => {
    expect(isLoginPath('/login')).toBe(true);
    expect(isLoginPath('/setup')).toBe(false);
    expect(isAccountsPath('/leads')).toBe(true);
    expect(isAccountsPath('/leads/acc_1')).toBe(true);
    expect(isAccountsPath('/loop')).toBe(false);
  });
});

/* --------------------------------------------------------------------------
 * The guard.
 * -------------------------------------------------------------------------- */

const CLIENT_DIR = new URL('..', import.meta.url).pathname;

function clientSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { clientSources(full, found); continue; }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * `path:line` for every line of CODE in every client source matching
 * `pattern`.
 *
 * COMMENT LINES ARE SKIPPED, and they have to be: ui/route.ts's own header
 * explains what hash routing was and why it is gone, which means writing
 * `#/outreach/inbox` down. A guard that cannot tell an explanation from an
 * instance is a guard that forbids explaining itself, and the first person to
 * hit it deletes the paragraph rather than the routing. Prose does not route.
 */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of clientSources(CLIENT_DIR)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      if (pattern.test(line)) hits.push(`${file.slice(CLIENT_DIR.length)}:${index + 1}: ${code}`);
    });
  }
  return hits;
}

describe('no screen is addressed by a hash', () => {
  /**
   * `#/anything` in a client source is a hash route, whatever it is doing.
   * Routes are paths -- `href="/outreach/inbox"` -- and the click interceptor
   * in ui/route.ts keeps them from reloading the page.
   */
  it('has no `#/` route literal anywhere in src/client', () => {
    expect(offenders(/#\//)).toEqual([]);
  });

  /**
   * The fragment belongs to the marketing page's anchors and to nothing else.
   * `ui/route.ts` itself never touches it, and no other client file may read
   * or write it: a screen that decides anything from `location.hash` is a
   * screen addressed by a hash, which is the thing this suite forbids.
   */
  it('reads or writes location.hash nowhere in src/client', () => {
    expect(offenders(/\blocation\s*\.\s*hash\b|\bhashchange\b/)).toEqual([]);
  });
});
