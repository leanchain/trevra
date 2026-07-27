import { z } from 'zod';
import type { Skill, SkillContext } from './types.js';
import { critique, critiqueToInstructions, type Critique, type CriticOptions } from './voice.js';

/**
 * Draft outreach emails for leads.
 *
 * Ported from the Python reference `src/growth/outreach/drafting.py` --
 * TEMPLATE FALLBACK PATH ONLY. The reference tried an LLM activity over
 * Temporal first and fell back to this template on any failure. Trevra has no
 * Temporal, so the template is the guaranteed path and the LLM slots in at the
 * clearly-marked {@link LlmDrafter} extension point below. The fallback
 * semantics are preserved exactly: any drafter failure logs a warning and
 * yields the deterministic template, so drafting never blocks on a model being
 * unavailable.
 *
 * Compliance footer construction is preserved verbatim: every commercial email
 * carries the postal address and the unsubscribe line, appended after a `---`
 * separator to both the text and the HTML part.
 */

const UNSUBSCRIBE_LINE = "Reply 'unsubscribe' to never hear from us again.";

/**
 * Word budgets. The reference allowed 120 body words; the anti-slop critic in
 * `voice.ts` caps at 90 because slop expands to fill whatever space it is
 * given and real notes between operators compress. The tighter budget is the
 * point, not an oversight.
 */
export const SUBJECT_WORD_CAP = 8;
export const BODY_WORD_CAP = 90;

export const draftLeadSchema = z.object({
  domain: z.string().min(1),
  name: z.string().nullish(),
  contactName: z.string().nullish(),
  contactEmail: z.string().nullish(),
  /** Headline problem from the most recent audit; drives both subject and opener. */
  topFinding: z.string().nullish(),
  /** Supporting detail behind `topFinding`, e.g. the failed check's evidence string. */
  findingDetail: z.string().nullish()
});

export const draftConfigSchema = z.object({
  /**
   * What the sender can concretely do or send next. ONE thing.
   *
   * This replaces the reference's `valueProp`, which pasted the same marketing
   * sentence into every email -- the single largest slop source in the ported
   * template. An offer is falsifiable and recipient-useful; a value prop is
   * neither.
   */
  offer: z.string(),
  /** A person, not a department. "The X Team" reads as unsigned. */
  senderName: z.string(),
  /** Physical postal address -- required in every commercial email. */
  postalAddress: z.string(),
  /**
   * A few sentences the sender actually wrote, handed to the LLM drafter as the
   * style target. Without it a model defaults to its own house voice, which is
   * the thing every recipient has learned to delete.
   */
  voiceSample: z.string().nullish()
});

export type DraftLead = z.infer<typeof draftLeadSchema>;
export type DraftConfig = z.infer<typeof draftConfigSchema>;

export const DEFAULT_DRAFT_CONFIG: DraftConfig = {
  offer: 'I can send the full audit if it is useful.',
  senderName: 'Trevra',
  postalAddress: 'Trevra',
  voiceSample: null
};

/**
 * Trim to `maxWords`, dropping a dangling separator and marking the cut.
 *
 * Note the reference quirk, preserved deliberately: the body is assembled with
 * blank lines between paragraphs and only then word-capped, so a body that
 * actually exceeds the cap collapses into one paragraph. Under the cap -- the
 * normal case -- the text is returned untouched and the paragraphs survive.
 */
export function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ').replace(/[,;:]+$/, '')}…`;
}

export interface Draft {
  subject: string;
  bodyText: string;
}

/**
 * Deterministic fallback draft, used whenever the LLM path is unavailable or
 * its output fails the slop critic.
 *
 * Rewritten from the reference template, which was slop by construction: it
 * pasted a fixed value-proposition sentence into every email, offered two asks
 * in one line ("Worth a 15-minute call, or want me to send the audit?"), and
 * signed off as a department. This version says only what the evidence
 * supports and then stops -- the finding, one consequence, one offer, a name.
 *
 * Where the reference padded, this omits. A three-line note that names a real
 * problem outperforms a five-paragraph note that names none, and it is the
 * only template that can pass its own critic.
 */
export function templateDraft(lead: DraftLead, config: DraftConfig = DEFAULT_DRAFT_CONFIG): Draft {
  const storeName = lead.name || lead.domain;
  const topFinding = lead.topFinding;

  const lines: string[] = [lead.contactName ? `Hi ${lead.contactName},` : 'Hi,'];
  let subject: string;

  if (topFinding) {
    subject = capWords(`${storeName}: ${topFinding}`, SUBJECT_WORD_CAP);
    // Lead with the observation about them, never with the sender.
    lines.push(`${topFinding} on ${lead.domain}.`);
    if (lead.findingDetail) lines.push(`${lead.findingDetail}`);
  } else {
    // No finding means nothing specific to say. Say that, rather than inventing
    // a reason to write -- an unevidenced opener is exactly what the critic
    // rejects, and a human would not send it either.
    subject = capWords(`${storeName}: audit`, SUBJECT_WORD_CAP);
    lines.push(`I ran a visibility audit on ${lead.domain}.`);
  }

  lines.push(config.offer, config.senderName);
  return { subject, bodyText: capWords(lines.join('\n\n'), BODY_WORD_CAP) };
}

