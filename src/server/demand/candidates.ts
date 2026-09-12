import type { Db } from '../db.js';
import { isHighIntentInboundKind } from './opportunities.js';

export type DemandQualification = 'act_now' | 'watch' | 'ignore';
export type DemandRecommendedAction =
  'reply' | 'prepare_outreach' | 'find_person' | 'qualify' | 'watch';

export interface DemandEvidence {
  sourceType:
    | 'inbound_submission'
    | 'account_contact'
    | 'account_score'
    | 'account_signal'
    | 'campaign_brief'
    | 'discovery_plan'
    | 'conversation_message'
    | 'opportunity';
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
  /** Observed commercial relationship strength from real conversation/pipeline state. */
  relationship: number;
  /** Freshness of the newest first-party event, normalized to 0..1. */
  recency: number;
}

export interface DemandCandidate {
  sourceKey: string;
  personId: string | null;
  accountId: string;
  personName: string | null;
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
const DORMANT_OPPORTUNITY_DAYS = 14;
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
    case 'pricing_request':
    case 'pricing_inquiry':
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

interface RelationshipState {
  score: number;
  recentInbound: boolean;
  evidence: DemandEvidence[];
}

function decayedRelationship(base: number, observedAt: string, now: Date): number {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (now.getTime() - parsed) / DAY_MS);
  if (ageDays > 90) return 0;
  return Number((base * (1 - 0.5 * (ageDays / 90))).toFixed(3));
}

/**
 * Relationship means somebody has actually interacted or entered pipeline.
 * Account-contact confidence proves identity/association, not commercial
 * relationship, so it deliberately does not participate here.
 */
async function loadRelationshipState(
  db: Db,
  workspaceId: string,
  personId: string,
  accountId: string,
  now: Date
): Promise<RelationshipState> {
  const evidence: DemandEvidence[] = [];
  let score = 0;
  let recentInbound = false;

  const inbound = await db
    .prepare(
      `
      SELECT cm.id,cm.channel,cm.source_type,cm.outcome_kind,cm.verification_status,cm.body,cm.occurred_at
      FROM conversations c
      JOIN conversation_messages cm
        ON cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id
      WHERE c.workspace_id=? AND c.person_id=? AND cm.direction='inbound'
      ORDER BY cm.occurred_at DESC,cm.created_at DESC,cm.id DESC
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(workspaceId, personId);
  if (inbound) {
    const observedAt = iso(inbound.occurred_at);
    const sourceType = String(inbound.source_type ?? '');
    const outcomeKind = String(inbound.outcome_kind ?? '');
    const verified = String(inbound.verification_status ?? '') === 'verified';
    const channel = String(inbound.channel ?? 'conversation');
    const base =
      verified && outcomeKind === 'reply'
        ? 1
        : sourceType === 'linkedin_message'
          ? 0.9
          : verified
            ? 0.85
            : 0.7;
    const inboundScore = decayedRelationship(base, observedAt, now);
    if (inboundScore > 0) {
      score = Math.max(score, inboundScore);
      recentInbound = true;
      evidence.push({
        sourceType: 'conversation_message',
        sourceId: String(inbound.id),
        label: `Recent inbound ${channel} message`,
        category: 'history',
        excerpt:
          String(inbound.body ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 320) || `A recent inbound ${channel} message is stored for this person.`,
        observedAt
      });
    }
  }

  const opportunity = await db
    .prepare(
      `
      SELECT id,stage,title,updated_at
      FROM opportunities
      WHERE workspace_id=?
        AND stage NOT IN ('won','lost')
        AND (person_id=? OR account_id=?)
      ORDER BY CASE stage
        WHEN 'meeting' THEN 1 WHEN 'proposal' THEN 2 WHEN 'qualified' THEN 3 ELSE 4 END,
        updated_at DESC,id DESC
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(workspaceId, personId, accountId);
  if (opportunity) {
    const stage = String(opportunity.stage);
    const stageScore =
      stage === 'meeting' ? 1 : stage === 'proposal' ? 0.95 : stage === 'qualified' ? 0.85 : 0.6;
    score = Math.max(score, stageScore);
    evidence.push({
      sourceType: 'opportunity',
      sourceId: String(opportunity.id),
      label: `Active ${stage} opportunity`,
      category: 'history',
      excerpt: String(opportunity.title ?? `Active ${stage} opportunity`),
      observedAt: iso(opportunity.updated_at)
    });
  }

  return { score: Number(score.toFixed(3)), recentInbound, evidence };
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

interface PersonDiscoveryPlan {
  kind: 'company_employees' | 'search';
  url: string;
  detail: string;
}

function linkedInCompanyPeopleUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/company\/([^/]+)/i);
    if (!match?.[1]) return null;
    return `https://www.linkedin.com/company/${match[1]}/people/`;
  } catch {
    return null;
  }
}

