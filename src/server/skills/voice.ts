import { z } from 'zod';
import type { Skill } from './types.js';

/**
 * Deterministic anti-slop critic for outreach copy.
 *
 * The problem: an LLM drafter with no quality gate produces fluent, polite,
 * specific-sounding email that could have been sent to anybody. Accepting it
 * because it is non-empty (what `draftOutreach` did before this module) is how
 * slop ships at scale.
 *
 * The gate is deterministic on purpose. Models generate; software decides what
 * is allowed out. That is the same boundary Trevra already draws around money,
 * permissions, state transitions, and execution.
 *
 * The decisive check is the SUBSTITUTION TEST (`generic-sentence`): swap the
 * recipient for their closest competitor. If a sentence still reads fine, it
 * carried no information about *this* recipient, and it is slop. Mechanized as:
 * every sentence must contain at least one token derived from the recipient's
 * own evidence -- their domain, company, contact name, audit finding, or failed
 * checks. A sentence that cannot name anything specific is filler.
 *
 * Every other check here is a known tell of machine-written outreach, and each
 * one is cheap to evaluate and impossible to argue with.
 */

/** Blocking findings fail the draft outright. Warnings accumulate against a budget. */
export type SlopSeverity = 'block' | 'warn';

export interface SlopFinding {
  check: string;
  severity: SlopSeverity;
  detail: string;
  /** The offending excerpt, verbatim, so a regeneration prompt can quote it back. */
  excerpt?: string;
}

export interface Critique {
  passed: boolean;
  findings: SlopFinding[];
  wordCount: number;
  /** Fraction of sentences that carry no recipient-specific evidence. 0 is ideal. */
  genericRatio: number;
}

/**
 * Phrases that mark copy as machine-written or template-written.
 *
 * Grouped by tell. These are matched case-insensitively on word boundaries.
 * Curated rather than generated: every entry is a phrase that survives in
 * outreach precisely because it is frictionless to write and carries no
 * information.
 */
export const BANNED_PHRASES: readonly string[] = [
  // Openers that announce the sender rather than the reason.
  'hope this email finds you well',
  'hope this finds you well',
  "hope you're doing well",
  'hope you are doing well',
  'i came across',
  'i stumbled upon',
  'i wanted to reach out',
  'wanted to reach out',
  'just wanted to',
  'quick question',
  'my name is',
  // Corporate filler.
  'circle back',
  'touch base',
  'sync up',
  'pick your brain',
  'at the end of the day',
  "in today's fast-paced",
  'moving forward',
  'synergy',
  'align on',
  'low-hanging fruit',
  // Marketing inflation.
  'game-changer',
  'game changer',
  'revolutionize',
  'revolutionise',
  'seamless',
  'seamlessly',
  'best-in-class',
  'world-class',
  'cutting-edge',
  'state-of-the-art',
  'supercharge',
  'unlock the power',
  'take your business to the next level',
  'transform your business',
  'delve into',
  'testament to',
  // Unearned flattery.
  "i love what you're doing",
  'i love what you are doing',
  'impressive work',
  'big fan of',
  'huge fan of',
  // Closing filler.
  "i'd love to",
  'i would love to',
  'feel free to',
  "don't hesitate to",
  'do not hesitate to',
  'looking forward to hearing'
];

/** Hedges that drain a claim of its content. */
export const HEDGE_PHRASES: readonly string[] = [
  'i think',
  'i believe',
  'it seems',
  'perhaps',
  'possibly',
  'might be able to',
  'could potentially',
  'we may be able to',
  'somewhat',
  'fairly'
];

/**
 * Words too common to prove a sentence is about anyone in particular.
 * Without this filter, an evidence token like "the" would let every sentence
 * pass the substitution test.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'not', 'with', 'that', 'this', 'has', 'have',
  'was', 'were', 'from', 'but', 'can', 'will', 'its', 'it', 'a', 'an', 'of', 'to', 'in',
  'on', 'at', 'is', 'be', 'or', 'no', 'we', 'us', 'our', 'they', 'them', 'their', 'com', 'www',
  'site', 'page', 'data', 'more', 'most', 'some', 'any', 'all', 'one', 'two', 'new', 'get'
]);

/** Words whose presence signals an ask. More than one ask splits the reader's attention. */
const ASK_PATTERNS: readonly RegExp[] = [
  /\bworth a\b/i,
  /\bare you (open|free|available)\b/i,
  /\b(can|could|would) (you|we)\b/i,
  /\bwant me to\b/i,
  /\blet me know\b/i,
  /\bbook a\b/i,
  /\bgrab (15|20|30|a few)\b/i,
  /\bshall i\b/i
];

