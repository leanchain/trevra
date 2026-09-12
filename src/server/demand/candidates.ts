import type { Db } from '../db.js';

export type DemandQualification = 'act_now' | 'watch' | 'ignore';
export type DemandRecommendedAction =
  'reply' | 'prepare_outreach' | 'find_person' | 'qualify' | 'watch';

export interface DemandEvidence {
  sourceType: 'inbound_submission' | 'account_score' | 'account_signal';
  sourceId: string;
  label: string;
  category: 'request' | 'history' | 'supporting';
  excerpt: string;
  externalUrl?: string | null;
  observedAt: string;
}

export interface DemandDimensions {
  /** Unknown until a workspace-specific ICP fitter exists. Never fake a fit score. */
  fit: number | null;
  /** Existing composite account score, normalized to 0..1. */
  accountIntent: number;
  /** Reserved for person-level public/content engagement. V1 has no such evidence. */
  personIntent: number;
  /** Explicit first-party action strength, normalized to 0..1. */
  firstPartyIntent: number;
  /** Existing verified commercial relationship strength. V1 leaves this at zero. */
  relationship: number;
  /** Freshness of the newest first-party event, normalized to 0..1. */
  recency: number;
}

export interface DemandCandidate {
  sourceKey: string;
  personId: string;
  accountId: string;
  personName: string;
  accountName: string;
  dimensions: DemandDimensions;
  qualification: DemandQualification;
  recommendedAction: DemandRecommendedAction;
  title: string;
  summary: string;
  rationale: string[];
  evidence: DemandEvidence[];
}

const DAY_MS = 86_400_000;
const FIRST_PARTY_WINDOW_DAYS = 14;
const SIGNAL_WINDOW_DAYS = 60;
const MAX_ACCOUNT_SIGNAL_EVIDENCE = 4;

/**
 * First-party kinds are deliberately a small heuristic, not a universal event
 * taxonomy. Unknown kinds remain useful evidence but get a conservative value.
 */
function firstPartyStrength(kind: string): number {
  switch (kind.trim().toLowerCase()) {
    case 'demo_request':
    case 'pilot_request':
    case 'enterprise_pilot_request':
    case 'pricing_enquiry':
      return 1;
    case 'scan_completed':
    case 'diagnostic_completed':
    case 'trial_started':
      return 0.9;
    case 'contact_message':
      return 0.8;
    default:
      return 0.7;
  }
}

function recencyFor(observedAt: string, now: Date): number {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (now.getTime() - parsed) / DAY_MS);
  return Number(Math.max(0, 1 - ageDays / FIRST_PARTY_WINDOW_DAYS).toFixed(3));
}

