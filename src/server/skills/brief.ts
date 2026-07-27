import { z } from 'zod';
import type { Skill, SkillEvidence } from './types.js';

/**
 * The join: four research outputs in, one sendable observation out.
 *
 * `findingDetail` is the whole point of this module. `draft.ts` drops it
 * straight into the email body, and `voice.ts` measures whether the sentence
 * survives the SUBSTITUTION TEST -- swap in any other company's name and it
 * should stop being true. "You could improve your online presence" survives
 * substitution, which is exactly why it is worthless. "Open roles on
 * example.test/careers went from 3 to 7" does not.
 *
 * So this module only ever builds `findingDetail` by interpolating values it
 * was actually given: a number, a name, a date, or a URL. It tracks those
 * values in `specifics` and VERIFIES they survived into the final sentence
 * before calling the brief usable. When nothing specific is available it does
 * not reach for a softer sentence -- it says so and sets `sufficient: false`,
 * because the failure mode this guards against is a well-formed brief that
 * quietly launders "we know nothing" into outreach copy.
 *
 * Priority is TIMING > DIAGNOSIS > FIRMOGRAPHICS: a change beats a standing
 * fact, because a change is why the email is arriving today.
 *
 * Contacts deliberately cannot lead. A list of addresses is a routing fact
 * about how to reach someone, not an observation about their business, so it
 * contributes evidence and never becomes the finding.
 */

export interface ResearchBrief {
  domain: string | null;
  topFinding: string;
  findingDetail: string;
  recommendedAngle: string;
  /** False when no input carried a checkable value. Do not draft from this brief. */
  sufficient: boolean;
  /** The observed values interpolated into `findingDetail`. */
  specifics: string[];
  evidence: SkillEvidence[];
}

const evidenceSchema = z.object({
  label: z.string(),
  detail: z.string(),
  sourceUrl: z.string().nullable().optional()
});

// Loose by design: these accept the real skill outputs, and zod drops the
// fields this module has no use for rather than rejecting a valid input.
const auditSchema = z.object({
  domain: z.string().optional(),
  score: z.number().optional(),
  topFinding: z.string().optional(),
  checks: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.string(),
        detail: z.string(),
        evidence: z.string().nullable().optional(),
        weight: z.number().optional(),
        impact: z.string().nullable().optional()
      })
    )
    .optional(),
  evidence: z.array(evidenceSchema).optional()
});

const enrichSchema = z.object({
  domain: z.string().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),
  catalogSize: z.number().nullable().optional(),
  catalogCapped: z.boolean().optional(),
  country: z.string().nullable().optional(),
  tech: z
    .array(z.object({ key: z.string(), label: z.string(), platform: z.boolean().optional(), marker: z.string().optional() }))
    .optional(),
  pages: z.array(z.object({ kind: z.string(), url: z.string().nullable(), present: z.boolean() })).optional(),
  emails: z.array(z.string()).optional(),
  evidence: z.array(evidenceSchema).optional()
});

const contactSchema = z.object({
  domain: z.string().optional(),
  contacts: z
    .array(
      z.object({
        kind: z.string(),
        value: z.string(),
        platform: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        confidence: z.string()
      })
    )
    .optional(),
  evidence: z.array(evidenceSchema).optional()
});

const watchSchema = z.object({
  domain: z.string().optional(),
  signals: z
    .array(
      z.object({
        kind: z.string(),
        detail: z.string(),
        previous: z.string().nullable().optional(),
        current: z.string().nullable().optional()
      })
    )
    .optional(),
  evidence: z.array(evidenceSchema).optional()
});

const inputSchema = z.object({
  audit: auditSchema.optional(),
  enrich: enrichSchema.optional(),
  contact: contactSchema.optional(),
  watch: watchSchema.optional()
});

export type ResearchBriefInput = z.infer<typeof inputSchema>;

type AuditInput = z.infer<typeof auditSchema>;
type EnrichInput = z.infer<typeof enrichSchema>;
type ContactInput = z.infer<typeof contactSchema>;
type WatchInput = z.infer<typeof watchSchema>;

interface Candidate {
  angle: string;
  topFinding: string;
  findingDetail: string;
  specifics: string[];
}

