import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import type { AccountTier } from './types.js';
import {
  createAccount,
  getAccount,
  importAccounts,
  listAccounts,
  listRankedAccounts,
  normalizeAccountDomain,
  parseAccountImport,
  recordAccountFeedback,
  rejectedSignalShapes,
  setAccountStatus
} from './store.js';

/**
 * What is asserted here is the four rules store.ts is built on: the domain is
 * the identity and it is computed in one place, the operator never maps
 * columns, an import is idempotent, and a rejection costs nothing twice.
 *
 * Signals and scores are written with raw SQL rather than through a helper,
 * because this store deliberately does not own those tables -- the sweep and
 * the scorer do -- and a test that reached for their writers would be asserting
 * on somebody else's contract.
 */

let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE_ID = 'ws_accounts_store_test';

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

async function signal(accountId: string, kind: string, observedAt: Date = NOW): Promise<void> {
  await db.prepare(`
    INSERT INTO account_signals
      (id, workspace_id, account_id, kind, detail, previous, current, evidence_url, observed_at, fingerprint, created_at)
    VALUES (?,?,?,?,?,?,?,?,?::timestamptz,?,?::timestamptz)
  `).run(
    id('asig'),
    WORKSPACE_ID,
    accountId,
    kind,
    `${kind} on ${observedAt.toISOString().slice(0, 10)}`,
    null,
    null,
    'https://example.com/careers',
    observedAt.toISOString(),
    `${kind}-${observedAt.toISOString()}`,
    NOW.toISOString()
  );
}

async function score(accountId: string, value: number, tier: AccountTier): Promise<void> {
  await db.prepare(`
    INSERT INTO account_scores
      (workspace_id, account_id, score, tier, distinct_kinds, newest_signal_at, rationale_json, computed_at)
    VALUES (?,?,?,?,?,?::timestamptz,?,?::timestamptz)
  `).run(
    WORKSPACE_ID,
    accountId,
    value,
    tier,
    2,
    NOW.toISOString(),
    JSON.stringify({ components: [], combinations: [], penalties: [], windowDays: 30, summary: 'test' }),
    NOW.toISOString()
  );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Accounts Store Test', NOW.toISOString());
  for (const table of ['account_feedback', 'account_scores', 'account_signals', 'accounts']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE_ID);
  }
});

afterEach(async () => {
  await db?.close();
});

describe('the domain is the identity', () => {
  const accepted: Array<[string, string]> = [
    ['https://www.Acme.com/pricing?x=1', 'acme.com'],
    ['acme.com', 'acme.com'],
    ['ACME.COM.', 'acme.com'],
    ['hi@acme.com', 'acme.com'],
    ['www.acme.co.uk', 'acme.co.uk'],
    ['  HTTP://ACME.COM:8080/pricing#plans  ', 'acme.com'],
    ['acme.com/careers', 'acme.com'],
    ['https://user:pw@shop.acme.io/', 'shop.acme.io'],
    ['WWW.Acme-Labs.dev', 'acme-labs.dev'],
    ['https://www.acme.com/', 'acme.com']
  ];

  it.each(accepted)('reads %s as %s', (raw, expected) => {
    expect(normalizeAccountDomain(raw)).toBe(expected);
  });

  const rejected: Array<[string, string]> = [
    ['', 'nothing to key on'],
    ['   ', 'nothing to key on'],
    ['acme.com Ltd', 'a space means the line was split wrong'],
    ['Acme Corp', 'a company name is not a host'],
    ['192.168.0.1', 'an address is not a company'],
    ['https://10.0.0.7/pricing', 'an address is not a company'],
    ['[::1]', 'an address is not a company'],
    ['http://[2001:db8::1]/', 'an address is not a company'],
    ['localhost', 'never resolves on the public internet'],
    ['http://localhost:3000/app', 'never resolves on the public internet'],
    ['box.local', 'never resolves on the public internet'],
    ['acme', 'a single label is a search term'],
    ['acme.', 'a single label is a search term'],
    ['acme.123', 'a numeric last label is a broken IP'],
    ['-acme.com', 'a label may not start with a hyphen']
  ];

  it.each(rejected)('refuses %s -- %s', (raw) => {
    expect(normalizeAccountDomain(raw)).toBeNull();
  });

  it('collapses the spellings an operator would otherwise store twice', () => {
    const spellings = ['https://www.acme.com/pricing?utm=x', 'ACME.com.', 'acme.com', 'hi@acme.com'];
    expect(new Set(spellings.map(normalizeAccountDomain)).size).toBe(1);
  });
});

