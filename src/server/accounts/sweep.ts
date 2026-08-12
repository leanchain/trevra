import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import type { FetchLike } from '../skills/guard.js';
import { watchSignals, type ResearchSnapshot } from '../skills/signal.js';
import type { SkillContext } from '../skills/types.js';
import type { Account, AccountSignal, AccountSource, AccountStatus } from './types.js';

/**
 * The paced signal sweep: the thing that makes an account list a LIVING list.
 *
 * An imported CSV of 500 companies is a snapshot of somebody's guess. What
 * makes it worth opening next Tuesday is that something on it MOVED -- a role
 * opened, a pricing page changed, a headline was rewritten -- and that the move
 * is recent enough to be worth a sentence. This module is the loop that goes
 * and looks, every day, without ever becoming a crawler.
 *
 * FOUR RULES, and every part of this file exists because of one of them:
 *
 * 1. THERE IS ONE FETCHER, AND IT IS NOT HERE. `skills/signal.ts` already
 *    fetches a homepage, discovers the careers and pricing pages, hashes
 *    visible text rather than markup, and refuses to diff a field it did not
 *    capture. A second fetcher would be a second set of those decisions, and
 *    the two would disagree within a month -- most expensively about whether a
 *    timed-out careers page means "zero roles". So {@link sweepAccount} calls
 *    `watchSignals` and does nothing else with the network.
 * 2. THE SAME EVENT, SEEN AGAIN, IS NOT NEWS. A daily sweep re-reads the same
 *    unchanged pages 364 times a year. {@link signalFingerprint} plus the
 *    unique index is what collapses that into one row -- see its doc.
 * 3. A SIGNAL WITHOUT A LINK IS A CLAIM. `evidence_url` is NOT NULL in
 *    migration 039 on purpose, and {@link recordSignals} DROPS a signal that
 *    has no URL rather than storing a blank one. A score assembled from claims
 *    is a score no operator can audit, and an opener built on one is a sentence
 *    the recipient cannot check.
 * 4. PACING IS A COLUMN, NOT A LOOP. `next_sweep_at` is what a worker claims
 *    on, so two workers cannot sweep the same account, a crash cannot hot-loop
 *    one row, and a dead host backs off instead of being retried every minute.
 *
 * NOTHING HERE SCORES ANYTHING. {@link runAccountSweep} returns the account ids
 * it touched so the caller can rescore them; the scorer is a separate module
 * and importing it from the sweep would make "we looked" and "we judged" one
 * failure instead of two.
 */

/* ---------------------------------------------------------------------------
 * Rows.
 * ------------------------------------------------------------------------ */

interface AccountRow {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  linkedin_url: string | null;
  source: string;
  tags: string[] | null;
  status: string;
  icp_note: string | null;
  last_swept_at: string | null;
  next_sweep_at: string | null;
  sweep_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SignalRow {
  id: string;
  workspace_id: string;
  account_id: string;
  kind: string;
  detail: string;
  previous: string | null;
  current: string | null;
  evidence_url: string;
  observed_at: string;
  fingerprint: string;
  created_at: string;
}

const ACCOUNT_COLUMNS = `
  id, workspace_id, name, domain, linkedin_url, source, tags, status, icp_note,
  last_swept_at, next_sweep_at, sweep_error, created_at, updated_at
`;

const SIGNAL_COLUMNS = `
  id, workspace_id, account_id, kind, detail, previous, current, evidence_url,
  observed_at, fingerprint, created_at
`;

/**
 * Row to {@link Account}.
 *
 * Written here rather than imported from the store because the sweep must be
 * buildable and reviewable against migration 039 alone -- `types.ts` is the
 * contract both halves share, and neither half is the other's dependency.
 */
function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    domain: row.domain,
    linkedinUrl: row.linkedin_url,
    source: row.source as AccountSource,
    tags: row.tags ?? [],
    status: row.status as AccountStatus,
    icpNote: row.icp_note,
    lastSweptAt: row.last_swept_at,
    nextSweepAt: row.next_sweep_at,
    sweepError: row.sweep_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSignal(row: SignalRow): AccountSignal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    kind: row.kind,
    detail: row.detail,
    previous: row.previous,
    current: row.current,
    evidenceUrl: row.evidence_url,
    observedAt: row.observed_at,
    fingerprint: row.fingerprint,
    createdAt: row.created_at
  };
}