export interface CriticOptions {
  /**
   * Hard ceiling on body length. Real notes between operators compress; slop
   * expands to fill the space it is given. 90 words is about four short
   * paragraphs and is deliberately uncomfortable.
   */
  maxWords?: number;
  /** Fraction of sentences allowed to carry no recipient-specific evidence. */
  maxGenericRatio?: number;
  /** Warnings tolerated before the draft fails. */
  maxWarnings?: number;
  /** `-ly` adverbs per 100 words before the prose reads as padded. */
  maxAdverbsPer100?: number;
}

export const DEFAULT_CRITIC_OPTIONS: Required<CriticOptions> = {
  maxWords: 90,
  maxGenericRatio: 0.5,
  maxWarnings: 2,
  maxAdverbsPer100: 4
};

/** Split into sentences. Abbreviation-naive by design: over-splitting only makes the critic stricter. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A greeting line -- "Hi Jo," -- is structure, not prose.
 *
 * It is excluded from the substitution test because it cannot carry evidence
 * beyond a first name, and first names are routinely too short to qualify as
 * evidence tokens. Scoring it as filler would penalise every correctly
 * formatted email.
 */
export function isGreeting(sentence: string): boolean {
  return /^(hi|hey|hello|dear)\b[^.!?]{0,40}$/i.test(sentence.trim());
}

/**
 * A sign-off -- a bare name on its own line at the end -- is likewise structure.
 * Recognised as one of the last two lines, at most four words, with no terminal
 * punctuation.
 */
