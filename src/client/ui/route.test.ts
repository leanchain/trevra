import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppPath, isLoginPath, parseRoute } from './route';

/* --------------------------------------------------------------------------
 * The route is the path, and it STAYS the path.
 * -------------------------------------------------------------------------- */

describe('parseRoute', () => {
  it('reads live screens and deep links off the pathname', () => {
    expect(parseRoute('/outreach/inbox')).toMatchObject({
      section: 'outreach',
      sub: 'inbox',
      id: null,
      path: '/outreach/inbox'
    });
    expect(parseRoute('/outreach/posts')).toMatchObject({
      section: 'outreach',
      sub: 'posts',
      id: null,
      path: '/outreach/posts'
    });
    expect(parseRoute('/outreach/campaign/licmp_123')).toMatchObject({
      section: 'outreach',
      sub: 'campaign',
      id: 'licmp_123',
      path: '/outreach/campaign/licmp_123'
    });
    expect(parseRoute('/outreach/workflow/liwf_123/licmp_123')).toMatchObject({
      section: 'outreach',
      sub: 'workflow',
      id: 'liwf_123/licmp_123',
      path: '/outreach/workflow/liwf_123/licmp_123'
    });
    expect(parseRoute('/ledger/run/run_abc')).toMatchObject({
      section: 'ledger',
      sub: 'run',
      id: 'run_abc',
      path: '/ledger/run/run_abc'
    });
    expect(parseRoute('/setup/team/inv_1')).toMatchObject({
      section: 'setup',
      sub: 'team',
      id: 'inv_1',
      path: '/setup/team/inv_1'
    });
  });

  it('answers the default route for the site root', () => {
    expect(parseRoute('/')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
    expect(parseRoute('')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
  });

  it('falls back internally when handed a removed or unknown sub-screen', () => {
    for (const path of [
      '/outreach/activity',
      '/outreach/accounts',
      '/outreach/campaigns',
      '/outreach/leads',
      '/outreach/manager',
      '/outreach/plan',
      '/outreach/replies',
      '/outreach/settings'
    ]) {
      expect(parseRoute(path), path).toMatchObject({
        section: 'outreach',
        sub: '',
        path: '/outreach'
      });
    }
    for (const path of [
      '/setup/agent',
      '/setup/data',
      '/setup/limits',
      '/setup/reddit',
      '/setup/research',
      '/setup/seat',
      '/setup/skills',
      '/setup/spend',
      '/setup/team'
    ]) {
      expect(parseRoute(path), path).toMatchObject({ section: 'setup', sub: '', path: '/setup' });
    }
  });

  it('sends an unknown section to the default rather than rendering nothing', () => {
    expect(parseRoute('/nope/nope')).toMatchObject({ section: 'loop', sub: '', path: '/loop' });
  });

  it('refuses a run link that names no run', () => {
    expect(parseRoute('/ledger/run')).toMatchObject({
      section: 'ledger',
      sub: '',
      path: '/ledger'
    });
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('/outreach/inbox/').path).toBe('/outreach/inbox');
  });

  it('parses the three setup tabs', () => {
    expect(parseRoute('/setup').sub).toBe('');
    expect(parseRoute('/setup/workspace')).toEqual({
      section: 'setup',
      sub: 'workspace',
      id: null,
      path: '/setup/workspace'
    });
    expect(parseRoute('/setup/capture')).toEqual({
      section: 'setup',
      sub: 'capture',
      id: null,
      path: '/setup/capture'
    });
  });
});

describe('isAppPath', () => {
  it('claims every live shell route', () => {
    for (const path of [
      '/',
      '/login',
      '/loop',
      '/loop/cost',
      '/outreach',
      '/outreach/new',
      '/outreach/inbound',
      '/outreach/inbox',
      '/outreach/opportunities',
      '/outreach/posts',
      '/outreach/campaign/licmp_1',
      '/outreach/workflow/liwf_1',
      '/outreach/workflow/liwf_1/licmp_1',
      '/ledger',
      '/ledger/run/run_1',
      '/research',
      '/setup',
      '/setup/workspace',
      '/setup/capture',
      '/setup/team/inv_1'
    ]) {
      expect(isAppPath(path), path).toBe(true);
    }
  });

  it('does not claim removed redirect-only routes', () => {
    for (const path of [
      '/leads',
      '/outreach/accounts',
      '/outreach/activity',
      '/outreach/campaigns',
      '/outreach/leads',
      '/outreach/manager',
      '/outreach/manager/new',
      '/outreach/plan',
      '/outreach/settings',
      '/setup/agent',
      '/setup/data',
      '/setup/limits',
      '/setup/reddit',
      '/setup/research',
      '/setup/seat',
      '/setup/skills',
      '/setup/spend',
      '/setup/team'
    ]) {
      expect(isAppPath(path), path).toBe(false);
    }
  });

  it('leaves shipped documents, files and API routes to the server', () => {
    for (const path of [
      '/money',
      '/privacy',
      '/terms',
      '/security',
      '/catalog/modules.json',
      '/logo.svg',
      '/robots.txt',
      '/api/dashboard'
    ]) {
      expect(isAppPath(path), path).toBe(false);
    }
  });

  it('recognizes the login address', () => {
    expect(isLoginPath('/login')).toBe(true);
    expect(isLoginPath('/setup')).toBe(false);
  });
});

/* --------------------------------------------------------------------------
 * The guard.
 * -------------------------------------------------------------------------- */

const CLIENT_DIR = new URL('..', import.meta.url).pathname;

function clientSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      clientSources(full, found);
      continue;
    }
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
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
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
