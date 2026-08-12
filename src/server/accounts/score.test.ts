import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  COMBINATION_BONUSES,
  DECAY_FLOOR,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_WINDOW_DAYS,
  GENERIC_PAIR_BONUS,
  HOT_SCORE,
  SIGNAL_WEIGHTS,
  SINGLE_KIND_CAP,
  WARM_SCORE,
  decayFor,
  rationaleTotal,
  rescoreAccount,
  rescoreAccounts,
  rescoreWorkspace,
  scoreAccount,
  signalShape,
  tierFor,
  weightFor
} from './score.js';
import { ACCOUNT_SIGNAL_KINDS, type AccountSignal, type ScoreRationale } from './types.js';

/**
 * The scorer is a pure function, so it is tested like one: exhaustively, in
 * memory, with no database in sight for everything that matters.
 *
 * What is asserted is the PREMISE, not the implementation. One right company
 * beats a hundred plausible ones, so the tests that count are the ones that
 * prove the scorer refuses to be impressed: a single strong signal is warm and
 * never hot, volume of one kind cannot buy a ranking, two different kinds beat
 * two of the same, stale evidence is punished, and a shape the operator already
 * rejected falls out of contention. The last group proves the arithmetic
 * reconciles -- if "why this score" cannot be added up, nobody believes the
 * score twice.
 */

const NOW = new Date('2026-08-05T12:00:00.000Z');
const WORKSPACE_ID = 'ws_accounts_score_test';

let sequence = 0;

/** A signal `ageDays` old. Deterministic ids, so ordering is never accidental. */
function sig(kind: string, ageDays: number, detail?: string): AccountSignal {
  sequence += 1;
  const observedAt = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
  return {
    id: `sig_${String(sequence).padStart(4, '0')}`,
    workspaceId: WORKSPACE_ID,
    accountId: 'acc_test',
    kind,
    detail: detail ?? `${kind} was observed`,
    previous: null,
    current: null,
    evidenceUrl: `https://acme.example/${kind}`,
    observedAt,
    fingerprint: `fp_${sequence}`,
    createdAt: observedAt
  };
}

function score(signals: AccountSignal[], rejectedShapes: readonly string[] = [], windowDays?: number) {
  return scoreAccount(signals, { now: NOW, rejectedShapes, windowDays });
}

const HIRING = 'Open roles on https://acme.example/careers went from 3 to 7 (new: Platform Engineer)';
const PRICING = 'Pricing page content changed on acme.example';

describe('the weight table', () => {
  it('has a weight for every kind the vocabulary knows, and zero for anything else', () => {
    for (const kind of ACCOUNT_SIGNAL_KINDS) {
      expect(typeof SIGNAL_WEIGHTS[kind]).toBe('number');
    }
    expect(Object.keys(SIGNAL_WEIGHTS).sort()).toEqual([...ACCOUNT_SIGNAL_KINDS].sort());
    // A kind from a future build is evidence, and it is worth nothing until
    // somebody decides what it is worth.
    expect(weightFor('funding-round')).toBe(0);
  });

  it('scores first-capture at zero, because a baseline is not news', () => {
    expect(SIGNAL_WEIGHTS['first-capture']).toBe(0);
    const result = score([sig('first-capture', 1, 'First snapshot of acme.example: 3 open roles')]);
    expect(result.score).toBe(0);
    expect(result.tier).toBe('cold');
    expect(result.distinctKinds).toBe(0);
    // It is still SHOWN -- stored evidence never silently vanishes.
    expect(result.rationale.components).toHaveLength(1);
    expect(result.rationale.components[0].points).toBe(0);
  });

  it('ranks public intent highest, then hiring and pricing, then positioning', () => {
    expect(SIGNAL_WEIGHTS['thread-mention']).toBeGreaterThan(SIGNAL_WEIGHTS['hiring-up']);
    expect(SIGNAL_WEIGHTS['hiring-up']).toBeGreaterThan(SIGNAL_WEIGHTS['pricing-changed']);
    expect(SIGNAL_WEIGHTS['pricing-changed']).toBeGreaterThan(SIGNAL_WEIGHTS['headline-changed']);
    expect(SIGNAL_WEIGHTS['headline-changed']).toBeGreaterThan(SIGNAL_WEIGHTS['tech-added']);
    expect(SIGNAL_WEIGHTS['tech-added']).toBeGreaterThan(SIGNAL_WEIGHTS['tech-removed']);
  });

  it('treats a contraction as a subtraction and a removal as a whisper', () => {
    expect(SIGNAL_WEIGHTS['hiring-down']).toBeLessThan(0);
    expect(SIGNAL_WEIGHTS['tech-removed']).toBeGreaterThan(0);
    expect(SIGNAL_WEIGHTS['tech-removed']).toBeLessThan(SIGNAL_WEIGHTS['headline-changed'] / 2);
  });

  it('lets no single kind reach the hot threshold on its own weight', () => {
    for (const kind of ACCOUNT_SIGNAL_KINDS) {
      expect(SIGNAL_WEIGHTS[kind]).toBeLessThan(HOT_SCORE);
    }
    // And the ceiling on a one-kind account sits below it too, so the ranked
    // list cannot sort a single-signal 'warm' above a layered 'hot'.
    expect(SINGLE_KIND_CAP).toBeLessThan(HOT_SCORE);
  });
});