function iso(value: unknown): string {
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

/**
 * Build the founder-facing commercial candidates that exist *between* raw
 * evidence and a persisted recommendation.
 *
 * V1 intentionally has one high-precision rule only: explicit recent inbound
 * from a canonical Person at an explicitly linked Account whose independent
 * account scorer already says `hot`. The account score is not recomputed here;
 * the actual source-backed account signals are loaded solely so the candidate
 * can explain why the account was hot.
 *
 * This is a projection, not another Lead table. Re-running it is safe and does
 * not mutate business state.
 */
export async function buildDemandCandidates(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<DemandCandidate[]> {
  const recentSince = new Date(now.getTime() - FIRST_PARTY_WINDOW_DAYS * DAY_MS).toISOString();
  const signalSince = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * DAY_MS).toISOString();

  const rows = await db
    .prepare(
      `
      SELECT DISTINCT ON (s.contact_id,s.account_id)
        s.id AS submission_id,
        s.contact_id AS person_id,
        s.account_id,
        s.kind AS submission_kind,
        s.message,
        s.page_url,
        s.received_at,
        p.name AS person_name,
        p.email AS person_email,
        a.name AS account_name,
        a.domain,
        sc.score,
        sc.distinct_kinds,
        sc.newest_signal_at
      FROM inbound_submissions s
      JOIN contacts p
        ON p.workspace_id=s.workspace_id AND p.id=s.contact_id
      JOIN accounts a
        ON a.workspace_id=s.workspace_id AND a.id=s.account_id
      JOIN account_scores sc
        ON sc.workspace_id=s.workspace_id AND sc.account_id=s.account_id
      WHERE s.workspace_id=?
        AND s.account_id IS NOT NULL
        AND s.received_at>=?::timestamptz
        AND sc.tier='hot'
      ORDER BY s.contact_id,s.account_id,s.received_at DESC,s.id DESC
    `
    )
    .all<Record<string, unknown>>(workspaceId, recentSince);

  const candidates: DemandCandidate[] = [];
  for (const row of rows) {
    const personId = String(row.person_id);
    const accountId = String(row.account_id);
    const submissionId = String(row.submission_id);
    const submissionKind = String(row.submission_kind ?? 'inbound');
    const receivedAt = iso(row.received_at);
    const score = Math.max(0, Math.min(100, Number(row.score ?? 0)));
    const distinctKinds = Math.max(0, Number(row.distinct_kinds ?? 0));
    const personName = String(row.person_name ?? row.person_email ?? 'Known person');
    const accountName = String(row.account_name ?? row.domain ?? 'Account');

    const signals = await db
      .prepare(
        `
        SELECT id,kind,detail,evidence_url,observed_at
        FROM account_signals
        WHERE workspace_id=? AND account_id=?
          AND kind<>'first-capture'
          AND observed_at>=?::timestamptz
        ORDER BY observed_at DESC,id DESC
        LIMIT ?
      `
      )
      .all<Record<string, unknown>>(
        workspaceId,
        accountId,
        signalSince,
        MAX_ACCOUNT_SIGNAL_EVIDENCE
      );

    // A hot score is required above, and a hot score itself already requires
    // independent signal kinds. Still refuse a proof pack with no source rows:
    // a score without inspectable evidence is not enough to tell a founder to act.
    if (signals.length === 0) continue;

    const firstPartyIntent = firstPartyStrength(submissionKind);
    const recency = recencyFor(receivedAt, now);
    const dimensions: DemandDimensions = {
      fit: null,
      accountIntent: Number((score / 100).toFixed(3)),
      personIntent: 0,
      firstPartyIntent,
      relationship: 0,
      recency
    };

    const evidence: DemandEvidence[] = [
      {
        sourceType: 'inbound_submission',
        sourceId: submissionId,
        label: `First-party ${submissionKind.replaceAll('_', ' ')}`,
        category: 'request',
        excerpt:
          String(row.message ?? '').trim() ||
          `${personName} submitted a ${submissionKind.replaceAll('_', ' ')}.`,
        externalUrl: row.page_url ? String(row.page_url) : null,
        observedAt: receivedAt
      },
      {
        sourceType: 'account_score',
        sourceId: accountId,
        label: 'Composite account intent',
        category: 'supporting',
        excerpt: `${accountName} is hot at ${score}/100 across ${distinctKinds} independent signal kinds.`,
        observedAt: iso(row.newest_signal_at ?? receivedAt)
      },
      ...signals.map<DemandEvidence>((signal) => ({
        sourceType: 'account_signal',
        sourceId: String(signal.id),
        label: String(signal.kind).replaceAll('-', ' '),
        category: 'supporting',
        excerpt: String(signal.detail),
        externalUrl: String(signal.evidence_url),
        observedAt: iso(signal.observed_at)
      }))
    ];

    const firstPartyLabel = submissionKind.replaceAll('_', ' ');
    const signalSummary = signals
      .slice(0, 2)
      .map((signal) => String(signal.detail).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');

    candidates.push({
      sourceKey: `demand:${personId}:${accountId}`,
      personId,
      accountId,
      personName,
      accountName,
      dimensions,
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      title: `Talk to ${personName} at ${accountName}`,
      summary: `${personName}: ${firstPartyLabel}. ${accountName}: ${score}/100 account intent${signalSummary ? ` · ${signalSummary}` : ''}`,
      rationale: [
        `${submissionKind.replaceAll('_', ' ')} is explicit first-party intent`,
        `account scorer is hot at ${score}/100 across ${distinctKinds} signal kinds`,
        `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
      ],
      evidence
    });
  }

  return candidates;
}
