import type { Db } from '../db.js';

export type DemandQualification = 'act_now' | 'watch' | 'ignore';
export type DemandRecommendedAction =
  'reply' | 'prepare_outreach' | 'find_person' | 'qualify' | 'watch';

export interface DemandEvidence {
  sourceType:
    | 'inbound_submission'
    | 'account_contact'
    | 'account_score'
    | 'account_signal'
    | 'campaign_brief';
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

async function loadAccountSignals(
  db: Db,
  workspaceId: string,
  accountId: string,
  signalSince: string
): Promise<Record<string, unknown>[]> {
  return db
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
    .all<Record<string, unknown>>(workspaceId, accountId, signalSince, MAX_ACCOUNT_SIGNAL_EVIDENCE);
}

function accountSignalEvidence(signals: Record<string, unknown>[]): DemandEvidence[] {
  return signals.map<DemandEvidence>((signal) => ({
    sourceType: 'account_signal',
    sourceId: String(signal.id),
    label: String(signal.kind).replaceAll('-', ' '),
    category: 'supporting',
    excerpt: String(signal.detail),
    externalUrl: String(signal.evidence_url),
    observedAt: iso(signal.observed_at)
  }));
}

interface BuyerPersona {
  campaignId: string;
  role: string;
  observedAt: string;
}

const ROLE_STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'of', 'the', 'to']);
const ROLE_ALIASES: Record<string, string[]> = {
  vp: ['vice', 'president'],
  svp: ['senior', 'vice', 'president'],
  evp: ['executive', 'vice', 'president'],
  cto: ['chief', 'technology', 'officer'],
  cio: ['chief', 'information', 'officer'],
  ciso: ['chief', 'information', 'security', 'officer'],
  ceo: ['chief', 'executive', 'officer'],
  cmo: ['chief', 'marketing', 'officer'],
  cro: ['chief', 'revenue', 'officer'],
  coo: ['chief', 'operating', 'officer']
};

function roleTokens(value: string): Set<string> {
  const raw = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const expanded = raw.flatMap((token) => ROLE_ALIASES[token] ?? [token]);
  return new Set(expanded.filter((token) => !ROLE_STOP_WORDS.has(token)));
}

/**
 * Conservative title similarity. It answers only whether a saved buyer role
 * clearly distinguishes one known contact from the others; it is not an ICP
 * or identity model. A weak/tied result returns no winner.
 */
function roleMatchScore(targetRole: string, candidateRole: string): number {
  const target = roleTokens(targetRole);
  const candidate = roleTokens(candidateRole);
  if (target.size === 0 || candidate.size === 0) return 0;
  if ([...target].every((token) => candidate.has(token)) && target.size === candidate.size)
    return 1;
  let overlap = 0;
  for (const token of target) if (candidate.has(token)) overlap += 1;
  if (overlap === 0) return 0;
  const targetCoverage = overlap / target.size;
  const candidateCoverage = overlap / candidate.size;
  return Number((targetCoverage * 0.7 + candidateCoverage * 0.3).toFixed(3));
}

