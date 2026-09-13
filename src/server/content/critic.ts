import type {
  ClaimMapEntry,
  ContentAngle,
  ContentEvidenceRef,
  ContentOpportunity
} from './types.js';

export const CONTENT_CRITIC_VERSION = 'deterministic-v1';
export const CONTENT_DRAFT_MAX_AGE_DAYS = 14;
const DAY_MS = 86_400_000;
const LINKEDIN_MAX_CHARS = 3_000;
const LONG_COPY_WARNING_CHARS = 2_200;

export interface ContentCriticIssue {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
  claim?: string;
}

export interface ContentCritique {
  passed: boolean;
  blockers: ContentCriticIssue[];
  warnings: ContentCriticIssue[];
  version: string;
}

function evidenceKey(evidence: ContentEvidenceRef): string {
  return `${evidence.sourceType}:${evidence.sourceId}`;
}

function sameEvidence(left: ContentEvidenceRef, right: ContentEvidenceRef): boolean {
  return (
    evidenceKey(left) === evidenceKey(right) &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.sourceUrl === right.sourceUrl &&
    left.observedAt === right.observedAt
  );
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Deterministic proof critic for evidence-backed distribution copy.
 *
 * This is intentionally stricter than a generic writing critic: a factual
 * sentence is only allowed when it is one of the canonical story claims, and
 * each proof reference must be the exact stored source snapshot rather than a
 * merely similar URL or label. Structural prose (headings / CTA scaffolding)
 * does not need a claim-map row because it asserts no external fact.
 */
export function critiqueContentDraft(
  opportunity: ContentOpportunity,
  draft: { angle: ContentAngle; body: string; claimMap: ClaimMapEntry[] },
  now: Date = new Date()
): ContentCritique {
  const blockers: ContentCriticIssue[] = [];
  const warnings: ContentCriticIssue[] = [];
  const canonicalClaims = new Set([
    opportunity.title.trim(),
    opportunity.thesis.trim(),
    ...opportunity.evidence.map((item) => item.detail.trim())
  ]);
  const canonicalEvidence = new Map(
    opportunity.evidence.map((item) => [evidenceKey(item), item] as const)
  );

  const freshness = Date.parse(opportunity.freshnessAt);
  if (!Number.isFinite(freshness)) {
    blockers.push({
      code: 'invalid_freshness',
      severity: 'blocker',
      message: 'Story freshness timestamp is invalid.'
    });
  } else if (now.getTime() - freshness > CONTENT_DRAFT_MAX_AGE_DAYS * DAY_MS) {
    blockers.push({
      code: 'stale_story',
      severity: 'blocker',
      message: `Story evidence is older than ${CONTENT_DRAFT_MAX_AGE_DAYS} days; refresh the evidence before drafting.`
    });
  }

  if (!draft.body.trim()) {
    blockers.push({ code: 'empty_body', severity: 'blocker', message: 'Draft body is empty.' });
  }
  if (draft.body.length > LINKEDIN_MAX_CHARS) {
    blockers.push({
      code: 'channel_length',
      severity: 'blocker',
      message: `Draft is ${draft.body.length} characters; LinkedIn drafts are capped at ${LINKEDIN_MAX_CHARS}.`
    });
  } else if (draft.body.length > LONG_COPY_WARNING_CHARS) {
    warnings.push({
      code: 'long_copy',
      severity: 'warning',
      message: `Draft is ${draft.body.length} characters; consider tightening it before publishing.`
    });
  }

  if (draft.claimMap.length === 0) {
    blockers.push({
      code: 'missing_provenance',
      severity: 'blocker',
      message: 'Draft has no claim-to-source provenance.'
    });
  }

  for (const entry of draft.claimMap) {
    const claim = entry.claim.trim();
    if (!claim) {
      blockers.push({
        code: 'empty_claim',
        severity: 'blocker',
        message: 'Claim map contains an empty claim.'
      });
      continue;
    }
    if (!canonicalClaims.has(claim)) {
      blockers.push({
        code: 'unsupported_claim',
        severity: 'blocker',
        message: 'Draft contains a factual claim that is not part of the canonical story evidence.',
        claim
      });
    }
    if (!draft.body.includes(claim)) {
      blockers.push({
        code: 'claim_not_rendered',
        severity: 'blocker',
        message: 'Claim map references a claim that is not present in the rendered draft.',
        claim
      });
    }
    if (entry.evidence.length === 0) {
      blockers.push({
        code: 'missing_provenance',
        severity: 'blocker',
        message: 'Factual claim has no source evidence.',
        claim
      });
    }
    for (const evidence of entry.evidence) {
      const canonical = canonicalEvidence.get(evidenceKey(evidence));
      if (!canonical || !sameEvidence(canonical, evidence)) {
        blockers.push({
          code: 'foreign_evidence',
          severity: 'blocker',
          message: 'Claim references evidence outside this story snapshot.',
          claim
        });
        continue;
      }
      if (!validHttpUrl(evidence.sourceUrl)) {
        blockers.push({
          code: 'invalid_source_url',
          severity: 'blocker',
          message: 'Claim evidence does not have an inspectable HTTP(S) source URL.',
          claim
        });
      }
      if (!Number.isFinite(Date.parse(evidence.observedAt))) {
        blockers.push({
          code: 'invalid_observed_at',
          severity: 'blocker',
          message: 'Claim evidence is missing a valid observation timestamp.',
          claim
        });
      }
    }
  }

  if (
    draft.angle === 'prediction' &&
    !/\b(prediction|predict|expect|could|might|likely|may)\b/i.test(draft.body)
  ) {
    blockers.push({
      code: 'unlabeled_inference',
      severity: 'blocker',
      message:
        'Prediction framing must explicitly label inference instead of presenting it as observed fact.'
    });
  }

  if (!draft.body.includes(opportunity.thesis)) {
    warnings.push({
      code: 'thesis_omitted',
      severity: 'warning',
      message: 'Draft does not state the story thesis explicitly.'
    });
  }
  if (/\b(book a demo|buy now|sign up now|start your trial|try trevra)\b/i.test(draft.body)) {
    warnings.push({
      code: 'promotional_cta',
      severity: 'warning',
      message:
        'Draft contains a promotional CTA; keep the evidence useful before asking for conversion.'
    });
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    version: CONTENT_CRITIC_VERSION
  };
}