function personDiscoveryPlan(
  accountName: string,
  linkedInUrl: string | null,
  persona: BuyerPersona | null
): PersonDiscoveryPlan | null {
  const companyPeople = linkedInCompanyPeopleUrl(linkedInUrl);
  if (companyPeople) {
    return {
      kind: 'company_employees',
      url: companyPeople,
      detail: persona
        ? `Review ${accountName}'s visible employees for people matching the saved buyer role ${persona.role}.`
        : `Review ${accountName}'s visible employees and choose the relevant buyer before outreach.`
    };
  }
  if (!persona) return null;
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set('keywords', `${persona.role} ${accountName}`);
  url.searchParams.set('origin', 'GLOBAL_SEARCH_HEADER');
  return {
    kind: 'search',
    url: url.toString(),
    detail: `Search LinkedIn people for ${persona.role} at ${accountName}; review the results before saving anyone.`
  };
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
        sc.tier AS account_tier,
        sc.distinct_kinds,
        sc.newest_signal_at
      FROM inbound_submissions s
      JOIN contacts p
        ON p.workspace_id=s.workspace_id AND p.id=s.contact_id
      JOIN accounts a
        ON a.workspace_id=s.workspace_id AND a.id=s.account_id
      LEFT JOIN account_scores sc
        ON sc.workspace_id=s.workspace_id AND sc.account_id=s.account_id
      WHERE s.workspace_id=?
        AND s.account_id IS NOT NULL
        AND s.received_at>=?::timestamptz
      ORDER BY s.contact_id,s.account_id,
        CASE LOWER(BTRIM(s.kind))
          WHEN 'demo_request' THEN 0
          WHEN 'pilot_request' THEN 0
          WHEN 'enterprise_pilot_request' THEN 0
          WHEN 'pricing_request' THEN 0
          WHEN 'pricing_inquiry' THEN 0
          WHEN 'pricing_enquiry' THEN 0
          ELSE 1
        END,
        s.received_at DESC,s.id DESC
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
    const scoreKnown = row.score !== null && row.score !== undefined;
    const score = scoreKnown ? Math.max(0, Math.min(100, Number(row.score))) : 0;
    const accountHot = String(row.account_tier ?? '') === 'hot';
    const highIntentInbound = isHighIntentInboundKind(submissionKind);
    if (!highIntentInbound && !accountHot) continue;
    const distinctKinds = Math.max(0, Number(row.distinct_kinds ?? 0));
    const personName = String(row.person_name ?? row.person_email ?? 'Known person');
    const accountName = String(row.account_name ?? row.domain ?? 'Account');

    const signals = await loadAccountSignals(db, workspaceId, accountId, signalSince);

    // Weak first-party activity still needs inspectable, corroborating account
    // evidence. An explicit demo/pilot/pricing request is the exception: the
    // buyer has already raised their hand, so no synthetic account score is
    // required to make the commercial decision actionable.
    if (!highIntentInbound && signals.length === 0) continue;

    const firstPartyIntent = firstPartyStrength(submissionKind);
    const recency = recencyFor(receivedAt, now);
    const relationshipState = await loadRelationshipState(
      db,
      workspaceId,
      personId,
      accountId,
      now
    );
    const dimensions: DemandDimensions = {
      fit: null,
      accountIntent: Number((score / 100).toFixed(3)),
      personIntent: 0,
      firstPartyIntent,
      relationship: relationshipState.score,
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
      ...(scoreKnown
        ? [
            {
              sourceType: 'account_score' as const,
              sourceId: accountId,
              label: 'Composite account intent',
              category: 'supporting' as const,
              excerpt: `${accountName} is ${accountHot ? 'hot' : String(row.account_tier ?? 'scored')} at ${score}/100 across ${distinctKinds} independent signal kinds.`,
              observedAt: iso(row.newest_signal_at ?? receivedAt)
            }
          ]
        : []),
      ...accountSignalEvidence(signals),
      ...relationshipState.evidence
    ];

    const firstPartyLabel = submissionKind.replaceAll('_', ' ');
    const signalSummary = signals
      .slice(0, 2)
      .map((signal) => String(signal.detail).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');

    const sourceKey = `demand:${personId}:${accountId}`;
    const recommendedAction: DemandRecommendedAction = relationshipState.recentInbound
      ? 'reply'
      : 'prepare_outreach';
    candidates.push({
      sourceKey,
      personId,
      accountId,
      personName,
      accountName,
      dimensions,
      qualification: 'act_now',
      recommendedAction,
      title: relationshipState.recentInbound
        ? `Reply to ${personName} at ${accountName}`
        : `Talk to ${personName} at ${accountName}`,
      summary: `${personName}: ${firstPartyLabel}.${scoreKnown ? ` ${accountName}: ${score}/100 account intent` : ` ${accountName}: explicit buying request`}${signalSummary ? ` · ${signalSummary}` : ''}${relationshipState.recentInbound ? ' · recent inbound conversation' : ''}`,
      rationale: [
        `${submissionKind.replaceAll('_', ' ')} is explicit first-party intent`,
        ...(scoreKnown
          ? [
              `account scorer is ${accountHot ? 'hot' : String(row.account_tier ?? 'scored')} at ${score}/100 across ${distinctKinds} signal kinds`
            ]
          : highIntentInbound
            ? ['explicit demo/pilot/pricing intent does not require an inferred account score']
            : []),
        ...(relationshipState.recentInbound
          ? ['a recent inbound conversation means the next action is a reply, not cold outreach']
          : []),
        ...(signals.length > 0
          ? [
              `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
            ]
          : [])
      ],
      evidence
    });
    seenSourceKeys.add(sourceKey);
    firstPartyAccountIds.add(accountId);
  }

  // Re-engagement counterpart: a previously qualified/new opportunity went
  // quiet, then the Account became hot again. The old Opportunity is commercial
  // context, not a reason to suppress fresh demand forever. Meeting/proposal
  // stages are excluded here because they already have their own next-step and
  // stale-proposal handling.
  const dormantSince = new Date(now.getTime() - DORMANT_OPPORTUNITY_DAYS * DAY_MS).toISOString();
  const dormantRows = await db
    .prepare(
      `
      SELECT
        o.id AS opportunity_id,o.person_id,o.account_id,o.title AS opportunity_title,
        o.stage AS opportunity_stage,o.updated_at AS opportunity_updated_at,
        p.name AS person_name,p.email AS person_email,
        a.name AS account_name,a.domain,
        sc.score,sc.distinct_kinds,sc.newest_signal_at,sc.computed_at
      FROM opportunities o
      JOIN contacts p ON p.workspace_id=o.workspace_id AND p.id=o.person_id
      JOIN accounts a ON a.workspace_id=o.workspace_id AND a.id=o.account_id
      JOIN account_scores sc ON sc.workspace_id=o.workspace_id AND sc.account_id=o.account_id
      WHERE o.workspace_id=?
        AND o.person_id IS NOT NULL
        AND o.account_id IS NOT NULL
        AND o.stage IN ('new','qualified')
        AND o.updated_at<=?::timestamptz
        AND sc.tier='hot'
        AND sc.score>=80
        AND COALESCE(sc.newest_signal_at,sc.computed_at)>=?::timestamptz
      ORDER BY sc.score DESC,COALESCE(sc.newest_signal_at,sc.computed_at) DESC,o.updated_at ASC,o.id
      LIMIT 50
    `
    )
    .all<Record<string, unknown>>(workspaceId, dormantSince, recentSince);

  for (const row of dormantRows) {
    const personId = String(row.person_id);
    const accountId = String(row.account_id);
    if (firstPartyAccountIds.has(accountId)) continue;
    const sourceKey = `demand:${personId}:${accountId}`;
    if (seenSourceKeys.has(sourceKey)) continue;
    const signals = await loadAccountSignals(db, workspaceId, accountId, signalSince);
    if (signals.length === 0) continue;

    const score = Math.max(0, Math.min(100, Number(row.score ?? 0)));
    const distinctKinds = Math.max(0, Number(row.distinct_kinds ?? 0));
    const personName = String(row.person_name ?? row.person_email ?? 'Known person');
    const accountName = String(row.account_name ?? row.domain ?? 'Account');
    const observedAt = iso(row.newest_signal_at ?? row.computed_at);
    const opportunityUpdatedAt = iso(row.opportunity_updated_at);
    const staleDays = Math.max(
      DORMANT_OPPORTUNITY_DAYS,
      Math.floor((now.getTime() - Date.parse(opportunityUpdatedAt)) / DAY_MS)
    );
    const relationshipState = await loadRelationshipState(
      db,
      workspaceId,
      personId,
      accountId,
      now
    );
    const recommendedAction: DemandRecommendedAction = relationshipState.recentInbound
      ? 'reply'
      : 'prepare_outreach';
    const evidence: DemandEvidence[] = [
      {
        sourceType: 'opportunity',
        sourceId: String(row.opportunity_id),
        label: `Dormant ${String(row.opportunity_stage)} opportunity`,
        category: 'history',
        excerpt: `${String(row.opportunity_title)} has had no opportunity update for ${staleDays} days.`,
        observedAt: opportunityUpdatedAt
      },
      {
        sourceType: 'account_score',
        sourceId: accountId,
        label: 'Composite account intent',
        category: 'supporting',
        excerpt: `${accountName} is hot again at ${score}/100 across ${distinctKinds} independent signal kinds.`,
        observedAt
      },
      ...accountSignalEvidence(signals),
      ...relationshipState.evidence.filter(
        (item) =>
          !(item.sourceType === 'opportunity' && item.sourceId === String(row.opportunity_id))
      )
    ];

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
        relationship: relationshipState.score,
        recency: recencyFor(observedAt, now)
      },
      qualification: 'act_now',
      recommendedAction,
      title: relationshipState.recentInbound
        ? `Reply to ${personName} at ${accountName}`
        : `Re-engage ${personName} at ${accountName}`,
      summary: `${accountName} is hot again at ${score}/100 while the ${String(row.opportunity_stage)} opportunity has been quiet for ${staleDays} days.`,
      rationale: [
        `${String(row.opportunity_stage)} opportunity has been dormant for ${staleDays} days`,
        `account scorer is hot at ${score}/100 across ${distinctKinds} signal kinds`,
        ...(relationshipState.recentInbound
          ? ['a recent inbound conversation means the next action is a reply']
          : ['fresh account evidence makes re-engagement timely']),
        `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
      ],
      evidence
    });
    seenSourceKeys.add(sourceKey);
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
    const relationshipState = await loadRelationshipState(
      db,
      workspaceId,
      personId,
      accountId,
      now
    );
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
      ...accountSignalEvidence(signals),
      ...relationshipState.evidence
    ];

    const selectionSentence =
      selection.usedPersona && buyerPersona
        ? `${personName}${associationRole ? ` (${associationRole})` : ''} is the clear best role match for the saved buyer role “${buyerPersona.role}”.`
        : `${personName}${associationRole ? ` (${associationRole})` : ''} is the one explicit/verified contact already on the account.`;

    const recommendedAction: DemandRecommendedAction = relationshipState.recentInbound
      ? 'reply'
      : 'prepare_outreach';
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
        relationship: relationshipState.score,
        recency: recencyFor(observedAt, now)
      },
      qualification: 'act_now',
      recommendedAction,
      title: relationshipState.recentInbound
        ? `Reply to ${personName} at ${accountName}`
        : `Reach out to ${personName} at ${accountName}`,
      summary: `${accountName}: ${score}/100 account intent${signalSummary ? ` · ${signalSummary}` : ''}. ${selectionSentence}${relationshipState.recentInbound ? ' A recent inbound conversation is already active.' : ''}`,
      rationale: [
        `account scorer is hot at ${score}/100 across ${distinctKinds} signal kinds`,
        selection.usedPersona && buyerPersona
          ? `${personName} is the clear best match for saved buyer role ${buyerPersona.role}`
          : `exactly one ${confidence} account contact is available`,
        ...(relationshipState.recentInbound
          ? ['a recent inbound conversation means the next action is a reply, not cold outreach']
          : []),
        `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
      ],
      evidence
    });
    seenSourceKeys.add(sourceKey);
  }

  // No known person: prepare a targeted discovery decision rather than leaving
  // a hot account as a generic Research card. This is still internal planning
  // only. The LinkedIn source is not queued until the founder explicitly submits
  // it from Find people.
  const missingPersonRows = await db
    .prepare(
      `
      SELECT a.id AS account_id,a.name AS account_name,a.domain,a.linkedin_url,
             sc.score,sc.distinct_kinds,sc.newest_signal_at,sc.computed_at
      FROM account_scores sc
      JOIN accounts a ON a.workspace_id=sc.workspace_id AND a.id=sc.account_id
      WHERE sc.workspace_id=?
        AND sc.tier='hot'
        AND sc.score>=80
        AND COALESCE(sc.newest_signal_at,sc.computed_at)>=?::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM account_contacts ac
          WHERE ac.workspace_id=sc.workspace_id
            AND ac.account_id=sc.account_id
            AND ac.confidence IN ('explicit','verified')
        )
        AND NOT EXISTS (
          SELECT 1 FROM opportunities o
          WHERE o.workspace_id=sc.workspace_id
            AND o.account_id=sc.account_id
            AND o.stage NOT IN ('won','lost')
        )
      ORDER BY sc.score DESC,COALESCE(sc.newest_signal_at,sc.computed_at) DESC,a.id
      LIMIT 50
    `
    )
    .all<Record<string, unknown>>(workspaceId, recentSince);

  for (const row of missingPersonRows) {
    const accountId = String(row.account_id);
    if (firstPartyAccountIds.has(accountId)) continue;
    const accountName = String(row.account_name ?? row.domain ?? 'Account');
    const plan = personDiscoveryPlan(
      accountName,
      row.linkedin_url ? String(row.linkedin_url) : null,
      buyerPersona
    );
    if (!plan) continue;

    const signals = await loadAccountSignals(db, workspaceId, accountId, signalSince);
    if (signals.length === 0) continue;

    const score = Math.max(0, Math.min(100, Number(row.score ?? 0)));
    const distinctKinds = Math.max(0, Number(row.distinct_kinds ?? 0));
    const observedAt = iso(row.newest_signal_at ?? row.computed_at);
    const signalSummary = signals
      .slice(0, 2)
      .map((signal) => String(signal.detail).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');
    const evidence: DemandEvidence[] = [
      ...(buyerPersona
        ? [
            {
              sourceType: 'campaign_brief' as const,
              sourceId: buyerPersona.campaignId,
              label: 'Saved buyer role',
              category: 'history' as const,
              excerpt: `Latest campaign ICP role: ${buyerPersona.role}.`,
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
      ...accountSignalEvidence(signals),
      {
        sourceType: 'discovery_plan',
        sourceId: `${plan.kind}:${accountId}`,
        label: 'Prepared person discovery',
        category: 'supporting',
        excerpt: plan.detail,
        externalUrl: plan.url,
        observedAt: now.toISOString()
      }
    ];

    candidates.push({
      sourceKey: `demand:find-person:${accountId}`,
      personId: null,
      accountId,
      personName: null,
      accountName,
      dimensions: {
        fit: null,
        accountIntent: Number((score / 100).toFixed(3)),
        personIntent: 0,
        firstPartyIntent: 0,
        relationship: 0,
        recency: recencyFor(observedAt, now)
      },
      qualification: 'act_now',
      recommendedAction: 'find_person',
      title: `Find the right person at ${accountName}`,
      summary: `${accountName}: ${score}/100 account intent${signalSummary ? ` · ${signalSummary}` : ''}. No explicit/verified contact is known yet; person discovery is prepared for review.`,
      rationale: [
        `account scorer is hot at ${score}/100 across ${distinctKinds} signal kinds`,
        'no explicit or verified account contact is known',
        buyerPersona
          ? `saved buyer role ${buyerPersona.role} is available to guide discovery`
          : 'the account LinkedIn company page provides a deterministic employee source',
        `${signals.length} source-backed account signal${signals.length === 1 ? '' : 's'} are available for context`
      ],
      evidence
    });
  }

  return candidates;
}