export function footerText(postalAddress: string): string {
  return `\n\n---\n${postalAddress}\n${UNSUBSCRIBE_LINE}`;
}

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function wrapHtml(bodyText: string, footer: string): string {
  const bodyHtml = escapeHtml(bodyText).replaceAll('\n', '<br>\n');
  const footerHtml = escapeHtml(footer.trim()).replaceAll('\n', '<br>\n');
  return (
    '<div style="font-family:sans-serif;white-space:pre-wrap;">' +
    bodyHtml +
    '<hr style="margin:24px 0;border:none;border-top:1px solid #ddd;">' +
    `<div style="font-size:12px;color:#888;">${footerHtml}</div>` +
    '</div>'
  );
}

/**
 * EXTENSION POINT -- plug an LLM drafter in here.
 *
 * Supply an implementation via {@link DraftOptions.drafter}. It must return a
 * non-empty subject and body. `revision` carries the critic's findings from the
 * previous attempt so the drafter can fix named defects rather than reroll and
 * hope; on the first attempt it is undefined.
 *
 * Whatever it returns still has to pass {@link critique}. A drafter cannot opt
 * out of the gate, and a model that keeps failing loses to the template.
 */
export type LlmDrafter = (
  lead: DraftLead,
  config: DraftConfig,
  revision?: { previous: Draft; instructions: string }
) => Promise<Draft>;

export interface DraftOptions {
  config?: DraftConfig;
  drafter?: LlmDrafter;
  logger?: SkillContext['logger'];
  /**
   * How many times the drafter may try to satisfy the critic before the
   * template wins. Two is deliberate: one genuine correction pass, then stop
   * paying a model to produce copy a deterministic template already beats.
   */
  maxAttempts?: number;
  criticOptions?: CriticOptions;
}

export interface DraftedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  generator: 'llm' | 'template';
  /** Critique of the copy actually shipped, so the ledger records why it passed. */
  critique: Critique;
}

/**
 * Facts the critic will accept as proof a sentence is about this recipient.
 * Anything the sender could have written before looking at the prospect is
 * excluded on purpose -- that is the whole substitution test.
 */
function leadEvidence(lead: DraftLead): string[] {
  return [lead.domain, lead.name, lead.contactName, lead.topFinding, lead.findingDetail].filter(
    (value): value is string => Boolean(value)
  );
}

export async function draftOutreach(lead: DraftLead, options: DraftOptions = {}): Promise<DraftedEmail> {
  const config = options.config ?? DEFAULT_DRAFT_CONFIG;
  const evidence = leadEvidence(lead);
  let draft = templateDraft(lead, config);
  let generator: 'llm' | 'template' = 'template';

  if (options.drafter) {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    let revision: { previous: Draft; instructions: string } | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const candidate = await options.drafter(lead, config, revision);
        const subject = (candidate.subject ?? '').trim();
        const bodyText = (candidate.bodyText ?? '').trim();
        if (!subject || !bodyText) throw new Error('drafter returned an empty subject/bodyText');

        const verdict = critique(bodyText, evidence, options.criticOptions);
        if (verdict.passed) {
          draft = { subject, bodyText };
          generator = 'llm';
          break;
        }

        // Failed the gate. Feed the named defects back and try once more.
        options.logger?.warn(
          `draft for ${lead.domain} failed the slop critic on attempt ${attempt}`,
          verdict.findings
        );
        revision = { previous: { subject, bodyText }, instructions: critiqueToInstructions(verdict) };
      } catch (cause) {
        options.logger?.warn(`LLM draft failed for lead ${lead.domain}; falling back to template`, cause);
        break;
      }
    }
  }

  const shipped = critique(draft.bodyText, evidence, options.criticOptions);
  const footer = footerText(config.postalAddress);
  const body = draft.bodyText.replace(/\s+$/, '');
  return {
    subject: draft.subject,
    bodyText: `${body}${footer}`,
    bodyHtml: wrapHtml(body, footer),
    generator,
    critique: shipped
  };
}

const inputSchema = z.object({
  lead: draftLeadSchema,
  config: draftConfigSchema.optional()
});

const outputSchema = z.object({
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  bodyHtml: z.string().min(1),
  generator: z.enum(['llm', 'template']),
  toEmail: z.string(),
  critique: z.object({
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
    )
  })
});

type DraftInput = z.infer<typeof inputSchema>;
type DraftOutput = z.infer<typeof outputSchema>;

export const outreachDraftSkill: Skill<DraftInput, DraftOutput> = {
  manifest: {
    id: 'gtm.outreach-draft',
    name: 'Draft outreach email',
    version: '1.0.0',
    description: 'Produce a deterministic, compliance-footed outreach draft for a lead.',
    sideEffect: 'none',
    // Nothing is sent here, but a human owns the words that go out under their name.
    requiresApproval: true,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    if (!input.lead.contactEmail) throw new Error(`lead ${input.lead.domain} has no contact email; cannot draft outreach`);
    const drafted = await draftOutreach(input.lead, { config: input.config, logger: ctx.logger });
    return { ...drafted, toEmail: input.lead.contactEmail };
  }
};