describe('parsing a paste', () => {
  it('reads a CSV with a header, in whatever order the columns came', () => {
    const { rows, rejected } = parseAccountImport(
      [
        'Company Name,LinkedIn URL,Website,Tags',
        'Acme Labs,https://www.linkedin.com/company/acme,https://www.acme.com/pricing,eu;saas',
        'Orbit Health,,orbit.health,dach'
      ].join('\n')
    );
    expect(rejected).toEqual([]);
    expect(rows).toEqual([
      {
        name: 'Acme Labs',
        domain: 'acme.com',
        linkedinUrl: 'https://www.linkedin.com/company/acme',
        tags: ['eu', 'saas']
      },
      { name: 'Orbit Health', domain: 'orbit.health', linkedinUrl: null, tags: ['dach'] }
    ]);
  });

  it('never lets a LinkedIn column be mistaken for the domain column', () => {
    // The failure this guards is total: every row would key on linkedin.com and
    // the whole list would collapse into one account.
    const { rows } = parseAccountImport('linkedin,url\nhttps://www.linkedin.com/company/acme,acme.com');
    expect(rows).toEqual([{ name: 'acme.com', domain: 'acme.com', linkedinUrl: 'https://www.linkedin.com/company/acme', tags: [] }]);
  });

  it('reads a CSV with no header at all, first field as the domain', () => {
    const { rows, rejected } = parseAccountImport(['acme.com,Acme Labs', 'orbit.health,Orbit Health'].join('\n'));
    expect(rejected).toEqual([]);
    expect(rows.map((row) => [row.domain, row.name])).toEqual([
      ['acme.com', 'Acme Labs'],
      ['orbit.health', 'Orbit Health']
    ]);
  });

  it('finds the domain when the operator pasted the name first', () => {
    const { rows } = parseAccountImport('Acme Labs,https://www.acme.com/pricing');
    expect(rows).toEqual([{ name: 'Acme Labs', domain: 'acme.com', linkedinUrl: null, tags: [] }]);
  });

  it('reads a plain pasted list, and names each row after its domain', () => {
    const { rows, rejected } = parseAccountImport('  acme.com \n\nhttps://www.orbit.health/pricing\nluma.works\n');
    expect(rejected).toEqual([]);
    expect(rows.map((row) => row.domain)).toEqual(['acme.com', 'orbit.health', 'luma.works']);
    expect(rows.map((row) => row.name)).toEqual(['acme.com', 'orbit.health', 'luma.works']);
  });

  it('does not eat the first company of a headerless list', () => {
    // `domain.com` contains a header word; a substring sniff would eat it as a
    // header row and the operator would silently lose their first company.
    const { rows } = parseAccountImport('domain.com\nacme.com');
    expect(rows.map((row) => row.domain)).toEqual(['domain.com', 'acme.com']);
  });

  it('refuses a line that is only a LinkedIn URL, because every one of them keys on linkedin.com', () => {
    const { rows, rejected } = parseAccountImport('https://www.linkedin.com/company/acme\nacme.com,Acme Labs');
    expect(rows.map((row) => row.domain)).toEqual(['acme.com']);
    expect(rejected[0].reason).toContain('linkedin.com');
  });

  it('dedupes inside the batch on the normalised domain, first spelling wins', () => {
    const { rows, rejected } = parseAccountImport(
      ['acme.com,Acme Labs', 'https://www.ACME.com/pricing,Acme Labs GmbH', 'hi@acme.com,Acme'].join('\n')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme Labs');
    // A duplicate lost nothing, so it is not reported as a loss.
    expect(rejected).toEqual([]);
  });

  it('says which lines held no company, and why', () => {
    const { rows, rejected } = parseAccountImport(['acme.com', 'Acme Corp', 'localhost', '192.168.0.1'].join('\n'));
    expect(rows.map((row) => row.domain)).toEqual(['acme.com']);
    expect(rejected.map((entry) => entry.line)).toEqual(['Acme Corp', 'localhost', '192.168.0.1']);
    expect(rejected[0].reason).toContain('domain');
  });

  it('caps the batch at 2000 rows and says how much was left unread', () => {
    const lines = Array.from({ length: 2010 }, (_, index) => `acme${index}.com`);
    const { rows, rejected } = parseAccountImport(lines.join('\n'));
    expect(rows).toHaveLength(2000);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].line).toBe('acme2000.com');
    expect(rejected[0].reason).toContain('2000');
    expect(rejected[0].reason).toContain('9 after it');
  });

  it('is pure -- an empty paste is an empty answer, not a throw', () => {
    expect(parseAccountImport('')).toEqual({ rows: [], rejected: [] });
    expect(parseAccountImport('\n  \n')).toEqual({ rows: [], rejected: [] });
  });
});

