import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { upsertContentOpportunity } from './opportunities.js';
import type { ContentEvidenceRef, ContentOpportunity } from './types.js';

const DAY_MS = 86_400_000;
const MAX_PATTERNS = 5;
const MAX_EXAMPLES_PER_PATTERN = 5;
const MAX_PUBLISHABLE_PATTERN_EVIDENCE = 100;

export type MarketPulseDays = 7 | 30;

export interface MarketPulseScope {
  type: 'accounts';
  tag: string | null;
}

export interface MarketPulseExample {
  accountId: string;
  accountName: string;
  signalId: string;
  kind: string;
  detail: string;
  sourceUrl: string;
  observedAt: string;
}

export interface MarketPulsePattern {
  kind: string;
  label: string;
  accountCount: number;
  signalCount: number;
  newestAt: string;
  examples: MarketPulseExample[];
}

export interface MarketPulse {
  scope: MarketPulseScope;
  scopeLabel: string;
  days: MarketPulseDays;
  from: string;
  to: string;
  accountCount: number;
  changedAccountCount: number;
  signalCount: number;
  patterns: MarketPulsePattern[];
  canDraft: boolean;
  draftBlocker: string | null;
}

function kindLabel(kind: string): string {
  return kind.replaceAll('-', ' ').replaceAll('_', ' ');
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function scopeSql(tag: string | null, alias = 'a'): { clause: string; params: unknown[] } {
  if (!tag) return { clause: '', params: [] };
  return {
    clause: ` AND EXISTS (SELECT 1 FROM unnest(${alias}.tags) pulse_tag WHERE LOWER(pulse_tag)=LOWER(?))`,
    params: [tag]
  };
}

function scopeLabel(tag: string | null): string {
  return tag ? `Accounts tagged “${tag}”` : 'Active account watchlist';
}

/**
 * Deterministic, network-free market summary over the operator's existing
 * Account watchlist. This is a read model, not a new Market entity.
 */
export async function compileAccountMarketPulse(
  db: Db,
  workspaceId: string,
  input: { days?: MarketPulseDays; tag?: string | null } = {},
  now: Date = new Date()
): Promise<MarketPulse> {
  const days = input.days ?? 7;
  const tag = input.tag?.trim() || null;
  const toDate = dayStartUtc(now);
  const fromDate = new Date(toDate.getTime() - days * DAY_MS);
  const from = fromDate.toISOString();
  const to = new Date(toDate.getTime() + DAY_MS).toISOString();
  const scope = scopeSql(tag);

  const accounts = await db
    .prepare(
      `SELECT COUNT(*)::int AS count FROM accounts a
       WHERE a.workspace_id=? AND a.status='active'${scope.clause}`
    )
    .get<{ count: number }>(workspaceId, ...scope.params);

  const totals = await db
    .prepare(
      `SELECT COUNT(*)::int AS signal_count,COUNT(DISTINCT s.account_id)::int AS changed_account_count
       FROM account_signals s
       JOIN accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id
       WHERE s.workspace_id=? AND a.status='active'
         AND s.kind<>'first-capture'
         AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
         AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz${scope.clause}`
    )
    .get<{ signal_count: number; changed_account_count: number }>(
      workspaceId,
      from,
      to,
      ...scope.params
    );

  const patternRows = await db
    .prepare(
      `SELECT s.kind,COUNT(*)::int AS signal_count,COUNT(DISTINCT s.account_id)::int AS account_count,
              MAX(s.observed_at) AS newest_at
       FROM account_signals s
       JOIN accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id
       WHERE s.workspace_id=? AND a.status='active'
         AND s.kind<>'first-capture'
         AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
         AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz${scope.clause}
       GROUP BY s.kind
       ORDER BY COUNT(DISTINCT s.account_id) DESC,COUNT(*) DESC,MAX(s.observed_at) DESC,s.kind
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, from, to, ...scope.params, MAX_PATTERNS);

  const kinds = patternRows.map((row) => String(row.kind));
  const examplesByKind = new Map<string, MarketPulseExample[]>();
  if (kinds.length > 0) {
    const exampleRows = await db
      .prepare(
        `SELECT * FROM (
           SELECT DISTINCT ON (s.kind,s.account_id)
             s.kind,s.id AS signal_id,s.account_id,s.detail,s.evidence_url,s.observed_at,
             a.name AS account_name,
             ROW_NUMBER() OVER (PARTITION BY s.kind ORDER BY s.observed_at DESC,s.id DESC) AS kind_rank
           FROM account_signals s
           JOIN accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id
           WHERE s.workspace_id=? AND a.status='active'
             AND s.kind=ANY(?)
             AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
             AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz${scope.clause}
           ORDER BY s.kind,s.account_id,s.observed_at DESC,s.id DESC
         ) latest
         ORDER BY kind,newest_at NULLS LAST`.replace(
          'newest_at NULLS LAST',
          'kind_rank,observed_at DESC'
        )
      )
      .all<Record<string, unknown>>(workspaceId, kinds, from, to, ...scope.params);
    for (const row of exampleRows) {
      const kind = String(row.kind);
      const current = examplesByKind.get(kind) ?? [];
      if (current.length >= MAX_EXAMPLES_PER_PATTERN) continue;
      current.push({
        accountId: String(row.account_id),
        accountName: String(row.account_name),
        signalId: String(row.signal_id),
        kind,
        detail: String(row.detail),
        sourceUrl: String(row.evidence_url),
        observedAt: iso(row.observed_at)
      });
      examplesByKind.set(kind, current);
    }
  }

  const patterns: MarketPulsePattern[] = patternRows.map((row) => ({
    kind: String(row.kind),
    label: kindLabel(String(row.kind)),
    accountCount: Number(row.account_count),
    signalCount: Number(row.signal_count),
    newestAt: iso(row.newest_at),
    examples: examplesByKind.get(String(row.kind)) ?? []
  }));
  const top = patterns[0] ?? null;
  const canDraft = Boolean(top && top.accountCount >= 2);
  const draftBlocker =
    Number(accounts?.count ?? 0) < 2
      ? 'Add at least two active Accounts to build a market pulse.'
      : !top
        ? `No source-backed account changes were observed in the last ${days} days.`
        : top.accountCount < 2
          ? 'The strongest pattern is still a single-company change; Trevra will not present it as a market pattern.'
          : null;

  return {
    scope: { type: 'accounts', tag },
    scopeLabel: scopeLabel(tag),
    days,
    from,
    to,
    accountCount: Number(accounts?.count ?? 0),
    changedAccountCount: Number(totals?.changed_account_count ?? 0),
    signalCount: Number(totals?.signal_count ?? 0),
    patterns,
    canDraft,
    draftBlocker
  };
}

async function publishablePatternEvidence(
  db: Db,
  workspaceId: string,
  pulse: MarketPulse
): Promise<ContentEvidenceRef[]> {
  const top = pulse.patterns[0];
  if (!top) return [];
  const scope = scopeSql(pulse.scope.tag);
  const rows = await db
    .prepare(
      `SELECT DISTINCT ON (s.account_id)
         s.id,s.kind,s.detail,s.evidence_url,s.observed_at,s.account_id,a.name AS account_name
       FROM account_signals s
       JOIN accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id
       WHERE s.workspace_id=? AND a.status='active' AND s.kind=?
         AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
         AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz${scope.clause}
       ORDER BY s.account_id,s.observed_at DESC,s.id DESC
       LIMIT ?`
    )
    .all<Record<string, unknown>>(
      workspaceId,
      top.kind,
      pulse.from,
      pulse.to,
      ...scope.params,
      MAX_PUBLISHABLE_PATTERN_EVIDENCE
    );
  return rows.map((row) => ({
    sourceType: 'account_signal' as const,
    sourceId: String(row.id),
    label: `${String(row.account_name)} · ${kindLabel(String(row.kind))}`,
    detail: String(row.detail),
    sourceUrl: String(row.evidence_url),
    observedAt: iso(row.observed_at)
  }));
}

function pulseFingerprint(pulse: MarketPulse, pattern: MarketPulsePattern): string {
  return `market_pulse:${createHash('sha256')
    .update(
      JSON.stringify([
        pulse.scope,
        pulse.days,
        pulse.from.slice(0, 10),
        pulse.to.slice(0, 10),
        pattern.kind
      ])
    )
    .digest('hex')
    .slice(0, 24)}`;
}

/** Materialize the strongest cross-account pulse pattern into the ordinary story pipeline. */
export async function materializeAccountMarketPulse(
  db: Db,
  workspaceId: string,
  input: { days?: MarketPulseDays; tag?: string | null } = {},
  now: Date = new Date()
): Promise<{ pulse: MarketPulse; opportunity: ContentOpportunity | null }> {
  const pulse = await compileAccountMarketPulse(db, workspaceId, input, now);
  const top = pulse.patterns[0];
  if (!pulse.canDraft || !top) return { pulse, opportunity: null };
  const evidence = await publishablePatternEvidence(db, workspaceId, pulse);
  if (evidence.length < 2) return { pulse, opportunity: null };

  const exact = top.accountCount <= MAX_PUBLISHABLE_PATTERN_EVIDENCE;
  const displayCount = exact ? String(top.accountCount) : `${MAX_PUBLISHABLE_PATTERN_EVIDENCE}+`;
  const period = pulse.days === 7 ? 'Weekly' : '30-day';
  const scopeSuffix = pulse.scope.tag ? ` · ${pulse.scope.tag}` : '';
  const title = `${period} market pulse${scopeSuffix}: ${top.label}`;
  const thesis = `${displayCount} companies in this watchlist showed ${top.label} during the last ${pulse.days} days.`;
  const score = Math.min(
    100,
    50 + Math.min(30, top.accountCount * 5) + Math.min(20, pulse.patterns.length * 4)
  );
  const opportunity = await upsertContentOpportunity(
    db,
    {
      workspaceId,
      status: 'ready',
      kind: 'market_pattern',
      title,
      thesis,
      audience: null,
      freshnessAt: top.newestAt,
      score,
      rationale: [
        `${top.accountCount} distinct Accounts contributed to the strongest pattern`,
        `${top.signalCount} source-backed ${top.label} signals were observed in the period`,
        `${pulse.changedAccountCount} of ${pulse.accountCount} watched Accounts had at least one source-backed change`,
        exact
          ? `all ${top.accountCount} contributing Accounts are represented in the publishable evidence set`
          : `the publishable claim is capped at ${MAX_PUBLISHABLE_PATTERN_EVIDENCE}+ Accounts and is backed by ${evidence.length} distinct Account sources`
      ],
      evidence,
      fingerprint: pulseFingerprint(pulse, top)
    },
    now
  );
  return { pulse, opportunity };
}