/* ---------------------------------------------------------------------------
 * The dedupe key.
 * ------------------------------------------------------------------------ */

/**
 * The identity of an OBSERVED CHANGE: `sha256(kind, previous, current)`, 32 hex
 * characters.
 *
 * WHY A DAILY RE-READ OF AN UNCHANGED PAGE MUST COLLAPSE TO ONE ROW. The sweep
 * runs every 24h and compares the current capture against the last one stored,
 * so on the day hiring goes 3 -> 5 the diff says `hiring-up`. That is one
 * event. But the same account can produce that same tuple again for reasons
 * that are not events: a snapshot row that failed to parse degrades to "no
 * prior" and re-emits `first-capture`; a flaky careers fetch drops the count to
 * null and the recovery re-reports the same move; a headline that flips B -> A
 * -> B lands back on a pair already seen. Store each of those and the account
 * accumulates a pile of identical rows, the scorer counts the same movement
 * three times, and the ranked list puts a company at the top for one thing that
 * happened once.
 *
 * So the fingerprint hashes exactly what makes an event an event -- the kind
 * and the two values that moved -- and the unique index on
 * (workspace, account, kind, fingerprint) does the collapsing in the database,
 * where a second worker racing the first cannot get around it.
 *
 * NULL IS NOT THE EMPTY STRING. The tuple is JSON-encoded rather than joined,
 * because "the headline was removed" (`current: null`) and "the headline is now
 * blank" (`current: ''`) are different observations and must not share a row.
 */
export function signalFingerprint(kind: string, previous: string | null, current: string | null): string {
  return createHash('sha256').update(JSON.stringify([kind, previous, current])).digest('hex').slice(0, 32);
}

/* ---------------------------------------------------------------------------
 * Pacing.
 * ------------------------------------------------------------------------ */

/** A successful sweep looks again tomorrow. Anything faster is a crawler. */
export const SWEEP_INTERVAL_HOURS = 24;

/**
 * The failure ladder, in hours. First failure waits 2h, the next 6h, and from
 * then on a day.
 *
 * A host that is down for a minute deserves a quick retry; a host that has been
 * refusing us since Tuesday deserves to be left alone. Two rungs of patience is
 * enough to tell those apart, and a third would only delay the point at which
 * the operator sees `sweep_error` on the row.
 */
export const SWEEP_BACKOFF_HOURS: readonly [number, number, number] = [2, 6, 24];

/** Seconds between two account fetches. Not a rate limit -- a refusal to burst. */
export const SWEEP_GAP_SECONDS = { min: 20, max: 90 } as const;

/** How far a successful re-schedule may drift either side of 24h. */
export const SWEEP_JITTER_SECONDS = 1_800;

/** Accounts one pass will claim, and the ceiling a caller may not argue past. */
export const DEFAULT_SWEEP_ACCOUNTS = 25;
export const HARD_MAX_SWEEP_ACCOUNTS = 100;

const HOUR_MS = 3_600_000;

/**
 * mulberry32, seeded from a hex digest.
 *
 * The fourth copy of this generator in the codebase, and copied for the reason
 * `driver-scrape.ts` records against the third: the alternative is the account
 * sweep importing the LinkedIn scraper, which would drag Playwright's loader
 * and the seat vault into a module whose whole job is reading public web pages.
 * Six lines is the cheaper side of that trade.
 */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One draw in [0,1) from an arbitrary string. */
function seededUnit(seed: string): number {
  return seededRandom(createHash('sha256').update(seed).digest('hex'))();
}