describe('importing', () => {
  it('writes the batch, applies the batch tags, and makes every row due now', async () => {
    const result = await importAccounts(
      db,
      WORKSPACE_ID,
      'Domain,Name,Tags\nacme.com,Acme Labs,saas\norbit.health,Orbit Health,',
      { source: 'csv', tags: ['q3'], icpNote: 'B2B SaaS, 20-200 people' },
      NOW
    );

    expect(result.created).toBe(2);
    expect(result.duplicate).toBe(0);
    expect(result.rejected).toEqual([]);
    expect(result.accounts).toHaveLength(2);

    const acme = result.accounts.find((account) => account.domain === 'acme.com');
    expect(acme?.name).toBe('Acme Labs');
    expect(acme?.source).toBe('csv');
    expect(acme?.status).toBe('active');
    expect(acme?.icpNote).toBe('B2B SaaS, 20-200 people');
    expect(acme?.tags).toEqual(['saas', 'q3']);
    // Due immediately: an import is somebody asking to be shown these now.
    expect(acme?.nextSweepAt).toBe(NOW.toISOString());
    expect(acme?.createdAt).toBe(NOW.toISOString());
  });

  it('is a no-op on re-import, and counts the duplicates exactly', async () => {
    const paste = 'acme.com,Acme Labs\norbit.health,Orbit Health';
    const first = await importAccounts(db, WORKSPACE_ID, paste, { source: 'csv' }, NOW);
    expect(first.created).toBe(2);

    const again = await importAccounts(db, WORKSPACE_ID, `${paste}\nluma.works,Luma`, { source: 'csv' }, NOW);
    expect(again.created).toBe(1);
    expect(again.duplicate).toBe(2);
    // The batch is reported as it now stands, not as what was written.
    expect(again.accounts).toHaveLength(3);
    expect(await listAccounts(db, WORKSPACE_ID)).toHaveLength(3);
  });

  it('re-imports a differently spelled duplicate as a duplicate, not a second company', async () => {
    await importAccounts(db, WORKSPACE_ID, 'acme.com', { source: 'csv' }, NOW);
    const again = await importAccounts(db, WORKSPACE_ID, 'https://www.ACME.com/pricing?x=1', { source: 'csv' }, NOW);
    expect(again.created).toBe(0);
    expect(again.duplicate).toBe(1);
    expect(await listAccounts(db, WORKSPACE_ID)).toHaveLength(1);
  });

  it('reports the unusable lines without losing the usable ones', async () => {
    const result = await importAccounts(db, WORKSPACE_ID, 'acme.com\nnot a domain\nlocalhost', { source: 'csv' }, NOW);
    expect(result.created).toBe(1);
    expect(result.rejected).toHaveLength(2);
  });

  it('writes nothing at all when the paste held no company', async () => {
    const result = await importAccounts(db, WORKSPACE_ID, 'Acme Corp\nlocalhost', { source: 'csv' }, NOW);
    expect(result).toMatchObject({ created: 0, duplicate: 0, accounts: [] });
    expect(result.rejected).toHaveLength(2);
  });
});

