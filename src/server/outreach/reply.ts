import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getChannel } from '../channels/registry.js';
import { critique, critiqueToInstructions, type Critique, type CriticOptions } from '../skills/voice.js';
import type { Skill } from '../skills/types.js';
import { extractTopics, outreachThreadSchema, suggestAngle, type ReplyAngle } from './scorer.js';
import { HIGH_VALUE_KEYWORDS, MEDIUM_KEYWORDS } from './config.js';
import type { OutreachThread } from './types.js';

/**
 * gtm.draft-reply -- write the reply that would go in a discovered thread.
 *
 * Ported from the Python reference `tools/outreach/writer/generator.py`, with
 * three changes that matter:
 *
 * 1. THE PRODUCT IS AN INPUT, not a constant. The reference hardcoded one
 *    product's name, URL, and six benchmark claims into the module. Those are
 *    the operator's claims to make and to stand behind, so they are supplied
 *    per call and appear verbatim in the approval payload.
 * 2. VARIANT SELECTION IS DETERMINISTIC. The reference used `random.choice`,
 *    which means the text a founder approved is not necessarily the text that
 *    would be regenerated from the same inputs. The variant is chosen by
 *    hashing the thread id instead: same thread, same draft, every time --
 *    which is what makes the payload hash on the approval meaningful.
 * 3. THE COPY GOES THROUGH THE SLOP CRITIC (`skills/voice.ts`), unchanged and
 *    unreimplemented. The reference had no quality gate at all. A public
 *    forum is a worse place to post slop than an inbox, because it is
 *    permanent, attributable, and the community downvotes it.
 *
 * A failing critique is REPORTED, never swallowed -- the same contract as
 * `channels/prepare.ts`.
 */

export const productSchema = z.object({
  /** What is being recommended. Appears in the copy and in the approval payload. */
  name: z.string().min(1).max(80),
  url: z.string().url(),
  /** One-line summary of what it does. Used by the deep-dive and alternative angles. */
  summary: z.string().min(1).max(300),
  /**
   * The mechanism, in one sentence: WHY it is cheaper/better, not that it is.
   * A claim with no mechanism behind it is the thing forums punish.
   */
  mechanism: z.string().min(1).max(300),
  /** Verifiable numbers, e.g. `[{ label: 'SWE-bench cost', value: '29.5% lower' }]`. */
  claims: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) })).max(8).default([])
});

export type ReplyProduct = z.infer<typeof productSchema>;

export interface DraftedReply {
  platform: string;
  threadUrl: string;
  angle: ReplyAngle;
  body: string;
  critique: Critique;
  /** Revision instructions; empty string when the critique passed. */
  instructions: string;
  /** What the platform permits. Copied from the channel adapter so approval shows it. */
  automationMode: 'api-publish' | 'prepare-only' | 'disabled' | 'unknown';
  /** Where a human posts it when Trevra may not. */
  submitUrl: string | null;
}

/** Deterministic 0..n-1 pick keyed on the thread. Replaces the reference's `random.choice`. */
function variantFor(thread: OutreachThread, count: number): number {
  if (count <= 1) return 0;
  const digest = createHash('sha256').update(`${thread.platform}:${thread.externalId}`).digest();
  return digest.readUInt32BE(0) % count;
}

function claimList(product: ReplyProduct, take: number): string {
  return product.claims
    .slice(0, take)
    .map((claim) => `${claim.label}: ${claim.value}`)
    .join(', ');
}

/**
 * The thread-specific sentence. Ported from `_extract_post_context`.
 *
 * This is the sentence that makes the reply survive the critic's substitution
 * test -- it names something only THIS thread said.
 */
function threadContext(thread: OutreachThread, product: ReplyProduct): string {
  const text = `${thread.title} ${thread.content}`.toLowerCase();
  const cost = ['token cost', 'api cost', 'expensive', 'burn rate'].find((term) => text.includes(term));
  if (cost) return `You mentioned ${cost} -- ${product.mechanism}`;
  const context = ['context window', 'context length', 'context engineering'].find((term) => text.includes(term));
  if (context) return `On ${context}: ${product.mechanism}`;
  const tool = ['claude code', 'cursor', 'copilot', 'aider'].find((term) => text.includes(term));
  if (tool) return `Since you are on ${tool}: ${product.mechanism}`;
  return product.mechanism;
}