describe('decay', () => {
  it('is 1 at the moment the signal pops and halves at the half-life', () => {
    expect(decayFor(0)).toBe(1);
    expect(decayFor(DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 3);
    expect(decayFor(DEFAULT_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 3);
  });

  it('never increases with age, and never leaves (0,1]', () => {
    let previous = decayFor(0);
    for (let age = 1; age <= 200; age += 1) {
      const current = decayFor(age);
      expect(current).toBeLessThanOrEqual(previous);
      expect(current).toBeGreaterThan(0);
      expect(current).toBeLessThanOrEqual(1);
      previous = current;
    }
  });

  it('floors rather than reaching zero, so old evidence can still corroborate', () => {
    expect(decayFor(365)).toBe(DECAY_FLOOR);
    expect(decayFor(10_000)).toBe(DECAY_FLOOR);
  });

  it('takes a half-life override and refuses to be tricked by a bad clock', () => {
    expect(decayFor(7, 7)).toBeCloseTo(0.5, 3);
    // A signal timestamped in the future is somebody else's clock skew, not a
    // reason to drop their signal.
    expect(decayFor(-5)).toBe(1);
    expect(decayFor(Number.NaN)).toBe(1);
  });
});

describe('one signal is never enough', () => {
  it('makes the strongest possible fresh single signal warm, not hot', () => {
    const result = score([sig('thread-mention', 0)]);
    expect(result.distinctKinds).toBe(1);
    expect(result.tier).toBe('warm');
    expect(result.score).toBeLessThan(HOT_SCORE);
    expect(result.rationale.combinations).toHaveLength(0);
  });

  it('caps a score built from one kind however often that kind fired', () => {
    const shouted = score([
      sig('thread-mention', 0),
      sig('thread-mention', 0),
      sig('thread-mention', 1),
      sig('thread-mention', 2),
      sig('thread-mention', 3),
      sig('thread-mention', 4)
    ]);
    expect(shouted.score).toBe(SINGLE_KIND_CAP);
    expect(shouted.tier).toBe('warm');
    expect(shouted.rationale.penalties.some((penalty) => penalty.reason.includes('Only one kind'))).toBe(true);
  });

  it('tapers repeats of the same kind, because volume is not evidence', () => {
    const once = score([sig('hiring-up', 0)]);
    const twice = score([sig('hiring-up', 0), sig('hiring-up', 0)]);
    expect(twice.score).toBeGreaterThan(once.score);
    expect(twice.score).toBeLessThan(once.score * 2);
    expect(twice.distinctKinds).toBe(1);
  });

  it('never counts a baseline or a contraction as a second kind', () => {
    const result = score([sig('hiring-up', 0), sig('first-capture', 1), sig('hiring-down', 2)]);
    expect(result.distinctKinds).toBe(1);
    expect(result.tier).not.toBe('hot');
    expect(result.rationale.combinations).toHaveLength(0);
    // The contraction is subtracted, not ignored.
    expect(result.score).toBeLessThan(SIGNAL_WEIGHTS['hiring-up']);
  });

  it('leaves an account whose only news is a contraction at the bottom of the list', () => {
    const result = score([sig('hiring-down', 1)]);
    expect(result.score).toBe(0);
    expect(result.tier).toBe('cold');
  });
});

describe('layering', () => {
  it('makes two distinct fresh signals beat two of the same kind, decisively', () => {
    const distinct = score([sig('hiring-up', 2, HIRING), sig('pricing-changed', 4, PRICING)]);
    const repeated = score([sig('hiring-up', 2, HIRING), sig('hiring-up', 4, HIRING)]);
    expect(distinct.score).toBe(73);
    expect(distinct.tier).toBe('hot');
    expect(repeated.tier).toBe('warm');
    expect(distinct.score).toBeGreaterThan(repeated.score * 1.5);
  });

  it('pays more for three distinct kinds than for two, without a special third term', () => {
    const two = score([sig('headline-changed', 0), sig('tech-added', 0)]);
    const three = score([sig('headline-changed', 0), sig('tech-added', 0), sig('tech-removed', 0)]);
    expect(two.rationale.combinations).toHaveLength(1);
    // Three kinds is three pairs: breadth compounds out of the counting.
    expect(three.rationale.combinations).toHaveLength(3);
    expect(three.score).toBeGreaterThan(two.score * 1.5);
    expect(three.distinctKinds).toBe(3);
  });

  it('names the pairs that mean something specific, in words a founder can read', () => {
    const result = score([sig('thread-mention', 1), sig('hiring-up', 1)]);
    expect(result.rationale.combinations).toHaveLength(1);
    const [combination] = result.rationale.combinations;
    expect(combination.kinds).toEqual(['hiring-up', 'thread-mention']);
    expect(combination.why).toContain('stated intent with budget behind it');
    expect(combination.bonus).toBeGreaterThan(GENERIC_PAIR_BONUS);
  });

  it('explains an unnamed pair too, rather than leaving a bare number', () => {
    const result = score([sig('headline-changed', 0), sig('tech-added', 0)]);
    const [combination] = result.rationale.combinations;
    expect(combination.bonus).toBe(GENERIC_PAIR_BONUS);
    expect(combination.why).toContain('corroborate each other');
    expect(combination.why).toContain('homepage rewrite');
  });

  it('keeps every named pair worth more than a generic one and below a whole tier', () => {
    for (const entry of COMBINATION_BONUSES) {
      expect(entry.bonus).toBeGreaterThanOrEqual(GENERIC_PAIR_BONUS);
      expect(entry.bonus).toBeLessThan(HOT_SCORE / 2);
      expect(entry.why.length).toBeGreaterThan(40);
      // Only positively-weighted kinds may pair; a shrug corroborates nothing.
      expect(weightFor(entry.kinds[0])).toBeGreaterThan(0);
      expect(weightFor(entry.kinds[1])).toBeGreaterThan(0);
    }
  });

  it('lets a genuinely loud account reach the top of the scale, and says that it clamped', () => {
    const result = score([sig('thread-mention', 0), sig('hiring-up', 0), sig('pricing-changed', 0)]);
    expect(result.score).toBe(100);
    expect(result.tier).toBe('hot');
    expect(result.rationale.penalties.some((penalty) => penalty.reason.includes('Capped at 100'))).toBe(true);
  });
});

describe('the window', () => {
  it('excludes a 90-day-old signal entirely, and does not mention the archive', () => {
    const result = score([sig('hiring-up', 90, HIRING)]);
    expect(result.score).toBe(0);
    expect(result.distinctKinds).toBe(0);
    expect(result.newestSignalAt).toBeNull();
    expect(result.rationale.components).toHaveLength(0);
    expect(result.rationale.summary).toBe('Nothing has been observed on this account in the last 60 days.');
    expect(result.rationale.summary).not.toContain('90');
    expect(JSON.stringify(result.rationale)).not.toContain(HIRING);
  });

  it('keeps a signal at the edge of the window and drops the one past it', () => {
    expect(score([sig('hiring-up', DEFAULT_WINDOW_DAYS)]).rationale.components).toHaveLength(1);
    expect(score([sig('hiring-up', DEFAULT_WINDOW_DAYS + 1)]).rationale.components).toHaveLength(0);
  });

  it('echoes the window it used, and honours an override', () => {
    expect(score([]).rationale.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    const narrow = score([sig('hiring-up', 20, HIRING)], [], 14);
    expect(narrow.rationale.windowDays).toBe(14);
    expect(narrow.score).toBe(0);
  });

  it('reports the newest observation it scored over, not the newest that exists', () => {
    const fresh = sig('hiring-up', 3);
    const ancient = sig('pricing-changed', 300);
    expect(score([ancient, fresh]).newestSignalAt).toBe(fresh.observedAt);
  });

  it('charges an account whose freshest evidence is past the half-life', () => {
    const stale = score([sig('hiring-up', 40, HIRING), sig('pricing-changed', 40, PRICING)]);
    expect(stale.rationale.penalties.some((penalty) => penalty.reason.includes('Nothing here is recent'))).toBe(true);
    // Two corroborating signals, and still cold -- because nobody has time to
    // open a conversation about something that happened six weeks ago.
    expect(stale.tier).toBe('cold');

    // One fresh signal is enough to stop the staleness charge -- and still not
    // enough to be hot, because half the evidence is six weeks old.
    const fresh = score([sig('hiring-up', 40, HIRING), sig('pricing-changed', 1, PRICING)]);
    expect(fresh.rationale.penalties).toHaveLength(0);
    expect(fresh.tier).toBe('warm');
    expect(fresh.score).toBeGreaterThan(stale.score * 2);
  });
});

describe('the operator rejections', () => {
  it('drops a score whose shape the operator already called noise', () => {
    const signals = [sig('hiring-up', 2, HIRING), sig('pricing-changed', 4, PRICING)];
    const clean = score(signals);
    const rejected = score(signals, ['hiring-up,pricing-changed']);
    expect(clean.tier).toBe('hot');
    expect(rejected.score).toBe(clean.score - 40);
    expect(rejected.tier).not.toBe('hot');
    expect(rejected.rationale.penalties[0].points).toBe(-40);
    expect(rejected.rationale.summary).toContain('already marked this exact combination not a fit');
  });

  it('matches on the whole shape, so a different combination is untouched', () => {
    const signals = [sig('hiring-up', 2), sig('pricing-changed', 4), sig('tech-added', 5)];
    const result = score(signals, ['hiring-up,pricing-changed']);
    expect(result.rationale.penalties.some((penalty) => penalty.reason.includes('not a fit'))).toBe(false);
    expect(result.tier).toBe('hot');
  });

  it('spells the shape the same way the feedback table stores it', () => {
    expect(signalShape(['pricing-changed', 'hiring-up', 'hiring-up'])).toBe('hiring-up,pricing-changed');
    expect(signalShape([])).toBe('');
    // Canonical vocabulary order, not alphabetical, and unknown kinds last.
    expect(signalShape(['thread-mention', 'zzz-unknown', 'first-capture'])).toBe('first-capture,thread-mention,zzz-unknown');
  });

  it('never matches an empty shape against an empty account', () => {
    expect(score([], ['']).rationale.penalties).toHaveLength(0);
  });
});

describe('tiers', () => {
  it('gates hot on two distinct kinds, not on points alone', () => {
    expect(tierFor(99, 1)).toBe('warm');
    expect(tierFor(HOT_SCORE, 2)).toBe('hot');
    expect(tierFor(HOT_SCORE - 1, 2)).toBe('warm');
    expect(tierFor(WARM_SCORE, 0)).toBe('warm');
    expect(tierFor(WARM_SCORE - 1, 3)).toBe('cold');
    expect(tierFor(0, 0)).toBe('cold');
  });

  it('keeps the bands lopsided on purpose', () => {
    // A scorer that ranks everything at 60 is worthless: the gap between warm
    // and hot has to be most of the scale.
    expect(HOT_SCORE - WARM_SCORE).toBeGreaterThanOrEqual(40);
  });
});

describe('the arithmetic', () => {
  const cases: [string, AccountSignal[], readonly string[]][] = [
    ['nothing', [], []],
    ['one signal', [sig('hiring-up', 3, HIRING)], []],
    ['a layered pair', [sig('hiring-up', 2, HIRING), sig('pricing-changed', 4, PRICING)], []],
    ['a clamped account', [sig('thread-mention', 0), sig('hiring-up', 0), sig('pricing-changed', 0)], []],
    ['a capped single kind', [sig('thread-mention', 0), sig('thread-mention', 0), sig('thread-mention', 0)], []],
    ['a stale pair', [sig('hiring-up', 40), sig('pricing-changed', 45)], []],
    ['a rejected shape', [sig('hiring-up', 2), sig('pricing-changed', 4)], ['hiring-up,pricing-changed']],
    ['a floored contraction', [sig('hiring-down', 1), sig('first-capture', 2)], []]
  ];

  it.each(cases)('reconciles: %s', (_label, signals, rejectedShapes) => {
    const result = score(signals, rejectedShapes);
    // THE INVARIANT THAT MAKES "why this score" TRUSTWORTHY: every line the
    // panel renders adds up to the number the panel leads with.
    expect(result.score).toBe(Math.round(rationaleTotal(result.rationale)));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.tier).toBe(tierFor(result.score, result.distinctKinds));
  });

  it.each(cases)('renders components that can be recomputed from themselves: %s', (_label, signals, rejectedShapes) => {
    for (const component of score(signals, rejectedShapes).rationale.components) {
      expect(component.points).toBe(Math.round(component.base * component.decay * 10) / 10);
      expect(component.decay).toBeGreaterThan(0);
      expect(component.decay).toBeLessThanOrEqual(1);
      expect(component.ageDays).toBeGreaterThanOrEqual(0);
      expect(component.base).toBe(weightFor(component.kind));
      // The first occurrence of a kind carries recency and nothing else, so an
      // auditor with the row alone can rebuild the multiplier.
      expect(component.decay).toBeLessThanOrEqual(decayFor(component.ageDays));
    }
  });

  it('carries the evidence into every component, because a claim is not a signal', () => {
    const result = score([sig('hiring-up', 2, HIRING)]);
    const [component] = result.rationale.components;
    expect(component.detail).toBe(HIRING);
    expect(component.evidenceUrl).toBe('https://acme.example/hiring-up');
    expect(component.observedAt).toBe(result.newestSignalAt);
  });

  it('renders the strongest contribution first', () => {
    const result = score([sig('tech-removed', 0), sig('thread-mention', 0), sig('headline-changed', 0)]);
    expect(result.rationale.components.map((component) => component.kind)).toEqual([
      'thread-mention',
      'headline-changed',
      'tech-removed'
    ]);
  });
});

describe('the sentence', () => {
  it('names the signals, their recency, and the judgement, in one sentence', () => {
    const result = score([sig('hiring-up', 4, HIRING), sig('pricing-changed', 3, PRICING)]);
    const { summary } = result.rationale;
    expect(summary).toContain('went from 3 to 7');
    expect(summary).toContain('spotted 4 days ago');
    expect(summary).toContain('Pricing page content changed on acme.example');
    expect(summary).toContain('two independent signals, both fresh');
    // ONE sentence: no full stop until the end of it.
    expect(summary.split('. ')).toHaveLength(1);
    expect(summary.endsWith('.')).toBe(true);
  });

  it('says plainly when one signal is all there is', () => {
    expect(score([sig('hiring-up', 1, HIRING)]).rationale.summary).toContain(
      'one kind of signal is a coincidence until something else moves'
    );
  });

  it('switches from days to a date once a signal stops being this fortnight', () => {
    expect(score([sig('hiring-up', 0)]).rationale.summary).toContain('spotted today');
    expect(score([sig('hiring-up', 1)]).rationale.summary).toContain('spotted yesterday');
    expect(score([sig('hiring-up', 6)]).rationale.summary).toContain('spotted 6 days ago');
    expect(score([sig('hiring-up', 34)]).rationale.summary).toContain('spotted on 2 Jul');
  });

  it('counts the rest rather than listing them', () => {
    const summary = score([
      sig('thread-mention', 0),
      sig('hiring-up', 0),
      sig('pricing-changed', 0),
      sig('headline-changed', 0)
    ]).rationale.summary;
    expect(summary).toContain('plus two more');
    expect(summary).toContain('four independent signals, all fresh');
  });

  it('admits when the freshest thing is not fresh', () => {
    expect(score([sig('hiring-up', 30), sig('pricing-changed', 40)]).rationale.summary).toContain(
      'two independent signals, the freshest 30 days old'
    );
  });

  it('says nothing has moved when nothing has, and why a baseline is not news', () => {
    expect(score([]).rationale.summary).toBe('Nothing has been observed on this account in the last 60 days.');
    const baseline = score([sig('first-capture', 2, 'First snapshot of acme.example: 3 open roles')]).rationale.summary;
    expect(baseline).toContain('First snapshot of acme.example');
    expect(baseline).toContain('nothing to act on yet');
  });
});

describe('determinism', () => {
  const signals = [
    sig('hiring-up', 2, HIRING),
    sig('pricing-changed', 4, PRICING),
    sig('hiring-up', 9, HIRING),
    sig('first-capture', 30, 'First snapshot of acme.example')
  ];

  it('produces a byte-identical rationale for the same input twice', () => {
    const first = scoreAccount(signals, { now: NOW });
    const second = scoreAccount(signals, { now: NOW });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('does not depend on the order the signals arrived in', () => {
    const forwards = scoreAccount(signals, { now: NOW });
    const backwards = scoreAccount([...signals].reverse(), { now: NOW });
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('survives a round trip through the column it is stored in', () => {
    const result = scoreAccount(signals, { now: NOW });
    const restored = JSON.parse(JSON.stringify(result.rationale)) as ScoreRationale;
    expect(rationaleTotal(restored)).toBe(rationaleTotal(result.rationale));
  });
});

/* ---------------------------------------------------------------------------
 * Persistence. The shell, not the judgement -- what is asserted here is that a
 * score reaches the table intact, replaces the previous one in place, and costs
 * a number of round trips that does not grow with the number of accounts.
 * ------------------------------------------------------------------------ */

describe('storing a score', () => {
  let db: Db;

  /** Counts `prepare` calls, so "never one round trip per account" is a test and not a hope. */
  function counting(inner: Db): { db: Db; statements: string[] } {
    const statements: string[] = [];
    const proxy = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return inner.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    return { db: proxy as Db, statements };
  }

  async function account(accountId: string, status = 'active'): Promise<string> {
    await db
      .prepare('INSERT INTO accounts (id,workspace_id,name,domain,status) VALUES (?,?,?,?,?)')
      .run(accountId, WORKSPACE_ID, accountId, `${accountId}.example`, status);
    return accountId;
  }

  async function signal(accountId: string, kind: string, ageDays: number, detail = `${kind} was observed`): Promise<void> {
    sequence += 1;
    await db
      .prepare(
        `INSERT INTO account_signals (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        `dbsig_${sequence}`,
        WORKSPACE_ID,
        accountId,
        kind,
        detail,
        `https://${accountId}.example/${kind}`,
        new Date(NOW.getTime() - ageDays * 86_400_000).toISOString(),
        `dbfp_${sequence}`
      );
  }

  async function storedRow(accountId: string) {
    return db
      .prepare('SELECT score, tier, distinct_kinds, newest_signal_at, rationale_json, computed_at FROM account_scores WHERE workspace_id=? AND account_id=?')
      .get<{
        score: number;
        tier: string;
        distinct_kinds: number;
        newest_signal_at: string | null;
        rationale_json: string;
        computed_at: string;
      }>(WORKSPACE_ID, accountId);
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(WORKSPACE_ID, 'Accounts Score Test', NOW.toISOString());
    // `accounts` cascades to signals, scores and feedback.
    await db.prepare('DELETE FROM accounts WHERE workspace_id=?').run(WORKSPACE_ID);
  });

  afterEach(async () => {
    await db?.close();
  });

  it('writes the score, the tier, the kind count and the rationale, and hands back what it stored', async () => {
    await account('acc_hot');
    await signal('acc_hot', 'hiring-up', 2, HIRING);
    await signal('acc_hot', 'pricing-changed', 4, PRICING);

    const stored = await rescoreAccount(db, WORKSPACE_ID, 'acc_hot', { now: NOW });
    expect(stored).not.toBeNull();
    expect(stored!.score).toBe(73);
    expect(stored!.tier).toBe('hot');
    expect(stored!.distinctKinds).toBe(2);
    expect(stored!.computedAt).toBe(NOW.toISOString());
    expect(stored!.rationale.summary).toContain('went from 3 to 7');

    const row = await storedRow('acc_hot');
    expect(row?.score).toBe(73);
    expect(row?.tier).toBe('hot');
    expect(row?.distinct_kinds).toBe(2);
    expect(new Date(row!.newest_signal_at!).toISOString()).toBe(stored!.newestSignalAt);
    // The rationale on the row is the rationale that was returned -- parsed
    // once here, never re-derived on read.
    expect(JSON.parse(row!.rationale_json)).toEqual(stored!.rationale);
  });

  it('replaces the previous score in place rather than accumulating history', async () => {
    await account('acc_repeat');
    await signal('acc_repeat', 'hiring-up', 1);
    const first = await rescoreAccount(db, WORKSPACE_ID, 'acc_repeat', { now: NOW });

    await signal('acc_repeat', 'pricing-changed', 0);
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await rescoreAccount(db, WORKSPACE_ID, 'acc_repeat', { now: later });

    const rows = await db
      .prepare('SELECT account_id FROM account_scores WHERE workspace_id=? AND account_id=?')
      .all(WORKSPACE_ID, 'acc_repeat');
    expect(rows).toHaveLength(1);
    expect(second!.score).toBeGreaterThan(first!.score);
    expect(second!.tier).toBe('hot');
    expect((await storedRow('acc_repeat'))?.score).toBe(second!.score);
  });

  it('scores an account with no signals at all, so the ranked list can say so', async () => {
    await account('acc_quiet');
    const stored = await rescoreAccount(db, WORKSPACE_ID, 'acc_quiet', { now: NOW });
    expect(stored!.score).toBe(0);
    expect(stored!.tier).toBe('cold');
    expect(stored!.newestSignalAt).toBeNull();
    expect(stored!.rationale.summary).toContain('Nothing has been observed');
    expect(await storedRow('acc_quiet')).toBeDefined();
  });

  it('returns null for an account that does not exist, or that the operator has rejected', async () => {
    await account('acc_rejected', 'not_a_fit');
    await signal('acc_rejected', 'hiring-up', 0);
    await account('acc_archived', 'archived');

    expect(await rescoreAccount(db, WORKSPACE_ID, 'acc_missing', { now: NOW })).toBeNull();
    expect(await rescoreAccount(db, WORKSPACE_ID, 'acc_rejected', { now: NOW })).toBeNull();
    expect(await rescoreAccount(db, WORKSPACE_ID, 'acc_archived', { now: NOW })).toBeNull();
    expect(await storedRow('acc_rejected')).toBeUndefined();
  });

  it('never scores an account from another workspace', async () => {
    await account('acc_theirs');
    expect(await rescoreAccount(db, 'ws_someone_else', 'acc_theirs', { now: NOW })).toBeNull();
  });

  it('carries a rejected shape through to the stored rationale', async () => {
    await account('acc_noise');
    await signal('acc_noise', 'hiring-up', 2);
    await signal('acc_noise', 'pricing-changed', 3);

    const clean = await rescoreAccount(db, WORKSPACE_ID, 'acc_noise', { now: NOW });
    const rejected = await rescoreAccount(db, WORKSPACE_ID, 'acc_noise', {
      now: NOW,
      rejectedShapes: ['hiring-up,pricing-changed']
    });

    expect(rejected!.score).toBe(clean!.score - 40);
    const row = await storedRow('acc_noise');
    const rationale = JSON.parse(row!.rationale_json) as ScoreRationale;
    expect(rationale.penalties[0].points).toBe(-40);
  });

  it('scores many accounts in a bounded number of round trips, never one each', async () => {
    const ids = ['acc_a', 'acc_b', 'acc_c', 'acc_d', 'acc_e'];
    for (const accountId of ids) {
      await account(accountId);
      await signal(accountId, 'hiring-up', 1);
      await signal(accountId, 'thread-mention', 2);
    }

    const spy = counting(db);
    const scores = await rescoreAccounts(spy.db, WORKSPACE_ID, ids, { now: NOW });

    expect(scores).toHaveLength(5);
    // One statement to resolve the accounts, one to read every signal, one
    // multi-row upsert. Five accounts, three statements -- and it would still
    // be three for two hundred.
    expect(spy.statements).toHaveLength(3);
    expect(spy.statements.filter((sql) => sql.includes('INSERT INTO account_scores'))).toHaveLength(1);
    for (const stored of scores) {
      expect(stored.tier).toBe('hot');
      expect((await storedRow(stored.accountId))?.score).toBe(stored.score);
    }
  });

  it('drops ids that are stale or rejected instead of throwing at the caller', async () => {
    await account('acc_live');
    await account('acc_dead', 'not_a_fit');
    const scores = await rescoreAccounts(db, WORKSPACE_ID, ['acc_live', 'acc_dead', 'acc_ghost'], { now: NOW });
    expect(scores.map((stored) => stored.accountId)).toEqual(['acc_live']);
    expect(await rescoreAccounts(db, WORKSPACE_ID, [], { now: NOW })).toEqual([]);
  });

  it('rescores a whole workspace on one clock, skipping what the operator took out', async () => {
    for (const accountId of ['acc_one', 'acc_two', 'acc_three']) {
      await account(accountId);
      await signal(accountId, 'hiring-up', 1);
    }
    await account('acc_out', 'not_a_fit');
    await signal('acc_out', 'hiring-up', 1);

    const spy = counting(db);
    const scored = await rescoreWorkspace(spy.db, WORKSPACE_ID, { now: NOW });

    expect(scored).toBe(3);
    expect(spy.statements).toHaveLength(3);
    expect(await storedRow('acc_out')).toBeUndefined();

    const rows = await db
      .prepare('SELECT account_id, computed_at FROM account_scores WHERE workspace_id=? ORDER BY account_id')
      .all<{ account_id: string; computed_at: string }>(WORKSPACE_ID);
    expect(rows.map((row) => row.account_id)).toEqual(['acc_one', 'acc_three', 'acc_two']);
    // ONE clock for the pass: three accounts scored at the same instant, so the
    // ranking cannot depend on the order the job visited them.
    expect(new Set(rows.map((row) => new Date(row.computed_at).toISOString())).size).toBe(1);
  });
});