describe('a single account', () => {
  it('normalises on the way in and reads back by id', async () => {
    const created = await createAccount(
      db,
      WORKSPACE_ID,
      { domain: 'https://www.Acme.com/pricing', name: 'Acme Labs', source: 'manual', tags: ['eu'] },
      NOW
    );
    expect(created.domain).toBe('acme.com');
    expect(await getAccount(db, WORKSPACE_ID, created.id)).toEqual(created);
    expect(await getAccount(db, WORKSPACE_ID, 'acc_missing')).toBeNull();
    expect(await getAccount(db, 'ws_someone_else', created.id)).toBeNull();
  });

  it('returns the existing row rather than a second one, and does not overwrite it', async () => {
    const first = await createAccount(db, WORKSPACE_ID, { domain: 'acme.com', name: 'Acme Labs', source: 'manual' }, NOW);
    const again = await createAccount(db, WORKSPACE_ID, { domain: 'www.acme.com', name: 'Typed It Twice', source: 'manual' }, NOW);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Acme Labs');
  });

  it('falls back to the domain for a name, because no screen may render an unnamed row', async () => {
    const created = await createAccount(db, WORKSPACE_ID, { domain: 'acme.com', name: '   ', source: 'manual' }, NOW);
    expect(created.name).toBe('acme.com');
  });

  it('refuses a domain that is not one', async () => {
    await expect(createAccount(db, WORKSPACE_ID, { domain: 'Acme Corp', source: 'manual' }, NOW)).rejects.toThrow(/not a company domain/);
    await expect(createAccount(db, WORKSPACE_ID, { domain: 'localhost', source: 'manual' }, NOW)).rejects.toThrow();
  });

  it('lists newest first and filters on status', async () => {
    const old = await createAccount(db, WORKSPACE_ID, { domain: 'old.com', source: 'manual' }, daysBefore(2));
    const fresh = await createAccount(db, WORKSPACE_ID, { domain: 'fresh.com', source: 'manual' }, NOW);
    expect((await listAccounts(db, WORKSPACE_ID)).map((account) => account.id)).toEqual([fresh.id, old.id]);

    await setAccountStatus(db, WORKSPACE_ID, old.id, 'archived', NOW);
    expect((await listAccounts(db, WORKSPACE_ID, { status: 'active' })).map((account) => account.id)).toEqual([fresh.id]);
    expect((await listAccounts(db, WORKSPACE_ID, { limit: 1, offset: 1 })).map((account) => account.id)).toEqual([old.id]);
  });
});

describe('a rejection costs nothing twice', () => {
  it('clears next_sweep_at for not_a_fit and archived, and restores it on reactivation', async () => {
    const account = await createAccount(db, WORKSPACE_ID, { domain: 'acme.com', source: 'manual' }, NOW);
    expect(account.nextSweepAt).toBe(NOW.toISOString());

    const rejectedAccount = await setAccountStatus(db, WORKSPACE_ID, account.id, 'not_a_fit', NOW);
    expect(rejectedAccount?.status).toBe('not_a_fit');
    expect(rejectedAccount?.nextSweepAt).toBeNull();

    const archived = await setAccountStatus(db, WORKSPACE_ID, account.id, 'archived', NOW);
    expect(archived?.nextSweepAt).toBeNull();

    const reactivated = await setAccountStatus(db, WORKSPACE_ID, account.id, 'active', NOW);
    expect(reactivated?.nextSweepAt).toBe(NOW.toISOString());

    expect(await setAccountStatus(db, WORKSPACE_ID, 'acc_missing', 'archived', NOW)).toBeNull();
  });
});