/** Change signals, most email-worthy first. `first-capture` is not a change. */
const SIGNAL_PRIORITY: readonly string[] = ['hiring-up', 'pricing-changed', 'tech-added', 'headline-changed', 'hiring-down', 'tech-removed'];

const SIGNAL_HEADLINE: Readonly<Record<string, string>> = {
  'hiring-up': 'Hiring is up',
  'hiring-down': 'Hiring has slowed',
  'pricing-changed': 'Pricing page changed',
  'headline-changed': 'Homepage positioning changed',
  'tech-added': 'New tooling on the site',
  'tech-removed': 'Tooling dropped from the site'
};

const SIGNAL_ANGLE: Readonly<Record<string, string>> = {
  'hiring-up': 'growth',
  'hiring-down': 'efficiency',
  'pricing-changed': 'positioning',
  'headline-changed': 'positioning',
  'tech-added': 'stack-change',
  'tech-removed': 'stack-change'
};

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fromWatch(watch: WatchInput | undefined): Candidate | null {
  const signals = (watch?.signals ?? []).filter((signal) => signal.kind !== 'first-capture');
  if (signals.length === 0) return null;
  const ranked = [...signals].sort((a, b) => {
    const left = SIGNAL_PRIORITY.indexOf(a.kind);
    const right = SIGNAL_PRIORITY.indexOf(b.kind);
    return (left < 0 ? SIGNAL_PRIORITY.length : left) - (right < 0 ? SIGNAL_PRIORITY.length : right);
  });
  const best = ranked[0];
  const specifics = [best.previous, best.current].filter(present);
  return {
    angle: SIGNAL_ANGLE[best.kind] ?? 'timing',
    topFinding: SIGNAL_HEADLINE[best.kind] ?? best.kind,
    // The diff already wrote the sentence with both values in it; rewriting it
    // here would be a second place for the numbers to drift out of sync.
    findingDetail: best.detail,
    specifics
  };
}

function fromAudit(audit: AuditInput | undefined, domain: string | null): Candidate | null {
  if (!audit) return null;
  const problems = [...(audit.checks ?? [])]
    .filter((check) => check.status === 'fail' || check.status === 'warn')
    .sort((a, b) => {
      const failFirst = Number(a.status !== 'fail') - Number(b.status !== 'fail');
      if (failFirst !== 0) return failFirst;
      return (b.weight ?? 0) - (a.weight ?? 0);
    });
  const worst = problems[0];
  const subject = domain ?? 'This site';
  const specifics: string[] = [];

  if (typeof audit.score === 'number') specifics.push(String(audit.score));
  if (worst) specifics.push(worst.label);

  if (worst && typeof audit.score === 'number') {
    const proof = present(worst.evidence) ? ` (${worst.evidence})` : '';
    if (present(worst.evidence)) specifics.push(worst.evidence);
    return {
      angle: 'ai-visibility',
      topFinding: worst.impact ?? worst.detail,
      findingDetail: `${subject} scores ${audit.score}/100 for AI visibility: ${worst.label} is a ${worst.status}${proof}.`,
      specifics
    };
  }
  if (typeof audit.score === 'number') {
    return {
      angle: 'ai-visibility',
      topFinding: audit.topFinding ?? 'AI visibility audit',
      findingDetail: `${subject} scores ${audit.score}/100 for AI visibility with every check it answered passing.`,
      specifics
    };
  }
  if (worst) {
    return {
      angle: 'ai-visibility',
      topFinding: worst.impact ?? worst.detail,
      findingDetail: `${subject}: ${worst.label} is a ${worst.status} -- ${worst.detail}`,
      specifics
    };
  }
  return null;
}