/**
 * Seconds to wait before the NEXT account's fetch, drawn from 20-90s.
 *
 * Seeded exactly like `scrapeGapSeconds`, and for the same reason: randomised
 * here means UNPREDICTABLE TO THE SITE, not unreproducible to us. A fixed 30s
 * gap is a signature any log aggregator can pick out of a week of traffic;
 * `Math.random()` would hide the pattern but also make the pacing unassertable,
 * so an identical seed gives an identical gap on every machine and Node
 * version, and the test below can prove the sweep is actually paced.
 *
 * The band is lower than LinkedIn's 30-120s because the surface is different: a
 * handful of ordinary GETs against a company's own public marketing site is not
 * an authenticated session being automated. It is still a gap, because twenty
 * accounts swept back to back is a burst from one address whatever the pages.
 */
export function sweepGapSeconds(seed: string): number {
  return SWEEP_GAP_SECONDS.min + seededUnit(seed) * (SWEEP_GAP_SECONDS.max - SWEEP_GAP_SECONDS.min);
}

/**
 * Which rung of the failure ladder this account is on.
 *
 * ONE BIT OF STATE PLUS THE CLOCK, rather than a retry counter nobody else
 * would maintain. `sweep_error` is null after every success and non-null after
 * every failure, so a set error means "this is not the first time". How far up
 * the ladder we already were is then read off `last_swept_at`, which the claim
 * deliberately does not touch: the previous attempt scheduled itself
 * `last_swept_at + rung`, and we are being run at or after that moment, so the
 * elapsed time IS the rung we last chose.
 *
 * A worker that was down for a day makes the elapsed time longer than any rung,
 * which lands on 24h. That is the conservative direction and the right one: an
 * account nobody has managed to read all week is not the one to hammer first
 * when the worker comes back.
 */
export function sweepBackoffHours(account: Pick<Account, 'sweepError' | 'lastSweptAt'>, now: Date): number {
  if (!account.sweepError) return SWEEP_BACKOFF_HOURS[0];
  const last = account.lastSweptAt === null ? null : Date.parse(account.lastSweptAt);
  // A failing account with no readable last attempt starts on the MIDDLE rung,
  // never back at the bottom: it has already failed at least once.
  if (last === null || Number.isNaN(last)) return SWEEP_BACKOFF_HOURS[1];
  const waitedHours = (now.getTime() - last) / HOUR_MS;
  if (waitedHours < SWEEP_BACKOFF_HOURS[1] - 2) return SWEEP_BACKOFF_HOURS[1];
  return SWEEP_BACKOFF_HOURS[2];
}

/**
 * When this account should be looked at next.
 *
 * A success is a day away, jittered by up to half an hour either side and
 * seeded from the account and the moment -- so a workspace imported in one CSV
 * does not spend the rest of its life sweeping all 500 domains inside the same
 * minute every night. A failure takes its rung off the ladder, unjittered:
 * backoff is a decision about patience and blurring it buys nothing.
 */
export function nextSweepAt(account: Pick<Account, 'id' | 'sweepError' | 'lastSweptAt'>, now: Date, error: string | null): Date {
  if (error !== null) return new Date(now.getTime() + sweepBackoffHours(account, now) * HOUR_MS);
  const drift = (seededUnit(`${account.id}:${now.toISOString()}`) * 2 - 1) * SWEEP_JITTER_SECONDS;
  return new Date(now.getTime() + SWEEP_INTERVAL_HOURS * HOUR_MS + Math.round(drift) * 1_000);
}

/* ---------------------------------------------------------------------------
 * Storing what was seen.
 * ------------------------------------------------------------------------ */

/** One observed change, as the caller read it, before it is a row. */
export interface IncomingSignal {
  kind: string;
  detail: string;
  previous: string | null;
  current: string | null;
  /** The page it was read from. A signal without one is dropped -- see below. */
  evidenceUrl: string;
  /** When the change was OBSERVED. Defaults to `now`. */
  observedAt?: Date;
}