/** Compose the reply body for one angle. */
export function composeReply(thread: OutreachThread, product: ReplyProduct, angle: ReplyAngle): string {
  const context = threadContext(thread, product);
  const numbers = claimList(product, 3);

  if (angle === 'technical_deepdive') {
    const variants = [
      `${context} ${product.name} does this as a local runtime under the agent you already run.${numbers ? ` Measured: ${numbers}.` : ''}\n\n${product.url}`,
      `${context} That is what ${product.name} changes -- ${product.summary}${numbers ? ` Measured: ${numbers}.` : ''}\n\n${product.url}`
    ];
    return variants[variantFor(thread, variants.length)];
  }

  if (angle === 'cost_comparison') {
    const variants = [
      `${context} ${product.name} is what I switched to.${numbers ? ` ${numbers}.` : ''}\n\n${product.url}`,
      `${context} ${product.name} cut this for me.${numbers ? ` ${numbers}.` : ''}\n\n${product.url}`
    ];
    return variants[variantFor(thread, variants.length)];
  }

  if (angle === 'alternative_suggestion') {
    return `${product.name} is the alternative I landed on: ${product.summary} ${context}\n\n${product.url}`;
  }

  return `${context} ${product.name} (${product.url}) is what I use for it.`;
}

/**
 * Evidence for the substitution test: tokens that belong to THIS thread.
 *
 * The critic requires every sentence to carry at least one of these. Feeding
 * it the product name alone would let generic marketing copy pass, so the
 * thread's own title, community, and the cost keywords it actually used are
 * all included.
 */
export function replyEvidence(thread: OutreachThread, product: ReplyProduct): string[] {
  const text = `${thread.title} ${thread.content}`.toLowerCase();
  const matched = [...HIGH_VALUE_KEYWORDS, ...MEDIUM_KEYWORDS].filter((keyword) => text.includes(keyword));
  return [thread.title, thread.community ?? '', product.name, product.url, ...matched, ...product.claims.map((claim) => claim.label)].filter(
    (value) => value.trim().length > 0
  );
}

export function draftReply(
  thread: OutreachThread,
  product: ReplyProduct,
  options: { angle?: ReplyAngle; criticOptions?: CriticOptions } = {}
): DraftedReply {
  const angle = options.angle ?? suggestAngle(thread, extractTopics(thread));
  const body = composeReply(thread, product, angle);
  const verdict = critique(body, replyEvidence(thread, product), options.criticOptions ?? {});
  const channel = getChannel(thread.platform);
  const shaped = channel?.adapt({ title: thread.title, body, url: product.url });

  return {
    platform: thread.platform,
    threadUrl: thread.url,
    angle,
    // Let the channel adapter enforce its own length ceiling; it already knows
    // every platform's limits and is the single place those are maintained.
    body: shaped?.body ?? body,
    critique: verdict,
    instructions: critiqueToInstructions(verdict),
    automationMode: channel?.automation.mode ?? 'unknown',
    // The thread itself is where a human replies -- not the channel's generic
    // "new submission" URL, which would start an unrelated top-level post.
    submitUrl: channel && channel.automation.mode !== 'api-publish' ? thread.url : null
  };
}

const inputSchema = z.object({
  thread: outreachThreadSchema,
  product: productSchema,
  angle: z.enum(['technical_deepdive', 'cost_comparison', 'alternative_suggestion', 'minimal_mention']).optional(),
  criticOptions: z
    .object({
      maxWords: z.number().int().positive().optional(),
      maxGenericRatio: z.number().min(0).max(1).optional(),
      maxWarnings: z.number().int().min(0).optional(),
      maxAdverbsPer100: z.number().min(0).optional()
    })
    .optional()
});

const outputSchema = z.object({
  platform: z.string(),
  threadUrl: z.string(),
  angle: z.enum(['technical_deepdive', 'cost_comparison', 'alternative_suggestion', 'minimal_mention']),
  body: z.string(),
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
  }),
  instructions: z.string(),
  automationMode: z.enum(['api-publish', 'prepare-only', 'disabled', 'unknown']),
  submitUrl: z.string().nullable()
});

type DraftReplyInput = z.infer<typeof inputSchema>;

export const draftReplySkill: Skill<DraftReplyInput, DraftedReply> = {
  manifest: {
    id: 'gtm.draft-reply',
    name: 'Draft a community reply',
    version: '1.0.0',
    description:
      "Write the reply for one discovered thread, shaped to the platform's constraints and put through the anti-slop critic, reporting a failed critique rather than passing the copy through.",
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return draftReply(input.thread as OutreachThread, input.product, {
      ...(input.angle === undefined ? {} : { angle: input.angle }),
      ...(input.criticOptions === undefined ? {} : { criticOptions: input.criticOptions })
    });
  }
};
