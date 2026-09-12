import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { upsertContentOpportunity } from './opportunities.js';
import type { ContentEvidenceRef, ContentOpportunity } from './types.js';

const STORY_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_EVIDENCE = 6;

function iso(value: unknown): string {
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

function fingerprint(accountId: string, evidence: ContentEvidenceRef[]): string {
  const facts = evidence.map((item) => `${item.sourceType}:${item.sourceId}`).sort();
  return `company_change:${createHash('sha256')
    .update(JSON.stringify([accountId, facts]))
    .digest('hex')
    .slice(0, 24)}`;
}

function kindLabel(kind: string): string {
  return kind.replaceAll('-', ' ').replaceAll('_', ' ');
}

/**
 * Turn source-backed account movement into a publishable story candidate.
 *
 * No LLM and no network. A score may rank the story, but it may not become a
 * claim: every factual sentence available to downstream drafting is carried in
 * the immutable signal snapshots below with URL + observed timestamp.
 */
export async function buildCompanyChangeOpportunities(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<ContentOpportunity[]> {
  const since = new Date(now.getTime() - STORY_WINDOW_DAYS * DAY_MS).toISOString();
  const accounts = await db
    .prepare(
      `SELECT a.id,a.name,a.domain,s.score,s.tier,s.distinct_kinds,s.newest_signal_at,s.computed_at
       FROM account_scores s
       JOIN accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id
       WHERE s.workspace_id=? AND s.tier IN ('hot','warm') AND s.distinct_kinds>=2
         AND COALESCE(s.newest_signal_at,s.computed_at)>=?::timestamptz
       ORDER BY s.score DESC,COALESCE(s.newest_signal_at,s.computed_at) DESC,a.id
       LIMIT 100`
    )
    .all<Record<string, unknown>>(workspaceId, since);

  const output: ContentOpportunity[] = [];
  for (const account of accounts) {
    const accountId = String(account.id);
    const signals = await db
      .prepare(
        `SELECT id,kind,detail,evidence_url,observed_at
         FROM account_signals
         WHERE workspace_id=? AND account_id=? AND kind<>'first-capture'
           AND evidence_url IS NOT NULL AND NULLIF(BTRIM(evidence_url),'') IS NOT NULL
           AND observed_at>=?::timestamptz
         ORDER BY observed_at DESC,id DESC LIMIT ?`
      )
      .all<Record<string, unknown>>(workspaceId, accountId, since, MAX_EVIDENCE);
    const distinctKinds = new Set(signals.map((row) => String(row.kind)));
    if (signals.length < 2 || distinctKinds.size < 2) continue;

    const evidence: ContentEvidenceRef[] = signals.map((row) => ({
      sourceType: 'account_signal',
      sourceId: String(row.id),
      label: kindLabel(String(row.kind)),
      detail: String(row.detail),
      sourceUrl: String(row.evidence_url),
      observedAt: iso(row.observed_at)
    }));
    const accountName = String(account.name ?? account.domain ?? 'Account');
    const labels = [...distinctKinds].slice(0, 3).map(kindLabel);
    const newest = evidence
      .map((item) => item.observedAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
    const score = Math.max(0, Math.min(100, Number(account.score ?? 0)));
    output.push(
      await upsertContentOpportunity(
        db,
        {
          workspaceId,
          status: 'ready',
          kind: 'company_change',
          title: `${accountName}: ${labels.join(' + ')}`,
          thesis: `${accountName} shows ${distinctKinds.size} independent, recent changes worth explaining together.`,
          audience: null,
          freshnessAt: newest,
          score,
          rationale: [
            `${distinctKinds.size} independent account-signal kinds are present`,
            `${evidence.length} source-backed facts are available`,
            `existing account intent is ${String(account.tier)} at ${score}/100`
          ],
          evidence,
          fingerprint: fingerprint(accountId, evidence)
        },
        now
      )
    );
  }
  return output;
}