/**
 * Write the signals this account has not already recorded, and return only
 * those.
 *
 * ONE STATEMENT, NOT ONE PER SIGNAL. A sweep of 25 accounts emitting five
 * signals each is 125 round trips done the naive way, and the whole point of
 * the pass is that it is cheap enough to run every day.
 *
 * A SIGNAL WITH NO EVIDENCE URL IS DROPPED, NOT STORED WITH A BLANK. Migration
 * 039 makes `evidence_url` NOT NULL for exactly this reason: the sentence an
 * operator sends is only worth sending because the recipient can check it, and
 * a row saying "they changed their pricing" with nothing to click is a claim
 * wearing a signal's clothes. Storing it with '' would satisfy the column and
 * defeat the constraint -- the scorer would count it, the screen would render
 * an empty link, and nobody would find out until a founder pasted it into an
 * email. `gtm.watch-signal` legitimately produces evidence-less signals (a
 * hiring change discovered before the careers URL was resolvable, say), so this
 * is an expected path, not a defensive one.
 *
 * `ON CONFLICT DO NOTHING` on the dedupe index does the collapsing, and
 * `RETURNING` therefore names exactly the rows that were new -- which is what
 * the caller needs to decide whether this account is worth rescoring.
 */
export async function recordSignals(
  db: Db,
  workspaceId: string,
  accountId: string,
  incoming: readonly IncomingSignal[],
  now: Date = new Date()
): Promise<AccountSignal[]> {
  if (incoming.length === 0) return [];
  const iso = now.toISOString();

  // Deduped in memory as well as in the index. The index would swallow a
  // repeated tuple anyway, but a batch that carries the same fingerprint twice
  // is a batch whose `RETURNING` count depends on statement-internal conflict
  // handling, and this function's contract is "the rows actually written".
  const seen = new Set<string>();
  const keep: Array<IncomingSignal & { fingerprint: string }> = [];
  for (const signal of incoming) {
    if (!signal.evidenceUrl || !signal.evidenceUrl.trim()) continue;
    const fingerprint = signalFingerprint(signal.kind, signal.previous, signal.current);
    const key = `${signal.kind} ${fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push({ ...signal, fingerprint });
  }
  if (keep.length === 0) return [];

  const rows = await db.prepare(`
    INSERT INTO account_signals (${SIGNAL_COLUMNS})
    SELECT * FROM unnest(
      ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
      ?::text[], ?::timestamptz[], ?::text[], ?::timestamptz[]
    )
    ON CONFLICT (workspace_id, account_id, kind, fingerprint) DO NOTHING
    RETURNING ${SIGNAL_COLUMNS}
  `).all<SignalRow>(
    keep.map(() => id('asig')),
    keep.map(() => workspaceId),
    keep.map(() => accountId),
    keep.map((signal) => signal.kind),
    keep.map((signal) => signal.detail),
    keep.map((signal) => signal.previous),
    keep.map((signal) => signal.current),
    keep.map((signal) => signal.evidenceUrl.trim()),
    keep.map((signal) => (signal.observedAt ?? now).toISOString()),
    keep.map((signal) => signal.fingerprint),
    keep.map(() => iso)
  );
  return rows.map(toSignal);
}

/* ---------------------------------------------------------------------------
 * Claiming what is due.
 * ------------------------------------------------------------------------ */

/**
 * Take up to `limit` accounts that are due, oldest first, and lease them.
 *
 * CLAIM AND SELECT IN ONE STATEMENT, with `FOR UPDATE SKIP LOCKED`, exactly as
 * `claimLeadSource` and `claimNextDueAction` do. There is no second idempotency
 * mechanism in this codebase and there must not be one here: two workers on the
 * same box take different accounts instead of both fetching the same company's
 * careers page a second apart, which is the one behaviour a site owner would
 * reasonably call abuse.
 *
 * THE LEASE IS WHY `next_sweep_at` MOVES BEFORE A BYTE IS FETCHED. If the
 * process dies mid-sweep, nothing writes the outcome -- and an unclaimed row
 * whose `next_sweep_at` is still in the past is claimed again on the next tick,
 * and the next, forever. A crash is indistinguishable from a failure from the
 * outside, so the lease is the first rung of the failure ladder: two hours,
 * after which a crashed sweep retries exactly like a failed one.
 *
 * ONLY 'active'. A `not_a_fit` account is kept but never swept -- the operator
 * has said no, and continuing to fetch their site is both rude and pointless.
 */
export async function claimDueAccounts(db: Db, workspaceId: string, now: Date, limit: number): Promise<Account[]> {
  const take = Math.max(1, Math.min(HARD_MAX_SWEEP_ACCOUNTS, Math.trunc(limit)));
  const iso = now.toISOString();
  const lease = new Date(now.getTime() + SWEEP_BACKOFF_HOURS[0] * HOUR_MS).toISOString();
  const rows = await db.prepare(`
    UPDATE accounts SET next_sweep_at=?, updated_at=?
    WHERE id IN (
      SELECT id FROM accounts
      WHERE workspace_id=? AND status='active' AND (next_sweep_at IS NULL OR next_sweep_at <= ?)
      ORDER BY next_sweep_at ASC NULLS FIRST, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    )
    RETURNING ${ACCOUNT_COLUMNS}
  `).all<AccountRow>(lease, iso, workspaceId, iso, take);
  // Ordered again in memory: `UPDATE ... RETURNING` makes no promise about row
  // order, and the pacing seed and the caller's rescore list both read better
  // in the order the queue actually meant.
  return rows
    .map(toAccount)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/* ---------------------------------------------------------------------------
 * Sweeping one account.
 * ------------------------------------------------------------------------ */

export interface SweepDeps {
  now?: () => Date;
  /** Injection seam for tests; supplying it also disables DNS in the SSRF guard. */
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
}

export interface SweepAccountResult {
  signals: AccountSignal[];
  error: string | null;
}

/**
 * Did this capture read anything at all?
 *
 * All four fields null means the homepage returned no usable HTML -- the host
 * did not resolve, timed out, or answered with something that is not a page.
 * That is a FAILURE, not a first capture of a site with nothing on it: storing
 * `first-capture: nothing readable` would put a scoreable row on an account we
 * never actually saw, and the operator would read it as evidence.
 *
 * `tech: []` (captured, matched nothing) is deliberately NOT null here -- the
 * whole distinction `signal.ts` is built on.
 */
function capturedNothing(snapshot: ResearchSnapshot): boolean {
  return snapshot.headline === null && snapshot.tech === null && snapshot.jobCount === null && snapshot.pricingHash === null;
}

/** One sentence an operator can act on, bounded so a stack trace cannot fill the column. */
function describeFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const clean = message.replace(/\s+/g, ' ').trim();
  return (clean || 'The sweep failed and said nothing about why.').slice(0, 500);
}

/**
 * Sweep one account: capture, diff, store, re-schedule.
 *
 * NEVER THROWS. A dead host, a domain that no longer resolves, a site behind a
 * WAF that answers 403 to everything -- all of them are ordinary facts about an
 * account list of any age, and every one of them lands in `sweep_error` where
 * the operator can see it. A cycle that crashed on the first bad domain would
 * leave every account after it in the queue unswept, which is how a list goes
 * quietly stale while the worker reports itself healthy.
 *
 * The network is entirely `watchSignals`: it loads the previous snapshot,
 * captures a new one, diffs them under its own null rules, and persists the
 * capture whatever the diff said. What this function adds is the account
 * spine -- turning those signals into deduped, evidence-bearing rows, and
 * deciding when to look again.
 */
export async function sweepAccount(db: Db, account: Account, deps: SweepDeps = {}): Promise<SweepAccountResult> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock();
  let signals: AccountSignal[] = [];
  let error: string | null = null;

  try {
    const ctx: SkillContext = { db, workspaceId: account.workspaceId, now: clock };
    const watched = await watchSignals(account.domain, ctx, { fetchImpl: deps.fetchImpl, now: startedAt });
    if (capturedNothing(watched.snapshot)) {
      error = `Nothing could be read from https://${watched.domain}: the homepage returned no usable page.`;
    } else {
      const observedAt = new Date(watched.snapshot.capturedAt);
      signals = await recordSignals(
        db,
        account.workspaceId,
        account.id,
        watched.signals.map((signal, index) => ({
          kind: signal.kind,
          detail: signal.detail,
          previous: signal.previous,
          current: signal.current,
          // The skill already worked out which page each signal came off --
          // careers for hiring, the pricing page for pricing, the homepage for
          // the rest -- and it emits them index-aligned with the signals. A
          // null here means it could not name a page, and rule 3 applies.
          evidenceUrl: watched.evidence[index]?.sourceUrl ?? '',
          observedAt: Number.isNaN(observedAt.getTime()) ? startedAt : observedAt
        })),
        startedAt
      );
    }
  } catch (cause) {
    error = describeFailure(cause);
  }

  const finishedAt = clock();
  const next = nextSweepAt(account, finishedAt, error);
  await db.prepare(`
    UPDATE accounts SET last_swept_at=?, next_sweep_at=?, sweep_error=?, updated_at=?
    WHERE workspace_id=? AND id=?
  `).run(finishedAt.toISOString(), next.toISOString(), error, finishedAt.toISOString(), account.workspaceId, account.id);

  deps.log?.(
    error === null
      ? `Swept ${account.domain}: ${signals.length} new signal(s), next look ${next.toISOString()}.`
      : `Sweep of ${account.domain} failed: ${error} Next attempt ${next.toISOString()}.`
  );
  return { signals, error };
}

