import { z } from 'zod';
import type { Skill } from '../skills/types.js';
import { critique, critiqueToInstructions, type Critique, type CriticOptions } from '../skills/voice.js';
import type { AutomationMode, ChannelDraft, ChannelPost } from './types.js';
import { getChannel } from './registry.js';
import { channelDraftSchema } from './plan.js';

/**
 * gtm.channel-prepare -- shape a draft for one named channel and put the
 * result through the slop critic.
 *
 * The critic is `skills/voice.ts`, unchanged and unreimplemented: a channel
 * post is copy, and copy that reads like a machine wrote it is worse on a
 * public timeline than in an inbox, because it is permanent and attributable.
 *
 * A failing critique is REPORTED, never swallowed. This skill returns
 * `critique.passed: false` with the findings and the revision instructions;
 * it does not quietly hand back copy that failed the gate.
 */

export interface PreparedChannelPost {
  post: ChannelPost;
  mode: AutomationMode;
  /** Why this mode, verbatim from the adapter. */
  automationReason: string;
  critique: Critique;
  /** Revision instructions, empty when the critique passed. */
  instructions: string;
}

/**
 * The draft's own evidence: what it names that a copy of it sent somewhere
 * else could not name. Mirrors `leadEvidence()` in `skills/draft.ts`.
 */
export function draftEvidence(draft: ChannelDraft): string[] {
  return [draft.title, draft.url, ...(draft.tags ?? [])].filter((value): value is string => Boolean(value));
}

export function prepareChannelPost(
  key: string,
  draft: ChannelDraft,
  options: { evidence?: readonly string[]; criticOptions?: CriticOptions } = {}
): PreparedChannelPost {
  const channel = getChannel(key);
  if (!channel) throw new Error(`unknown channel '${key}'`);

  const post = channel.adapt(draft);
  const evidence = [...draftEvidence(draft), ...(options.evidence ?? [])];
  const verdict = critique(post.body, evidence, options.criticOptions ?? {});

  return {
    post,
    mode: channel.automation.mode,
    automationReason: channel.automation.reason,
    critique: verdict,
    instructions: critiqueToInstructions(verdict)
  };
}

const inputSchema = z.object({
  channel: z.string().min(1),
  draft: channelDraftSchema,
  /** Extra proof the copy is about this specific thing, on top of the draft's own title/url/tags. */
  evidence: z.array(z.string()).default([]),
  /**
   * The critic defaults to an email-length ceiling (90 words). Long-form
   * channels legitimately exceed it, so a caller may raise it -- deliberately,
   * and per call, rather than the module quietly loosening the gate.
   */
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
  post: z.object({
    channelKey: z.string(),
    title: z.string().optional(),
    body: z.string(),
    tags: z.array(z.string()),
    submitUrl: z.string().optional(),
    warnings: z.array(z.string())
  }),
  mode: z.enum(['api-publish', 'prepare-only', 'disabled']),
  automationReason: z.string().min(1),
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
  instructions: z.string()
});

type ChannelPrepareInput = z.infer<typeof inputSchema>;

export const channelPrepareSkill: Skill<ChannelPrepareInput, PreparedChannelPost> = {
  manifest: {
    id: 'gtm.channel-prepare',
    name: 'Prepare a post for one channel',
    version: '1.0.0',
    description:
      "Shape a draft to one channel's constraints and run the result through the slop critic, reporting a failed critique rather than passing the copy through.",
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return prepareChannelPost(input.channel, input.draft, {
      evidence: input.evidence,
      ...(input.criticOptions === undefined ? {} : { criticOptions: input.criticOptions })
    });
  }
};
