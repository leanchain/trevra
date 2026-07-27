import { z } from 'zod';
import type { Skill } from '../skills/types.js';
import type { ChannelAdapter, ChannelDraft, ChannelPost, AutomationMode } from './types.js';
import { getChannel, listEnabled } from './registry.js';

/**
 * gtm.channel-plan -- rank distribution channels for one draft.
 *
 * Deterministic and fully explained: like `skills/score.ts`, every point a
 * channel scores produces a line in `reasons[]`, so a founder can argue with
 * the ranking instead of trusting it.
 */

/** Weights, data-driven so a fork can retune the ranking without touching the loop. */
export const PLAN_WEIGHTS: Readonly<Record<string, number>> = {
  /** Share of the requested audience tags this channel actually reaches. */
  audience: 0.6,
  /** The platform permits programmatic posting, so there is no human step. */
  apiPublish: 0.2,
  /** The draft is ready as written: nothing was reshaped and no precondition is outstanding. */
  readyToPost: 0.2
};

export const channelDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().optional(),
  tags: z.array(z.string()).optional()
});

export interface ChannelPlanEntry {
  key: string;
  name: string;
  /** 0..1, rounded to 3 decimals. */
  fit: number;
  mode: AutomationMode;
  /** Why this mode, verbatim from the adapter. Travels with the ranking so it cannot be lost. */
  automationReason: string;
  matchedAudience: string[];
  post: ChannelPost;
}

export interface ChannelPlan {
  audience: string[];
  ranked: ChannelPlanEntry[];
  reasons: string[];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Normalise an audience tag the same way on both sides of the comparison. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Resolve the candidate set: every enabled channel, or exactly the named keys.
 *
 * Naming a channel explicitly overrides `enabledByDefault` -- an operator who
 * asks for Instagram gets Instagram. An unknown key is an error rather than a
 * silent omission, because silently planning for fewer channels than asked for
 * is how a launch misses a channel.
 */
export function candidateChannels(keys?: readonly string[]): ChannelAdapter[] {
  if (keys === undefined) return listEnabled();
  const resolved: ChannelAdapter[] = [];
  for (const key of keys) {
    const channel = getChannel(key);
    if (!channel) throw new Error(`unknown channel '${key}'`);
    resolved.push(channel);
  }
  return resolved.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Rank channels by audience-tag overlap, automation mode, and how much work is
 * left before the draft can actually go out on that channel.
 *
 * Pure and deterministic: the same draft and audience always produce the same
 * order, tie-broken by channel key.
 */
export function planChannels(
  draft: ChannelDraft,
  audience: readonly string[],
  keys?: readonly string[]
): ChannelPlan {
  const requested = [...new Set(audience.map(normalizeTag).filter(Boolean))].sort();
  const reasons: string[] = [];
  if (requested.length === 0) {
    reasons.push('audience: none given, so no channel earns an audience score');
  }

  const entries: ChannelPlanEntry[] = [];
  for (const channel of candidateChannels(keys)) {
    const serves = new Set(channel.audience.map(normalizeTag));
    const matched = requested.filter((tag) => serves.has(tag));
    const post = channel.adapt(draft);

    let fit = 0;
    reasons.push(`${channel.key}: base 0`);

    if (requested.length > 0) {
      const share = matched.length / requested.length;
      const points = round3(PLAN_WEIGHTS.audience * share);
      if (points > 0) {
        fit += points;
        reasons.push(
          `${channel.key}: +${points} audience ${matched.length}/${requested.length} (${matched.join(', ')})`
        );
      } else {
        reasons.push(`${channel.key}: +0 audience 0/${requested.length} (serves ${channel.audience.join(', ')})`);
      }
    }

    if (channel.automation.mode === 'api-publish') {
      fit += PLAN_WEIGHTS.apiPublish;
      reasons.push(`${channel.key}: +${PLAN_WEIGHTS.apiPublish} api-publish (no human step)`);
    } else {
      reasons.push(`${channel.key}: +0 ${channel.automation.mode} (${channel.automation.reason})`);
    }

    if (post.warnings.length === 0) {
      fit += PLAN_WEIGHTS.readyToPost;
      reasons.push(`${channel.key}: +${PLAN_WEIGHTS.readyToPost} draft is ready as written`);
    } else {
      reasons.push(`${channel.key}: +0 ${post.warnings.length} warning(s) to clear before posting`);
    }

    entries.push({
      key: channel.key,
      name: channel.name,
      fit: round3(fit),
      mode: channel.automation.mode,
      automationReason: channel.automation.reason,
      matchedAudience: matched,
      post
    });
  }

  // Highest fit first; channel key breaks every tie so the order is stable.
  const ranked = [...entries].sort((a, b) => (b.fit - a.fit) || a.key.localeCompare(b.key));
  reasons.push(`order: ${ranked.map((entry) => entry.key).join(' > ')} (fit desc, then key asc)`);

  return { audience: requested, ranked, reasons };
}

const channelPostSchema = z.object({
  channelKey: z.string(),
  title: z.string().optional(),
  body: z.string(),
  tags: z.array(z.string()),
  submitUrl: z.string().optional(),
  warnings: z.array(z.string())
});

const inputSchema = z.object({
  draft: channelDraftSchema,
  /** Who the founder is trying to reach. Free-form lowercase tags, matched against `ChannelAdapter.audience`. */
  audience: z.array(z.string()).default([]),
  /** Restrict the plan to these channel keys. Omit to plan across every enabled channel. */
  channels: z.array(z.string()).optional()
});

const outputSchema = z.object({
  audience: z.array(z.string()),
  ranked: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      fit: z.number().min(0).max(1),
      mode: z.enum(['api-publish', 'prepare-only', 'disabled']),
      automationReason: z.string().min(1),
      matchedAudience: z.array(z.string()),
      post: channelPostSchema
    })
  ),
  reasons: z.array(z.string()).min(1)
});

type ChannelPlanInput = z.infer<typeof inputSchema>;

export const channelPlanSkill: Skill<ChannelPlanInput, ChannelPlan> = {
  manifest: {
    id: 'gtm.channel-plan',
    name: 'Plan distribution channels',
    version: '1.0.0',
    description:
      'Rank distribution channels for a draft by audience overlap, automation mode, and how much reshaping the draft needs, with a reason for every point scored.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return planChannels(input.draft, input.audience, input.channels);
  }
};