export function isSignature(sentence: string, index: number, total: number): boolean {
  if (index < total - 2) return false;
  const trimmed = sentence.trim();
  if (/[.!?]$/.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length <= 4;
}

/** The prose a reader actually weighs, with greeting and sign-off removed. */
export function contentSentences(text: string): string[] {
  const sentences = splitSentences(text);
  return sentences.filter(
    (sentence, index) => !isGreeting(sentence) && !isSignature(sentence, index, sentences.length)
  );
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build the set of tokens that count as proof a sentence is about this
 * recipient. Anything derived from observed facts qualifies; anything the
 * sender could have written before looking does not.
 */
export function evidenceTokens(sources: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const rawWord of source.split(/[\s/._\-:,]+/)) {
      const token = normalizeToken(rawWord);
      // Two-character tokens are too collision-prone to prove specificity.
      if (token.length < 3 || STOPWORDS.has(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function sentenceCarriesEvidence(sentence: string, tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  for (const rawWord of sentence.split(/[\s/._\-:,]+/)) {
    const token = normalizeToken(rawWord);
    if (token.length >= 3 && tokens.has(token)) return true;
  }
  // A bare number (a score, a count, a price) is recipient-specific enough.
  return /\d/.test(sentence);
}

function findPhrases(haystack: string, phrases: readonly string[]): string[] {
  const lower = haystack.toLowerCase();
  return phrases.filter((phrase) => lower.includes(phrase));
}

/**
 * Critique a draft against the recipient's evidence.
 *
 * `evidence` is the list of observed facts about the recipient -- domain,
 * company name, contact name, audit finding, failed check labels. Pass every
 * fact the draft was allowed to use; a token absent here cannot prove
 * specificity.
 */
export function critique(
  body: string,
  evidence: Array<string | null | undefined>,
  options: CriticOptions = {}
): Critique {
  const opts = { ...DEFAULT_CRITIC_OPTIONS, ...options };
  const findings: SlopFinding[] = [];
  const tokens = evidenceTokens(evidence);
  const words = body.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  for (const phrase of findPhrases(body, BANNED_PHRASES)) {
    findings.push({
      check: 'banned-phrase',
      severity: 'block',
      detail: `"${phrase}" is a machine-outreach tell; say the specific thing instead.`,
      excerpt: phrase
    });
  }

  if (wordCount > opts.maxWords) {
    findings.push({
      check: 'too-long',
      severity: 'block',
      detail: `${wordCount} words exceeds the ${opts.maxWords}-word ceiling; cut to the observation and the ask.`
    });
  }

  // The substitution test, over prose only -- greetings and sign-offs are
  // structure and cannot be expected to name anything.
  const sentences = contentSentences(body);
  const generic = sentences.filter((sentence) => !sentenceCarriesEvidence(sentence, tokens));
  const genericRatio = sentences.length === 0 ? 1 : generic.length / sentences.length;
  if (genericRatio > opts.maxGenericRatio) {
    findings.push({
      check: 'generic-sentence',
      severity: 'block',
      detail:
        `${generic.length} of ${sentences.length} sentences name nothing specific to this recipient. ` +
        'Swap them for the observed finding, or delete them.',
      excerpt: generic[0]
    });
  }

  const asks = ASK_PATTERNS.filter((pattern) => pattern.test(body)).length;
  const questionMarks = (body.match(/\?/g) ?? []).length;
  if (asks + questionMarks > 1) {
    findings.push({
      check: 'multiple-asks',
      severity: 'block',
      detail: `${asks + questionMarks} asks detected; a reader answers one question or none.`
    });
  }

  for (const hedge of findPhrases(body, HEDGE_PHRASES)) {
    findings.push({
      check: 'hedging',
      severity: 'warn',
      detail: `"${hedge}" weakens the claim; state it or drop it.`,
      excerpt: hedge
    });
  }

  const adverbs = words.filter((word) => /ly[.,!?]?$/i.test(word) && word.length > 5).length;
  if (wordCount > 0 && (adverbs * 100) / wordCount > opts.maxAdverbsPer100) {
    findings.push({
      check: 'adverb-density',
      severity: 'warn',
      detail: `${adverbs} "-ly" adverbs in ${wordCount} words reads as padding.`
    });
  }

  // The three-item comma list is a signature rhythm of generated prose.
  if (/\w+,\s\w+(\s\w+)?,\s(and|or)\s\w+/i.test(body)) {
    findings.push({
      check: 'tricolon',
      severity: 'warn',
      detail: 'Three-item list detected; generated prose reaches for triads, people name one thing.'
    });
  }

  // The opener is the first line of prose, not the greeting above it.
  const firstSentence = sentences[0] ?? '';
  if (/^(i|we|our|my)\b/i.test(firstSentence)) {
    findings.push({
      check: 'sender-first-opener',
      severity: 'warn',
      detail: 'The first sentence leads with the sender; lead with what you observed about them.',
      excerpt: firstSentence
    });
  }

  const blocking = findings.filter((finding) => finding.severity === 'block');
  const warnings = findings.filter((finding) => finding.severity === 'warn');
  return {
    passed: blocking.length === 0 && warnings.length <= opts.maxWarnings,
    findings,
    wordCount,
    genericRatio: Number(genericRatio.toFixed(3))
  };
}

/** Render a critique as instructions a drafter can act on. */
export function critiqueToInstructions(result: Critique): string {
  if (result.passed) return '';
  return result.findings
    .map((finding) => `- [${finding.severity}] ${finding.check}: ${finding.detail}`)
    .join('\n');
}

const inputSchema = z.object({
  body: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  options: z
    .object({
      maxWords: z.number().int().positive().optional(),
      maxGenericRatio: z.number().min(0).max(1).optional(),
      maxWarnings: z.number().int().min(0).optional(),
      maxAdverbsPer100: z.number().min(0).optional()
    })
    .optional()
});

const outputSchema = z.object({
  passed: z.boolean(),
  wordCount: z.number(),
  genericRatio: z.number(),
  findings: z.array(
    z.object({
      check: z.string(),
      severity: z.enum(['block', 'warn']),
      detail: z.string(),
      excerpt: z.string().optional()
    })
  ),
  instructions: z.string()
});

type CritiqueInput = z.infer<typeof inputSchema>;
type CritiqueOutput = z.infer<typeof outputSchema>;

/**
 * Standalone skill so Claude can critique any copy -- a landing page, a
 * changelog entry, a DM -- not only generated outreach.
 */
export const copyCritiqueSkill: Skill<CritiqueInput, CritiqueOutput> = {
  manifest: {
    id: 'gtm.copy-critique',
    name: 'Critique copy for slop',
    version: '1.0.0',
    description:
      'Deterministically check copy against the substitution test, banned machine-outreach phrases, length, ask count, hedging, and adverb density.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    const result = critique(input.body, input.evidence, input.options ?? {});
    return {
      passed: result.passed,
      wordCount: result.wordCount,
      genericRatio: result.genericRatio,
      findings: result.findings,
      instructions: critiqueToInstructions(result)
    };
  }
};