describe('feedback', () => {
  it('snapshots the sorted, distinct shape inside the window and the score at the time', async () => {
    const account = await createAccount(db, WORKSPACE_ID, { domain: 'acme.com', source: 'manual' }, NOW);
    await score(account.id, 84, 'hot');
    await signal(account.id, 'pricing-changed', daysBefore(1));
    await signal(account.id, 'hiring-up', daysBefore(3));
    // Same kind again: DISTINCT, so the shape does not double it.
    await signal(account.id, 'hiring-up', daysBefore(5));
    // Outside thirty days: not what was on the screen.
    await signal(account.id, 'tech-added', daysBefore(45));

    const feedback = await recordAccountFeedback(db, WORKSPACE_ID, account.id, { verdict: 'not_a_fit', reason: 'Too small' }, NOW);
    expect(feedback.signalShape).toBe('hiring-up,pricing-changed');
    expect(feedback.scoreAtVerdict).toBe(84);
    expect(feedback.reason).toBe('Too small');
    expect(feedback.createdAt).toBe(NOW.toISOString());

    // A not_a_fit verdict is also a status change, in one call.
    const after = await getAccount(db, WORKSPACE_ID, account.id);
    expect(after?.status).toBe('not_a_fit');
    expect(after?.nextSweepAt).toBeNull();
  });

  it('records a good_fit without touching the sweep, and with no score when none was computed', async () => {
    const account = await createAccount(db, WORKSPACE_ID, { domain: 'orbit.health', source: 'manual' }, NOW);
    const feedback = await recordAccountFeedback(db, WORKSPACE_ID, account.id, { verdict: 'good_fit' }, NOW);
    expect(feedback.signalShape).toBe('');
    expect(feedback.scoreAtVerdict).toBeNull();
    expect(feedback.reason).toBeNull();

    const after = await getAccount(db, WORKSPACE_ID, account.id);
    expect(after?.status).toBe('active');
    expect(after?.nextSweepAt).toBe(NOW.toISOString());
  });

  it('refuses a verdict on an account this workspace does not have', async () => {
    await expect(recordAccountFeedback(db, WORKSPACE_ID, 'acc_missing', { verdict: 'good_fit' }, NOW)).rejects.toThrow();
  });
});

describe('rejected shapes', () => {
  async function reject(domain: string, kinds: string[], verdict: 'not_a_fit' | 'good_fit' = 'not_a_fit'): Promise<void> {
    const account = await createAccount(db, WORKSPACE_ID, { domain, source: 'manual' }, NOW);
    for (const kind of kinds) await signal(account.id, kind, daysBefore(2));
    await recordAccountFeedback(db, WORKSPACE_ID, account.id, { verdict }, NOW);
  }

  it('needs the threshold before a shape counts as a pattern', async () => {
    await reject('one.com', ['hiring-up']);
    // One rejection is a company, not a pattern.
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual([]);
    expect(await rejectedSignalShapes(db, WORKSPACE_ID, { minCount: 1 })).toEqual(['hiring-up']);

    await reject('two.com', ['hiring-up']);
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual(['hiring-up']);
  });

  it('drops a shape the moment it ever produced a good fit', async () => {
    await reject('one.com', ['hiring-up']);
    await reject('two.com', ['hiring-up']);
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual(['hiring-up']);

    await reject('three.com', ['hiring-up'], 'good_fit');
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual([]);
  });

  it('never learns from silence, and returns sorted', async () => {
    await reject('quiet-one.com', []);
    await reject('quiet-two.com', []);
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual([]);

    await reject('a-one.com', ['pricing-changed']);
    await reject('a-two.com', ['pricing-changed']);
    await reject('b-one.com', ['hiring-up', 'tech-added']);
    await reject('b-two.com', ['hiring-up', 'tech-added']);
    expect(await rejectedSignalShapes(db, WORKSPACE_ID)).toEqual(['hiring-up,tech-added', 'pricing-changed']);
  });
});

