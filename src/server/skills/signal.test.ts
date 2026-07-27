import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { captureSnapshot, contentHash, diffSnapshots, extractJobPostings, watchSignals, type ResearchSnapshot } from './signal.js';
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
    expect(signals[2].detail).toContain('"Shipping software faster" to "The revenue platform for operators"');
    expect(signals[3].detail).toContain('added segment');
    expect(signals[4].detail).toContain('dropped hubspot');
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
    expect(diffSnapshots(BEFORE, { ...BEFORE, capturedAt: '2026-07-01T00:00:00.000Z' })).toEqual([]);
  });

  it('never diffs a field that was not captured', () => {
    // The careers page timed out this run. "3 roles -> 0 roles" would be an
    // urgent-looking signal invented by a flaky fetch.
    const missed: ResearchSnapshot = { ...AFTER, jobCount: null, jobTitles: [], pricingHash: null, headline: null, tech: null };
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
    expect(extractJobPostings(html, 'https://acme.test/careers')).toEqual(['Backend Engineer', 'Head of RevOps', 'Sales Engineer']);
  });
});

describe('contentHash', () => {
  it('hashes visible text, so a changed build id is not a pricing change', () => {
    const a = '<html><script src="/_next/static/abc123/main.js"></script><body><h2>29 EUR</h2></body></html>';
    const b = '<html><script src="/_next/static/zzz999/main.js"></script><body><h2>29 EUR</h2></body></html>';
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(a.replace('29', '39')));
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

  it('captures every watched field, following the site\'s own links', async () => {
    const snapshot = await captureSnapshot('acme.test', { fetchImpl: site(routes), now: new Date('2026-07-27T00:00:00.000Z') });

    expect(snapshot.domain).toBe('acme.test');
    expect(snapshot.capturedAt).toBe('2026-07-27T00:00:00.000Z');
    expect(snapshot.headline).toBe('The revenue platform');
    expect(snapshot.jobsUrl).toBe('https://acme.test/company/open-roles');
    expect(snapshot.jobCount).toBe(1);
    expect(snapshot.jobTitles).toEqual(['Head of RevOps']);
    expect(snapshot.pricingUrl).toBe('https://acme.test/pricing');
    expect(snapshot.pricingHash).toHaveLength(16);
    expect(snapshot.tech).toEqual(['segment']);
  });

  it('captures only what was asked for, leaving the rest uncaptured', async () => {
    const snapshot = await captureSnapshot('acme.test', { watch: ['headline'], fetchImpl: site(routes) });
    expect(snapshot.headline).toBe('The revenue platform');
    expect(snapshot.jobCount).toBeNull();
    expect(snapshot.pricingHash).toBeNull();
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
    expect(snapshot.headline).toBeNull();
    expect(snapshot.tech).toBeNull();
  });

  it('rejects a non-public host before any probe runs', async () => {
    await expect(captureSnapshot('localhost', { fetchImpl: site({}) })).rejects.toThrow('localhost not allowed');
  });
});

describe('gtm.watch-signal persistence', () => {
  /** Minimal `Db` stand-in: records the insert, replays one stored snapshot. */
  function fakeDb(stored: ResearchSnapshot | null): { db: Db; inserts: unknown[][] } {
    const inserts: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          get: async () => (sql.includes('SELECT') && stored ? { snapshot_json: stored } : undefined),
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
