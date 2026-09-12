import type { Db } from '../db.js';
import type { MarketPulseDays } from './pulse.js';

const DAY_MS = 86_400_000;
const MAX_ROWS = 50;
const MAX_EVIDENCE_PER_ROW = 10;

export interface MarketIndexEvidence {
  kind: string;
  detail: string;
  sourceUrl: string;
  observedAt: string;
}

export interface MarketIndexComponents {
  diversity: number;
  activity: number;
  recency: number;
}

export interface MarketIndexRow {
  rank: number;
  accountName: string;
  score: number;
  distinctKinds: number;
  signalCount: number;
  newestAt: string;
  components: MarketIndexComponents;
  evidence: MarketIndexEvidence[];
}

export interface AccountMomentumIndex {
  scopeLabel: string;
  days: MarketPulseDays;
  from: string;
  to: string;
  accountCount: number;
  scoredAccountCount: number;
  rows: MarketIndexRow[];
  canPublish: boolean;
  publishBlocker: string | null;
  formula: string[];
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function scopeSql(tag: string | null, alias = 'a'): { clause: string; params: unknown[] } {
  if (!tag) return { clause: '', params: [] };
  return {
    clause: ` AND EXISTS (SELECT 1 FROM unnest(${alias}.tags) index_tag WHERE LOWER(index_tag)=LOWER(?))`,
    params: [tag]
  };
}

function scopeLabel(tag: string | null): string {
  return tag ? `Accounts tagged “${tag}”` : 'Active account watchlist';
}

function recencyPoints(newestAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - newestAt.getTime()) / DAY_MS);
  if (ageDays <= 3) return 20;
  if (ageDays <= 7) return 15;
  if (ageDays <= 14) return 10;
  return 5;
}

/**
 * Explainable momentum ranking over source-backed Account changes.
 * Every point comes from a visible component; there is no model score.
 */
export async function compileAccountMomentumIndex(
  db: Db,
  workspaceId: string,
  input: { days?: MarketPulseDays; tag?: string | null } = {},
  now: Date = new Date()
): Promise<AccountMomentumIndex> {
  const days = input.days ?? 30;
  const tag = input.tag?.trim() || null;
  const toDate = dayStartUtc(now);
  const fromDate = new Date(toDate.getTime() - days * DAY_MS);
  const from = fromDate.toISOString();
  const to = new Date(toDate.getTime() + DAY_MS).toISOString();
  const scope = scopeSql(tag);

  const accountCount = await db
    .prepare(
      `SELECT COUNT(*)::int AS count FROM accounts a WHERE a.workspace_id=? AND a.status='active'${scope.clause}`
    )
    .get<{ count: number }>(workspaceId, ...scope.params);

  const aggregates = await db
    .prepare(
      `SELECT a.id,a.name,COUNT(s.id)::int AS signal_count,
              COUNT(DISTINCT s.kind)::int AS distinct_kinds,MAX(s.observed_at) AS newest_at
       FROM accounts a
       JOIN account_signals s
         ON s.workspace_id=a.workspace_id AND s.account_id=a.id
        AND s.kind<>'first-capture'
        AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
        AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz
       WHERE a.workspace_id=? AND a.status='active'${scope.clause}
       GROUP BY a.id,a.name`
    )
    .all<Record<string, unknown>>(from, to, workspaceId, ...scope.params);

  const evidenceByAccount = new Map<string, MarketIndexEvidence[]>();
  const accountIds = aggregates.map((row) => String(row.id));
  if (accountIds.length > 0) {
    const signals = await db
      .prepare(
        `SELECT s.account_id,s.kind,s.detail,s.evidence_url,s.observed_at
         FROM account_signals s
         WHERE s.workspace_id=? AND s.account_id=ANY(?)
           AND s.kind<>'first-capture'
           AND s.evidence_url IS NOT NULL AND NULLIF(BTRIM(s.evidence_url),'') IS NOT NULL
           AND s.observed_at>=?::timestamptz AND s.observed_at<?::timestamptz
         ORDER BY s.account_id,s.observed_at DESC,s.id DESC`
      )
      .all<Record<string, unknown>>(workspaceId, accountIds, from, to);
    for (const signal of signals) {
      const accountId = String(signal.account_id);
      const current = evidenceByAccount.get(accountId) ?? [];
      if (current.length >= MAX_EVIDENCE_PER_ROW) continue;
      current.push({
        kind: String(signal.kind),
        detail: String(signal.detail),
        sourceUrl: String(signal.evidence_url),
        observedAt: new Date(String(signal.observed_at)).toISOString()
      });
      evidenceByAccount.set(accountId, current);
    }
  }

  const scored = aggregates
    .map((row) => {
      const distinctKinds = Number(row.distinct_kinds ?? 0);
      const signalCount = Number(row.signal_count ?? 0);
      const newestAt = new Date(String(row.newest_at));
      const components: MarketIndexComponents = {
        diversity: Math.min(50, distinctKinds * 20),
        activity: Math.min(30, signalCount * 6),
        recency: recencyPoints(newestAt, now)
      };
      return {
        accountId: String(row.id),
        accountName: String(row.name),
        score: components.diversity + components.activity + components.recency,
        distinctKinds,
        signalCount,
        newestAt: newestAt.toISOString(),
        components,
        evidence: evidenceByAccount.get(String(row.id)) ?? []
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.newestAt) - Date.parse(left.newestAt) ||
        left.accountName.localeCompare(right.accountName)
    )
    .slice(0, MAX_ROWS);

  const rows: MarketIndexRow[] = scored.map(({ accountId: _accountId, ...row }, index) => ({
    rank: index + 1,
    ...row
  }));
  const totalAccounts = Number(accountCount?.count ?? 0);
  const scoredAccountCount = aggregates.length;
  const canPublish = totalAccounts >= 3 && scoredAccountCount >= 3;
  const publishBlocker =
    totalAccounts < 3
      ? 'Add at least three active Accounts before publishing an index.'
      : scoredAccountCount < 3
        ? `Only ${scoredAccountCount} Accounts have source-backed changes in this ${days}-day window; Trevra requires at least three.`
        : null;

  return {
    scopeLabel: scopeLabel(tag),
    days,
    from,
    to,
    accountCount: totalAccounts,
    scoredAccountCount,
    rows,
    canPublish,
    publishBlocker,
    formula: [
      'Signal diversity: 20 points per distinct observed change kind, capped at 50.',
      'Source-backed activity: 6 points per observed change, capped at 30.',
      'Recency: 20 points when the newest change is ≤3 days old; 15 at ≤7 days; 10 at ≤14 days; otherwise 5 within the selected window.',
      'Total score is the sum of these three visible components, capped naturally at 100. First-capture baselines and observations without a source URL are excluded.'
    ]
  };
}