/* ---------------------------------------------------------------------------
 * One pass over a workspace.
 * ------------------------------------------------------------------------ */

export interface AccountSweepDeps extends SweepDeps {
  /** Defaults to a real timer. Injected so a test never waits 90 seconds. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AccountSweepResult {
  swept: number;
  signalsStored: number;
  failed: number;
  /**
   * Every account this pass touched, failures included. The caller rescores
   * these; the sweep does not, because "we looked" and "we judged" are two
   * decisions and folding them together makes a scorer bug a sweep outage.
   */
  accountIds: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Claim and sweep this workspace's due accounts, paced.
 *
 * BOUNDED, ALWAYS. One pass is finite by construction -- 25 accounts by
 * default, 100 however loudly a caller asks -- because a pass is a sequence of
 * paced network reads and "sweep everything" is a request for a worker that
 * never returns. Whatever is left stays due and is claimed on the next tick.
 *
 * PACED BETWEEN ACCOUNTS, NOT WITHIN ONE. `signal.ts` already bounds a single
 * account to a handful of pages against one host; the burst worth avoiding is
 * the one visible from outside -- twenty different companies read from the same
 * address inside a second, which is a crawler's traffic shape whatever the
 * intent behind it.
 */
export async function runAccountSweep(
  db: Db,
  workspaceId: string,
  deps: AccountSweepDeps = {},
  opts: { maxAccounts?: number } = {}
): Promise<AccountSweepResult> {
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const limit = Math.max(1, Math.min(HARD_MAX_SWEEP_ACCOUNTS, Math.trunc(opts.maxAccounts ?? DEFAULT_SWEEP_ACCOUNTS)));

  const due = await claimDueAccounts(db, workspaceId, clock(), limit);
  const result: AccountSweepResult = { swept: 0, signalsStored: 0, failed: 0, accountIds: [] };

  for (let index = 0; index < due.length; index += 1) {
    const account = due[index];
    // Before the fetch, not after it: a gap after the last account would only
    // delay the caller. Seeded on the account so the same queue paces the same
    // way twice, which is what makes the pacing assertable.
    if (index > 0) await sleep(Math.round(sweepGapSeconds(account.id) * 1_000));
    const outcome = await sweepAccount(db, account, { now: clock, fetchImpl: deps.fetchImpl, log: deps.log });
    result.swept += 1;
    result.signalsStored += outcome.signals.length;
    if (outcome.error !== null) result.failed += 1;
    result.accountIds.push(account.id);
  }
  return result;
}