describe('the ranked list', () => {
  it('orders by score, keeps unscored accounts below rather than above, and carries the newest signals', async () => {
    const hot = await createAccount(db, WORKSPACE_ID, { domain: 'hot.com', source: 'manual' }, daysBefore(9));
    const warm = await createAccount(db, WORKSPACE_ID, { domain: 'warm.com', source: 'manual' }, daysBefore(8));
    const oldUnscored = await createAccount(db, WORKSPACE_ID, { domain: 'old-unscored.com', source: 'manual' }, daysBefore(7));
    const newUnscored = await createAccount(db, WORKSPACE_ID, { domain: 'new-unscored.com', source: 'manual' }, daysBefore(1));

    await score(hot.id, 91, 'hot');
    await score(warm.id, 40, 'warm');
    await signal(hot.id, 'hiring-up', daysBefore(1));
    await signal(hot.id, 'pricing-changed', daysBefore(2));
    await signal(hot.id, 'tech-added', daysBefore(3));

    const ranked = await listRankedAccounts(db, WORKSPACE_ID);
    expect(ranked.map((row) => row.account.id)).toEqual([hot.id, warm.id, newUnscored.id, oldUnscored.id]);

    expect(ranked[0].score?.score).toBe(91);
    expect(ranked[0].score?.tier).toBe('hot');
    expect(ranked[0].score?.rationale.windowDays).toBe(30);
    expect(ranked[0].signals.map((entry) => entry.kind)).toEqual(['hiring-up', 'pricing-changed', 'tech-added']);
    expect(ranked[0].signals[0].evidenceUrl).toBe('https://example.com/careers');
    expect(ranked[0].signals[0].observedAt).toBe(daysBefore(1).toISOString());

    // An unscored account is one nobody has looked at, not a zero.
    expect(ranked[2].score).toBeNull();
    expect(ranked[2].signals).toEqual([]);
  });

  it('caps the signals per row without a query per account', async () => {
    const account = await createAccount(db, WORKSPACE_ID, { domain: 'acme.com', source: 'manual' }, NOW);
    const other = await createAccount(db, WORKSPACE_ID, { domain: 'orbit.health', source: 'manual' }, daysBefore(1));
    for (let index = 1; index <= 8; index += 1) await signal(account.id, `kind-${index}`, daysBefore(index));
    for (let index = 1; index <= 8; index += 1) await signal(other.id, `other-${index}`, daysBefore(index));

    const ranked = await listRankedAccounts(db, WORKSPACE_ID, { signalLimit: 2 });
    expect(ranked.map((row) => row.signals.map((entry) => entry.kind))).toEqual([
      ['kind-1', 'kind-2'],
      ['other-1', 'other-2']
    ]);

    const defaulted = await listRankedAccounts(db, WORKSPACE_ID);
    expect(defaulted[0].signals).toHaveLength(5);
  });

  it('leaves rejected accounts off the list a founder acts on', async () => {
    const keep = await createAccount(db, WORKSPACE_ID, { domain: 'keep.com', source: 'manual' }, NOW);
    const drop = await createAccount(db, WORKSPACE_ID, { domain: 'drop.com', source: 'manual' }, daysBefore(1));
    await score(drop.id, 99, 'hot');
    await setAccountStatus(db, WORKSPACE_ID, drop.id, 'not_a_fit', NOW);

    expect((await listRankedAccounts(db, WORKSPACE_ID)).map((row) => row.account.id)).toEqual([keep.id]);
    // A score outlives the rejection that followed it, so asking for the hot
    // rows must NOT resurrect a rejected account at the top of the list.
    expect(await listRankedAccounts(db, WORKSPACE_ID, { tier: 'hot' })).toEqual([]);
    // The audit question has to be asked for by name.
    expect(
      (await listRankedAccounts(db, WORKSPACE_ID, { tier: 'hot', includeRejected: true })).map((row) => row.account.id)
    ).toEqual([drop.id]);
  });

  it('honours the limit and stays inside the workspace', async () => {
    await createAccount(db, WORKSPACE_ID, { domain: 'one.com', source: 'manual' }, NOW);
    await createAccount(db, WORKSPACE_ID, { domain: 'two.com', source: 'manual' }, daysBefore(1));
    expect(await listRankedAccounts(db, WORKSPACE_ID, { limit: 1 })).toHaveLength(1);
    expect(await listRankedAccounts(db, 'ws_someone_else')).toEqual([]);
  });
});