function fromEnrich(enrich: EnrichInput | undefined, domain: string | null): Candidate | null {
  if (!enrich) return null;
  const tech = enrich.tech ?? [];
  const platformLabel = present(enrich.platform)
    ? tech.find((item) => item.key === enrich.platform)?.label ?? enrich.platform
    : null;
  const bits: string[] = [];
  const specifics: string[] = [];

  if (platformLabel) {
    bits.push(`runs ${platformLabel}`);
    specifics.push(platformLabel);
  }
  if (typeof enrich.catalogSize === 'number') {
    const size = enrich.catalogCapped ? `${enrich.catalogSize}+` : String(enrich.catalogSize);
    bits.push(`${bits.length > 0 ? 'with ' : 'publishes '}${size} products in its public products.json feed`);
    specifics.push(String(enrich.catalogSize));
  }
  const marketing = tech.filter((item) => item.platform === false).map((item) => item.label);
  if (marketing.length > 0) {
    bits.push(`and loads ${marketing.join(' and ')}`);
    specifics.push(marketing[0]);
  }
  const careers = (enrich.pages ?? []).find((page) => page.kind === 'careers' && page.present && present(page.url));
  if (careers?.url) {
    bits.push(`and is hiring at ${careers.url}`);
    specifics.push(careers.url);
  }
  if (bits.length === 0) return null;

  const subject = present(enrich.name) ? enrich.name : domain ?? 'This company';
  if (present(enrich.name)) specifics.push(enrich.name);

  const topFinding = platformLabel
    ? typeof enrich.catalogSize === 'number'
      ? `${platformLabel} catalog of ${enrich.catalogCapped ? `${enrich.catalogSize}+` : enrich.catalogSize} products`
      : `${platformLabel} storefront`
    : 'Public site fingerprint';

  return { angle: 'platform', topFinding, findingDetail: `${subject} ${bits.join(', ')}.`, specifics };
}

function dedupeEvidence(rows: SkillEvidence[]): SkillEvidence[] {
  const seen = new Set<string>();
  const out: SkillEvidence[] = [];
  for (const row of rows) {
    const key = `${row.label}::${row.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Which of the tracked values actually survived into the sentence. */
function survivingSpecifics(detail: string, specifics: string[]): string[] {
  return [...new Set(specifics.filter((value) => value.trim().length > 0 && detail.includes(value)))];
}

export function buildResearchBrief(input: ResearchBriefInput): ResearchBrief {
  const domain =
    input.audit?.domain ?? input.enrich?.domain ?? input.contact?.domain ?? input.watch?.domain ?? null;

  const evidence = dedupeEvidence([
    ...(input.watch?.evidence ?? []),
    ...(input.audit?.evidence ?? []),
    ...(input.enrich?.evidence ?? []),
    ...(input.contact?.evidence ?? [])
  ]).slice(0, 12);

  const candidates = [fromWatch(input.watch), fromAudit(input.audit, domain), fromEnrich(input.enrich, domain)].filter(
    (candidate): candidate is Candidate => candidate !== null
  );

  for (const candidate of candidates) {
    const specifics = survivingSpecifics(candidate.findingDetail, candidate.specifics);
    // A candidate whose values did not make it into its own sentence is a
    // generic sentence wearing a finding's clothes; skip to the next source.
    if (specifics.length === 0) continue;
    return {
      domain,
      topFinding: candidate.topFinding,
      findingDetail: candidate.findingDetail,
      recommendedAngle: candidate.angle,
      sufficient: true,
      specifics,
      evidence
    };
  }

  return {
    domain,
    topFinding: 'No checkable finding yet',
    findingDetail: `No checkable observation for ${domain ?? 'this lead'}: the audit, enrichment, contact, and signal inputs carried no observed value.`,
    recommendedAngle: 'none',
    sufficient: false,
    specifics: [],
    evidence
  };
}

const outputSchema = z.object({
  domain: z.string().nullable(),
  topFinding: z.string(),
  findingDetail: z.string(),
  recommendedAngle: z.string(),
  sufficient: z.boolean(),
  specifics: z.array(z.string()),
  evidence: z.array(evidenceSchema)
});

export const researchBriefSkill: Skill<ResearchBriefInput, ResearchBrief> = {
  manifest: {
    id: 'gtm.research-brief',
    name: 'Build a research brief',
    version: '1.0.0',
    description:
      'Join audit, enrichment, contact, and signal outputs into one checkable observation shaped for gtm.outreach-draft, or report that nothing specific was found.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return buildResearchBrief(input);
  }
};