async function loadBuyerPersona(db: Db, workspaceId: string): Promise<BuyerPersona | null> {
  const row = await db
    .prepare(
      `
      SELECT id,brief_json #>> '{icp,role}' AS role,created_at
      FROM linkedin_campaigns
      WHERE workspace_id=?
        AND NULLIF(BTRIM(brief_json #>> '{icp,role}'),'') IS NOT NULL
      ORDER BY created_at DESC,id DESC
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(workspaceId);
  if (!row) return null;
  const role = String(row.role ?? '').trim();
  return role ? { campaignId: String(row.id), role, observedAt: iso(row.created_at) } : null;
}

function selectKnownContact(
  rows: Record<string, unknown>[],
  persona: BuyerPersona | null
): { row: Record<string, unknown>; roleScore: number | null; usedPersona: boolean } | null {
  if (rows.length === 1) return { row: rows[0]!, roleScore: null, usedPersona: false };
  if (!persona) return null;

  const scored = rows
    .map((row) => {
      const role = String(row.association_role ?? row.person_role ?? '').trim();
      const roleScore = roleMatchScore(persona.role, role);
      const confidenceBonus = String(row.association_confidence) === 'verified' ? 0.03 : 0;
      return { row, roleScore, selectionScore: roleScore + confidenceBonus };
    })
    .sort((left, right) =>
      right.selectionScore !== left.selectionScore
        ? right.selectionScore - left.selectionScore
        : String(left.row.contact_id).localeCompare(String(right.row.contact_id))
    );

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.roleScore < 0.6) return null;
  if (runnerUp && best.selectionScore - runnerUp.selectionScore < 0.2) return null;
  return { row: best.row, roleScore: best.roleScore, usedPersona: true };
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
  const seenSourceKeys = new Set<string>();
  const firstPartyAccountIds = new Set<string>();
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

    const signals = await loadAccountSignals(db, workspaceId, accountId, signalSince);

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
      ...accountSignalEvidence(signals)
    ];

    const firstPartyLabel = submissionKind.replaceAll('_', ' ');
    const signalSummary = signals
      .slice(0, 2)
      .map((signal) => String(signal.detail).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');

    const sourceKey = `demand:${personId}:${accountId}`;
    candidates.push({
      sourceKey,
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
    seenSourceKeys.add(sourceKey);
    firstPartyAccountIds.add(accountId);
  }

  // Outbound counterpart: a hot account with deterministic known contacts.
  // One contact is safe to surface directly. With several, Trevra may choose
  // only when the operator's latest saved campaign ICP role clearly separates
  // one person from the rest. No persona or no clear margin means no guess.
  const buyerPersona = await loadBuyerPersona(db, workspaceId);
  const knownContactRows = await db
    .prepare(
      `
      WITH hot_accounts AS (
        SELECT
          a.id AS account_id,a.name AS account_name,a.domain,
          sc.score,sc.distinct_kinds,sc.newest_signal_at,sc.computed_at
        FROM account_scores sc
        JOIN accounts a ON a.workspace_id=sc.workspace_id AND a.id=sc.account_id
        WHERE sc.workspace_id=?
          AND sc.tier='hot'
          AND sc.score>=80
          AND COALESCE(sc.newest_signal_at,sc.computed_at)>=?::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM opportunities o
            WHERE o.workspace_id=sc.workspace_id
              AND o.account_id=sc.account_id
              AND o.stage NOT IN ('won','lost')
          )
        ORDER BY sc.score DESC,COALESCE(sc.newest_signal_at,sc.computed_at) DESC,a.id
        LIMIT 50
      )
      SELECT
        h.*,ac.id AS account_contact_id,ac.contact_id,
        ac.role AS association_role,ac.source AS association_source,
        ac.confidence AS association_confidence,ac.updated_at AS association_updated_at,
        p.name AS person_name,p.email AS person_email,p.role AS person_role
      FROM hot_accounts h
      JOIN account_contacts ac ON ac.account_id=h.account_id
      JOIN contacts p ON p.workspace_id=ac.workspace_id AND p.id=ac.contact_id
      WHERE ac.workspace_id=? AND ac.confidence IN ('explicit','verified')
      ORDER BY h.score DESC,COALESCE(h.newest_signal_at,h.computed_at) DESC,h.account_id,ac.id
    `
    )
    .all<Record<string, unknown>>(workspaceId, recentSince, workspaceId);

  const contactsByAccount = new Map<string, Record<string, unknown>[]>();
  for (const row of knownContactRows) {
    const accountId = String(row.account_id);
    const existing = contactsByAccount.get(accountId) ?? [];
    existing.push(row);
    contactsByAccount.set(accountId, existing);
  }

  for (const [accountId, rowsForAccount] of contactsByAccount) {
    if (firstPartyAccountIds.has(accountId)) continue;
    const selection = selectKnownContact(rowsForAccount, buyerPersona);
    if (!selection) continue;
    const row = selection.row;
    const personId = String(row.contact_id);
    const sourceKey = `demand:${personId}:${accountId}`;
    if (seenSourceKeys.has(sourceKey)) continue;

    const signals = await loadAccountSignals(db, workspaceId, accountId, signalSince);
    if (signals.length === 0) continue;

    const score = Math.max(0, Math.min(100, Number(row.score ?? 0)));
    const distinctKinds = Math.max(0, Number(row.distinct_kinds ?? 0));
    const personName = String(row.person_name ?? row.person_email ?? 'Known person');
    const accountName = String(row.account_name ?? row.domain ?? 'Account');
    const confidence = String(row.association_confidence ?? 'explicit');
    const associationRole = String(row.association_role ?? row.person_role ?? '').trim();
    const observedAt = iso(row.newest_signal_at ?? row.computed_at);
    const relationship = confidence === 'verified' ? 0.7 : 0.6;
    const signalSummary = signals
      .slice(0, 2)
      .map((signal) => String(signal.detail).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');

    const evidence: DemandEvidence[] = [
      {
        sourceType: 'account_contact',
        sourceId: String(row.account_contact_id),
        label: 'Known account contact',
        category: 'history',
        excerpt: `${personName}${associationRole ? ` · ${associationRole}` : ''} is an ${confidence} contact for ${accountName}.`,
        observedAt: iso(row.association_updated_at)
      },
      ...(selection.usedPersona && buyerPersona
        ? [
            {
              sourceType: 'campaign_brief' as const,
              sourceId: buyerPersona.campaignId,
              label: 'Saved buyer role',
              category: 'history' as const,
              excerpt: `Latest campaign ICP role: ${buyerPersona.role}. ${personName}'s role matched at ${Math.round((selection.roleScore ?? 0) * 100)}%.`,
              observedAt: buyerPersona.observedAt
            }
          ]
        : []),
      {
        sourceType: 'account_score',
        sourceId: accountId,
        label: 'Composite account intent',
        category: 'supporting',
        excerpt: `${accountName} is hot at ${score}/100 across ${distinctKinds} independent signal kinds.`,
        observedAt
      },
      ...accountSignalEvidence(signals)
    ];

    const selectionSentence =
      selection.usedPersona && buyerPersona
        ? `${personName}${associationRole ? ` (${associationRole})` : ''} is the clear best role match for the saved buyer role “${buyerPersona.role}”.`
        : `${personName}${associationRole ? ` (${associationRole})` : ''} is the one explicit/verified contact already on the account.`;

    candidates.push({
      sourceKey,
      personId,
      accountId,
      personName,
      accountName,
      dimensions: {
        fit: null,
        accountIntent: Number((score / 100).toFixed(3)),
        personIntent: 0,
        firstPartyIntent: 0,
        relationship,
        recency: recencyFor(observedAt, now)
      },
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      title: `Reach out to ${personName} at ${accountName}`,
      summary: `${accountName}: ${score}/100 account intent${signalSummary ? ` · ${signalSummary}` : ''}. ${selectionSentence}`,
      rationale: [
        `account scorer is hot at ${score}/100 across ${distinctKinds} signal kinds`,
        selection.usedPersona && buyerPersona
          ? `${personName} is the clear best match for saved buyer role ${buyerPersona.role}`
          : `exactly one ${confidence} account contact is available`,
        `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
      ],
      evidence
    });
    seenSourceKeys.add(sourceKey);
  }

  return candidates;
}
