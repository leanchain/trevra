import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import type { FetchLike } from '../skills/guard.js';
import {
  DEFAULT_SWEEP_ACCOUNTS,
  HARD_MAX_SWEEP_ACCOUNTS,
  SWEEP_GAP_SECONDS,
  SWEEP_INTERVAL_HOURS,
  claimDueAccounts,
  nextSweepAt,
  recordSignals,
  runAccountSweep,
  signalFingerprint,
  sweepAccount,
  sweepBackoffHours,
  sweepGapSeconds
} from './sweep.js';
import type { Account } from './types.js';

/**
 * NO NETWORK, NO CLOCK, NO TIMER. Every fetch is a hand-written page, every
 * `now` is injected, and `sleep` is a recorder -- so "the sweep paces itself"
 * is asserted rather than waited for.
 *
 * What is proved here is the four rules `sweep.ts` is built on: the same event
 * seen twice is one row, a signal without a link is not stored at all, two
 * workers cannot claim the same account, and a dead host is a recorded error
 * rather than a crashed cycle.
 */

let db: Db;

const WORKSPACE_ID = 'ws_accounts_sweep_test';
const T0 = new Date('2026-08-06T09:00:00.000Z');
const HOUR = 3_600_000;

function at(hours: number): Date {
  return new Date(T0.getTime() + hours * HOUR);
}

/* --------------------------------------------------------------------------
 * A site made of strings.
 * ----------------------------------------------------------------------- */

function site(pages: Record<string, string>): FetchLike {
  return async (url: string) => {
    const body = pages[new URL(url).pathname];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
}

function home(headline: string): string {
  return `<html><head><title>Acme</title></head><body><h1>${headline}</h1>
    <a href="/careers">Careers</a><a href="/pricing">Pricing</a></body></html>`;
}

function careers(roles: readonly string[]): string {
  const links = roles.map((role) => `<a href="/careers/${role.toLowerCase().replaceAll(' ', '-')}">${role}</a>`).join('');
  return `<html><body><h1>Open roles</h1>${links}</body></html>`;
}

function pricing(price: string): string {
  return `<html><body><h2>${price} EUR</h2></body></html>`;
}

/** The whole site is gone. Every path 404s. */
const deadSite: FetchLike = async () => new Response('gone', { status: 404 });

/* --------------------------------------------------------------------------
 * Rows.
 * ----------------------------------------------------------------------- */

async function makeAccount(
  overrides: { domain?: string; status?: string; nextSweepAt?: string | null; createdAt?: string } = {}
): Promise<string> {
  const accountId = id('acct');
  const createdAt = overrides.createdAt ?? T0.toISOString();
  await db.prepare(`
    INSERT INTO accounts (id, workspace_id, name, domain, source, tags, status, next_sweep_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?::text[],?,?,?,?)
  `).run(
    accountId,
    WORKSPACE_ID,
    overrides.domain ?? 'acme.test',
    overrides.domain ?? 'acme.test',
    'csv',
    [],
    overrides.status ?? 'active',
    overrides.nextSweepAt ?? null,
    createdAt,
    createdAt
  );
  return accountId;
}

async function loadAccount(accountId: string): Promise<Account> {
  const [claimed] = await claimDueAccounts(db, WORKSPACE_ID, new Date('2100-01-01T00:00:00.000Z'), 100);
  if (claimed && claimed.id === accountId) return claimed;
  throw new Error('loadAccount is only for single-account fixtures');
}

async function signalRows(accountId: string) {
  return db.prepare(`
    SELECT kind, detail, previous, current, evidence_url, fingerprint, observed_at
    FROM account_signals WHERE workspace_id=? AND account_id=? ORDER BY created_at ASC, id ASC
  `).all<{ kind: string; detail: string; previous: string | null; current: string | null; evidence_url: string; fingerprint: string; observed_at: string }>(
    WORKSPACE_ID,
    accountId
  );
}

async function bookkeeping(accountId: string) {
  const row = await db.prepare('SELECT last_swept_at, next_sweep_at, sweep_error FROM accounts WHERE id=?')
    .get<{ last_swept_at: string | null; next_sweep_at: string | null; sweep_error: string | null }>(accountId);
  if (!row) throw new Error('account vanished');
  return row;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Accounts Sweep Test', T0.toISOString());
  for (const table of ['account_signals', 'account_scores', 'accounts', 'research_snapshots']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE_ID);
  }
});

afterEach(async () => {
  await db?.close();
});

/* --------------------------------------------------------------------------
 * The dedupe key.
 * ----------------------------------------------------------------------- */

