/**
 * The account spine's shared vocabulary.
 *
 * Types only. Every module under `accounts/` imports from here and nothing
 * here imports from them, so the store, the sweep, the scorer and the API can
 * be built and reviewed against one another's shapes rather than one another's
 * source. Migration 039 is the other half of this contract; the field comments
 * live there, next to the columns, and are not repeated.
 */

export type AccountSource = 'csv' | 'sourced' | 'linkedin' | 'manual';
export type AccountStatus = 'active' | 'not_a_fit' | 'archived';
export type AccountTier = 'hot' | 'warm' | 'cold';

/**
 * The signal vocabulary the scorer knows how to weigh.
 *
 * Site diffs are `gtm.watch-signal`'s own `SignalKind` values, carried across
 * unchanged so there is no translation table to drift. `thread-mention` is the
 * public-commentary signal from `gtm.scout-threads`. Anything not in this union
 * is stored but scored at zero -- an unknown signal must never silently vanish
 * and must never silently count.
 */
export const ACCOUNT_SIGNAL_KINDS = [
  'first-capture',
  'hiring-up',
  'hiring-down',
  'pricing-changed',
  'headline-changed',
  'tech-added',
  'tech-removed',
  'thread-mention'
] as const;

export type AccountSignalKind = (typeof ACCOUNT_SIGNAL_KINDS)[number];

export interface Account {
  id: string;
  workspaceId: string;
  name: string;
  domain: string;
  linkedinUrl: string | null;
  source: AccountSource;
  tags: string[];
  status: AccountStatus;
  icpNote: string | null;
  lastSweptAt: string | null;
  nextSweepAt: string | null;
  sweepError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSignal {
  id: string;
  workspaceId: string;
  accountId: string;
  kind: AccountSignalKind | string;
  detail: string;
  previous: string | null;
  current: string | null;
  evidenceUrl: string;
  observedAt: string;
  fingerprint: string;
  createdAt: string;
}

/** One line of a score's arithmetic, as the screen renders it. */
export interface ScoreComponent {
  kind: AccountSignalKind | string;
  /** The signal's own words, so "why this score" needs no second query. */
  detail: string;
  evidenceUrl: string;
  observedAt: string;
  /** Age in days at scoring time, rounded down. */
  ageDays: number;
  /** Base weight for the kind, before decay. */
  base: number;
  /** Multiplier in [0,1] from recency decay. */
  decay: number;
  /** `base * decay`, rounded to one decimal. What this signal actually added. */
  points: number;
}

export interface ScoreRationale {
  components: ScoreComponent[];
  /** Pairs of distinct kinds that co-occurred inside the window, with the bonus each earned. */
  combinations: { kinds: [string, string]; bonus: number; why: string }[];
  /** Negative adjustments: rejected shapes, stale-only evidence, missing corroboration. */
  penalties: { reason: string; points: number }[];
  /** The scoring window in days, echoed so an old rationale explains itself. */
  windowDays: number;
  /** One sentence, plain English, that a human could say out loud. */
  summary: string;
}

export interface AccountScore {
  workspaceId: string;
  accountId: string;
  score: number;
  tier: AccountTier;
  distinctKinds: number;
  newestSignalAt: string | null;
  rationale: ScoreRationale;
  computedAt: string;
}

/** An account joined to its current score and its most recent signals. The ranked-list row. */
export interface RankedAccount {
  account: Account;
  score: AccountScore | null;
  /** Newest first, capped by the caller. */
  signals: AccountSignal[];
}

export interface AccountFeedback {
  id: string;
  workspaceId: string;
  accountId: string;
  verdict: 'not_a_fit' | 'good_fit';
  reason: string | null;
  signalShape: string;
  scoreAtVerdict: number | null;
  createdAt: string;
}

/** One parsed line of an import, before it becomes a row. */
export interface AccountImportRow {
  name: string;
  domain: string;
  linkedinUrl: string | null;
  tags: string[];
}

export interface AccountImportResult {
  /** Optional Person persistence summary when reviewed contact evidence accompanied the import. */
  people?: { created: number; matched: number; linked: number; skipped: number };
  /** Rows written. */
  created: number;
  /** Rows that matched an existing account on domain and were left alone. */
  duplicate: number;
  /** Lines that produced no usable domain, with the line and why, capped for display. */
  rejected: { line: string; reason: string }[];
  accounts: Account[];
}