describe('signalFingerprint', () => {
  it('is stable: the same observed change hashes identically every time', () => {
    const once = signalFingerprint('hiring-up', '3', '5');
    expect(signalFingerprint('hiring-up', '3', '5')).toBe(once);
    expect(once).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates the kind and both values, so no two different events collide', () => {
    const base = signalFingerprint('hiring-up', '3', '5');
    expect(signalFingerprint('hiring-down', '3', '5')).not.toBe(base);
    expect(signalFingerprint('hiring-up', '5', '3')).not.toBe(base);
    // The classic collision a naive join would produce: ('a','bc') vs ('ab','c').
    expect(signalFingerprint('k', 'a', 'bc')).not.toBe(signalFingerprint('k', 'ab', 'c'));
  });

  it('treats "removed" and "now blank" as different observations', () => {
    expect(signalFingerprint('headline-changed', 'Old', null)).not.toBe(signalFingerprint('headline-changed', 'Old', ''));
  });
});

/* --------------------------------------------------------------------------
 * Storing.
 * ----------------------------------------------------------------------- */

describe('recordSignals', () => {
  it('returns only the rows it actually wrote, so a re-read of an unchanged page stores nothing', async () => {
    const accountId = await makeAccount();
    const incoming = [
      {
        kind: 'hiring-up',
        detail: 'Open roles went from 3 to 5.',
        previous: '3',
        current: '5',
        evidenceUrl: 'https://acme.test/careers'
      }
    ];

    const first = await recordSignals(db, WORKSPACE_ID, accountId, incoming, T0);
    expect(first).toHaveLength(1);
    expect(first[0].fingerprint).toBe(signalFingerprint('hiring-up', '3', '5'));

    // Tomorrow, and the day after: same page, same tuple, no new row.
    expect(await recordSignals(db, WORKSPACE_ID, accountId, incoming, at(24))).toEqual([]);
    expect(await recordSignals(db, WORKSPACE_ID, accountId, incoming, at(48))).toEqual([]);
    expect(await signalRows(accountId)).toHaveLength(1);
  });

  it('collapses a duplicate inside one batch too', async () => {
    const accountId = await makeAccount();
    const one = {
      kind: 'pricing-changed',
      detail: 'Pricing changed.',
      previous: 'aaaa',
      current: 'bbbb',
      evidenceUrl: 'https://acme.test/pricing'
    };
    expect(await recordSignals(db, WORKSPACE_ID, accountId, [one, { ...one }], T0)).toHaveLength(1);
  });

  it('DROPS a signal with no evidence URL rather than storing a blank one', async () => {
    const accountId = await makeAccount();
    const stored = await recordSignals(
      db,
      WORKSPACE_ID,
      accountId,
      [
        { kind: 'hiring-up', detail: 'No link.', previous: '3', current: '5', evidenceUrl: '' },
        { kind: 'headline-changed', detail: 'Whitespace is not a link.', previous: 'a', current: 'b', evidenceUrl: '   ' },
        { kind: 'pricing-changed', detail: 'Linked.', previous: 'x', current: 'y', evidenceUrl: 'https://acme.test/pricing' }
      ],
      T0
    );
    expect(stored.map((signal) => signal.kind)).toEqual(['pricing-changed']);
    // And the column never sees a blank -- which is the point of the NOT NULL.
    const rows = await signalRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence_url).toBe('https://acme.test/pricing');
  });

  it('carries the observation time, not the insert time', async () => {
    const accountId = await makeAccount();
    const [stored] = await recordSignals(
      db,
      WORKSPACE_ID,
      accountId,
      [{ kind: 'thread-mention', detail: 'Mentioned.', previous: null, current: 'x', evidenceUrl: 'https://news.test/1', observedAt: at(-72) }],
      T0
    );
    expect(new Date(stored.observedAt).toISOString()).toBe(at(-72).toISOString());
  });

  it('does nothing at all for an empty batch', async () => {
    expect(await recordSignals(db, WORKSPACE_ID, await makeAccount(), [], T0)).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * Claiming.
 * ----------------------------------------------------------------------- */

describe('claimDueAccounts', () => {
  it('skips accounts that are not due and accounts the operator took out of the sweep', async () => {
    const due = await makeAccount({ domain: 'due.test', createdAt: at(-3).toISOString() });
    await makeAccount({ domain: 'later.test', nextSweepAt: at(6).toISOString() });
    await makeAccount({ domain: 'rejected.test', status: 'not_a_fit' });
    await makeAccount({ domain: 'archived.test', status: 'archived' });

    const claimed = await claimDueAccounts(db, WORKSPACE_ID, T0, 25);
    expect(claimed.map((account) => account.id)).toEqual([due]);
  });

  it('takes the never-swept and the longest-overdue first', async () => {
    const oldest = await makeAccount({ domain: 'a.test', createdAt: at(-5).toISOString() });
    const newer = await makeAccount({ domain: 'b.test', createdAt: at(-1).toISOString() });
    const claimed = await claimDueAccounts(db, WORKSPACE_ID, T0, 25);
    expect(claimed.map((account) => account.id)).toEqual([oldest, newer]);
  });

  it('leases the row forward on claim, so a crash cannot hot-loop the same account', async () => {
    const accountId = await makeAccount();
    expect(await claimDueAccounts(db, WORKSPACE_ID, T0, 25)).toHaveLength(1);
    // A second worker one second later -- or this one after a crash -- finds nothing.
    expect(await claimDueAccounts(db, WORKSPACE_ID, new Date(T0.getTime() + 1_000), 25)).toEqual([]);
    // The lease is the first rung of the failure ladder: a crash retries in 2h.
    expect((await bookkeeping(accountId)).next_sweep_at).not.toBeNull();
    expect(await claimDueAccounts(db, WORKSPACE_ID, at(2), 25)).toHaveLength(1);
  });

  it('never claims more than the hard cap allows, however loudly it is asked', async () => {
    await makeAccount({ domain: 'a.test', createdAt: at(-3).toISOString() });
    await makeAccount({ domain: 'b.test', createdAt: at(-2).toISOString() });
    expect(await claimDueAccounts(db, WORKSPACE_ID, T0, 10_000)).toHaveLength(2);
    expect(HARD_MAX_SWEEP_ACCOUNTS).toBeGreaterThan(DEFAULT_SWEEP_ACCOUNTS);
  });

  it('claims nothing for a workspace with no accounts', async () => {
    expect(await claimDueAccounts(db, 'ws_nobody', T0, 25)).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * Sweeping one account.
 * ----------------------------------------------------------------------- */

describe('sweepAccount', () => {
  it('records the first capture with the page it was read from, and looks again tomorrow', async () => {
    const accountId = await makeAccount();
    const account = await loadAccount(accountId);
    const fetchImpl = site({
      '/': home('Shipping software faster'),
      '/careers': careers(['Backend Engineer']),
      '/pricing': pricing('29')
    });

    const outcome = await sweepAccount(db, account, { now: () => T0, fetchImpl });
    expect(outcome.error).toBeNull();
    expect(outcome.signals.map((signal) => signal.kind)).toEqual(['first-capture']);
    expect(outcome.signals[0].evidenceUrl).toBe('https://acme.test');

    const book = await bookkeeping(accountId);
    expect(book.sweep_error).toBeNull();
    expect(new Date(book.last_swept_at!).toISOString()).toBe(T0.toISOString());
    const gapHours = (new Date(book.next_sweep_at!).getTime() - T0.getTime()) / HOUR;
    expect(gapHours).toBeGreaterThan(SWEEP_INTERVAL_HOURS - 1);
    expect(gapHours).toBeLessThan(SWEEP_INTERVAL_HOURS + 1);
  });

  it('stores nothing on a re-sweep of an unchanged site', async () => {
    const accountId = await makeAccount();
    const pages = { '/': home('Shipping software faster'), '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') };

    await sweepAccount(db, await loadAccount(accountId), { now: () => T0, fetchImpl: site(pages) });
    const second = await sweepAccount(db, await loadAccount(accountId), { now: () => at(24), fetchImpl: site(pages) });

    expect(second.error).toBeNull();
    expect(second.signals).toEqual([]);
    expect(await signalRows(accountId)).toHaveLength(1);
  });

  it('emits exactly one new row when a page actually changes', async () => {
    const accountId = await makeAccount();
    const base = { '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') };

    await sweepAccount(db, await loadAccount(accountId), {
      now: () => T0,
      fetchImpl: site({ ...base, '/': home('Shipping software faster') })
    });
    const second = await sweepAccount(db, await loadAccount(accountId), {
      now: () => at(24),
      fetchImpl: site({ ...base, '/': home('The revenue platform for operators') })
    });

    expect(second.signals.map((signal) => signal.kind)).toEqual(['headline-changed']);
    expect(second.signals[0].previous).toBe('Shipping software faster');
    expect(second.signals[0].current).toBe('The revenue platform for operators');
    expect(await signalRows(accountId)).toHaveLength(2);
  });

  it('does not re-report a change it has already seen when a page flips back and forth', async () => {
    const accountId = await makeAccount();
    const base = { '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') };
    const A = 'Shipping software faster';
    const B = 'The revenue platform for operators';

    await sweepAccount(db, await loadAccount(accountId), { now: () => T0, fetchImpl: site({ ...base, '/': home(A) }) });
    const toB = await sweepAccount(db, await loadAccount(accountId), { now: () => at(24), fetchImpl: site({ ...base, '/': home(B) }) });
    const backToA = await sweepAccount(db, await loadAccount(accountId), { now: () => at(48), fetchImpl: site({ ...base, '/': home(A) }) });
    const toBAgain = await sweepAccount(db, await loadAccount(accountId), { now: () => at(72), fetchImpl: site({ ...base, '/': home(B) }) });

    expect(toB.signals).toHaveLength(1);
    // A -> B and B -> A are different events and both are news.
    expect(backToA.signals).toHaveLength(1);
    // A -> B a second time is the same event seen again, and is not.
    expect(toBAgain.signals).toEqual([]);
    expect(await signalRows(accountId)).toHaveLength(3);
  });

  it('names the careers page as the evidence for a hiring move', async () => {
    const accountId = await makeAccount();
    await sweepAccount(db, await loadAccount(accountId), {
      now: () => T0,
      fetchImpl: site({ '/': home('Acme'), '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') })
    });
    const second = await sweepAccount(db, await loadAccount(accountId), {
      now: () => at(24),
      fetchImpl: site({ '/': home('Acme'), '/careers': careers(['Backend Engineer', 'Head of RevOps']), '/pricing': pricing('29') })
    });
    expect(second.signals.map((signal) => signal.kind)).toEqual(['hiring-up']);
    expect(second.signals[0].evidenceUrl).toBe('https://acme.test/careers');
    expect(second.signals[0].detail).toContain('Head of RevOps');
  });

  it('records a dead host as a sweep_error instead of throwing, and backs off 2h, 6h, then a day', async () => {
    const accountId = await makeAccount();

    const first = await sweepAccount(db, await loadAccount(accountId), { now: () => T0, fetchImpl: deadSite });
    expect(first.error).toContain('acme.test');
    expect(first.signals).toEqual([]);
    expect(await signalRows(accountId)).toEqual([]);
    let book = await bookkeeping(accountId);
    expect(book.sweep_error).toBe(first.error);
    expect(new Date(book.next_sweep_at!).getTime() - T0.getTime()).toBe(2 * HOUR);

    // Second failure: we waited the 2h rung, so the next wait is 6h.
    const second = await sweepAccount(db, (await claimDueAccounts(db, WORKSPACE_ID, at(2), 1))[0], { now: () => at(2), fetchImpl: deadSite });
    expect(second.error).not.toBeNull();
    book = await bookkeeping(accountId);
    expect(new Date(book.next_sweep_at!).getTime() - at(2).getTime()).toBe(6 * HOUR);

    // Third: 6h was waited, so it is a day from here on.
    await sweepAccount(db, (await claimDueAccounts(db, WORKSPACE_ID, at(8), 1))[0], { now: () => at(8), fetchImpl: deadSite });
    book = await bookkeeping(accountId);
    expect(new Date(book.next_sweep_at!).getTime() - at(8).getTime()).toBe(24 * HOUR);
  });

  it('records a host it is not allowed to touch as an error, not an exception', async () => {
    const accountId = await makeAccount({ domain: 'printer.local' });
    const outcome = await sweepAccount(db, await loadAccount(accountId), { now: () => T0, fetchImpl: deadSite });
    expect(outcome.error).toContain('.local');
    expect((await bookkeeping(accountId)).sweep_error).toBe(outcome.error);
  });

  it('clears a stale sweep_error the moment the site answers again', async () => {
    const accountId = await makeAccount();
    await sweepAccount(db, await loadAccount(accountId), { now: () => T0, fetchImpl: deadSite });
    expect((await bookkeeping(accountId)).sweep_error).not.toBeNull();

    await sweepAccount(db, (await claimDueAccounts(db, WORKSPACE_ID, at(2), 1))[0], {
      now: () => at(2),
      fetchImpl: site({ '/': home('Back up'), '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') })
    });
    expect((await bookkeeping(accountId)).sweep_error).toBeNull();
  });
});

/* --------------------------------------------------------------------------
 * Pacing and the pass.
 * ----------------------------------------------------------------------- */

describe('sweepGapSeconds', () => {
  it('is deterministic for the same seed and inside the band', () => {
    expect(sweepGapSeconds('acct_one')).toBe(sweepGapSeconds('acct_one'));
    expect(sweepGapSeconds('acct_one')).not.toBe(sweepGapSeconds('acct_two'));
    for (const seed of ['a', 'b', 'c', 'acct_1234567890', 'zzz']) {
      expect(sweepGapSeconds(seed)).toBeGreaterThanOrEqual(SWEEP_GAP_SECONDS.min);
      expect(sweepGapSeconds(seed)).toBeLessThanOrEqual(SWEEP_GAP_SECONDS.max);
    }
  });
});

describe('nextSweepAt', () => {
  it('jitters a success around 24h and leaves a backoff exact', () => {
    const account = { id: 'acct_x', sweepError: null, lastSweptAt: null };
    const success = nextSweepAt(account, T0, null);
    expect(success.getTime()).toBe(nextSweepAt(account, T0, null).getTime());
    const driftMinutes = Math.abs(success.getTime() - T0.getTime() - SWEEP_INTERVAL_HOURS * HOUR) / 60_000;
    expect(driftMinutes).toBeLessThanOrEqual(30);
    // Two accounts do not line up on the same minute every night.
    expect(nextSweepAt({ ...account, id: 'acct_y' }, T0, null).getTime()).not.toBe(success.getTime());

    expect(sweepBackoffHours({ sweepError: null, lastSweptAt: null }, T0)).toBe(2);
    expect(sweepBackoffHours({ sweepError: 'down', lastSweptAt: at(-2).toISOString() }, T0)).toBe(6);
    expect(sweepBackoffHours({ sweepError: 'down', lastSweptAt: at(-6).toISOString() }, T0)).toBe(24);
    // A worker that was off for a week does not come back and hammer the host.
    expect(sweepBackoffHours({ sweepError: 'down', lastSweptAt: at(-168).toISOString() }, T0)).toBe(24);
  });
});

describe('runAccountSweep', () => {
  it('paces between accounts, deterministically, and never before the first one', async () => {
    const first = await makeAccount({ domain: 'one.test', createdAt: at(-3).toISOString() });
    const second = await makeAccount({ domain: 'two.test', createdAt: at(-2).toISOString() });
    const third = await makeAccount({ domain: 'three.test', createdAt: at(-1).toISOString() });

    const slept: number[] = [];
    const result = await runAccountSweep(db, WORKSPACE_ID, {
      now: () => T0,
      fetchImpl: deadSite,
      sleep: async (ms) => {
        slept.push(ms);
      }
    });

    expect(result.accountIds).toEqual([first, second, third]);
    expect(result.swept).toBe(3);
    expect(result.failed).toBe(3);
    expect(result.signalsStored).toBe(0);
    expect(slept).toEqual([
      Math.round(sweepGapSeconds(second) * 1_000),
      Math.round(sweepGapSeconds(third) * 1_000)
    ]);
  });

  it('counts the signals it stored and hands back the accounts to rescore', async () => {
    const accountId = await makeAccount({ domain: 'acme.test' });
    const result = await runAccountSweep(db, WORKSPACE_ID, {
      now: () => T0,
      fetchImpl: site({ '/': home('Acme'), '/careers': careers(['Backend Engineer']), '/pricing': pricing('29') }),
      sleep: async () => undefined
    });
    expect(result).toEqual({ swept: 1, signalsStored: 1, failed: 0, accountIds: [accountId] });
  });

  it('bounds one pass, and a nonsense ceiling still runs at least one account', async () => {
    await makeAccount({ domain: 'a.test', createdAt: at(-3).toISOString() });
    await makeAccount({ domain: 'b.test', createdAt: at(-2).toISOString() });
    await makeAccount({ domain: 'c.test', createdAt: at(-1).toISOString() });

    const capped = await runAccountSweep(db, WORKSPACE_ID, { now: () => T0, fetchImpl: deadSite, sleep: async () => undefined }, { maxAccounts: 2 });
    expect(capped.swept).toBe(2);

    const one = await runAccountSweep(db, WORKSPACE_ID, { now: () => at(3), fetchImpl: deadSite, sleep: async () => undefined }, { maxAccounts: 0 });
    expect(one.swept).toBe(1);
  });

  it('is a no-op for a workspace with nothing to sweep', async () => {
    const result = await runAccountSweep(db, 'ws_nobody', { now: () => T0, fetchImpl: deadSite, sleep: async () => undefined });
    expect(result).toEqual({ swept: 0, signalsStored: 0, failed: 0, accountIds: [] });
  });
});
