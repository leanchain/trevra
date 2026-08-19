import { z } from 'zod';
import type { Db } from '../db.js';
import { getChannel } from '../channels/registry.js';
import { envCredentials, type CredentialAccessor } from '../research/types.js';
import type { Skill, SkillContext } from '../skills/types.js';
import {
  BLACKLISTED_COMMUNITIES,
  BLACKLISTED_KEYWORDS,
  MAX_SELF_PROMO_RATIO,
  limitsFor,
  readAccountProfiles,
  type AccountProfile
} from './config.js';
import {
  communityVolume,
  countPostsToday,
  lastPostInCommunity,
  type CommunityVolume
} from './store.js';
import { outreachThreadSchema } from './scorer.js';
import type { OutreachThread } from './types.js';

/**
 * The safety gate. Nothing reaches a human for approval without passing here.
 *
 * Ported from the Python reference `tools/outreach/safety.py`, plus the two
 * limits the reference declared in config.yaml and never enforced anywhere:
 * `min_account_age_days` and `min_karma`. Those are not decoration -- a
 * brand-new account replying with a link is the exact shape of spam that gets
 * a domain banned, and the reference shipped with the checks written down and
 * unwired.
 *
 * The daily cap moved here too. In the reference it lived on `BaseScout` and
 * `BasePoster` as two separate `can_post()` methods over the same table, which
 * meant "are we within limits" had two answers depending on which object you
 * asked.
 *
 * EVERY check runs, even after one fails. The reference short-circuited on the
 * first failure, so an operator fixed one blocker only to discover the next on
 * the following run. `reason` still reports the first failure, so the
 * fail-fast semantics callers depended on are unchanged.
 */

export type SafetyCheckName =
  | 'blacklisted-community'
  | 'blacklisted-keyword'
  | 'daily-cap'
  | 'account-age'
  | 'account-karma'
  | 'community-cooldown'
  | 'self-promo-ratio';

export interface SafetyCheck {
  check: SafetyCheckName;
  passed: boolean;
  /** Written for an operator deciding what to do next, not for a log grep. */
  detail: string;
}

export interface SafetyVerdict {
  allowed: boolean;
  /** The first failing check, in the reference's evaluation order. Null when all passed. */
  reason: string | null;
  checks: SafetyCheck[];
  /**
   * What the platform actually permits, straight from the channel adapter.
   * `api-publish` means an approved reply can be delivered by Trevra;
   * anything else means the approved text is handed to a human to post.
   */
  automationMode: 'api-publish' | 'prepare-only' | 'disabled' | 'unknown';
  automationReason: string;
}

/**
 * The three DB-derived facts the gate needs, behind an interface.
 *
 * They vary by (platform, community), never by thread, so a page of fifty rows
 * asks a handful of distinct questions. Callers scoring one thread get the
 * direct implementation and behave exactly as before.
 */
export interface SafetyCounters {
  postsToday(platform: string, now: Date): Promise<number>;
  lastPostInCommunity(platform: string, community: string): Promise<Date | null>;
  communityVolume(platform: string, community: string): Promise<CommunityVolume>;
}

export function dbCounters(db: Db, workspaceId: string): SafetyCounters {
  return {
    postsToday: (platform, now) => countPostsToday(db, workspaceId, platform, now),
    lastPostInCommunity: (platform, community) =>
      lastPostInCommunity(db, workspaceId, platform, community),
    communityVolume: (platform, community) => communityVolume(db, workspaceId, platform, community)
  };
}

/** Same answers, asked once per distinct key. Request-scoped: never a module-level cache. */
export function memoisedCounters(inner: SafetyCounters): SafetyCounters {
  const posts = new Map<string, Promise<number>>();
  const last = new Map<string, Promise<Date | null>>();
  const volume = new Map<string, Promise<CommunityVolume>>();
  const once = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>
  ): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = load();
    cache.set(key, pending);
    return pending;
  };
  return {
    postsToday: (platform, now) => once(posts, platform, () => inner.postsToday(platform, now)),
    lastPostInCommunity: (platform, community) =>
      once(last, `${platform}|${community}`, () => inner.lastPostInCommunity(platform, community)),
    communityVolume: (platform, community) =>
      once(volume, `${platform}|${community}`, () => inner.communityVolume(platform, community))
  };
}

export interface SafetyOptions {
  credentials?: CredentialAccessor;
  /** Overrides the profile read from the environment. Used by the skill's own input and by tests. */
  account?: AccountProfile | null;
  /** Injected DB-derived facts. Defaults to the direct store calls, scoped to this request. */
  counters?: SafetyCounters;
}

function automationOf(
  platform: string
): Pick<SafetyVerdict, 'automationMode' | 'automationReason'> {
  const channel = getChannel(platform);
  if (!channel) {
    return {
      automationMode: 'unknown',
      automationReason: `No channel adapter is registered for '${platform}', so Trevra has no policy statement about posting there. Treated as manual-only.`
    };
  }
  return { automationMode: channel.automation.mode, automationReason: channel.automation.reason };
}

/**
 * Run every gate against one thread.
 *
 * Community-scoped checks (cooldown, self-promo ratio) are skipped when the
 * platform has no community concept -- Hacker News and Stack Overflow have no
 * subreddit equivalent, and inventing one would rate-limit the entire platform
 * to one post per cooldown window.
 */
export async function evaluateSafety(
  db: Db,
  input: { workspaceId: string; thread: OutreachThread },
  now: Date,
  options: SafetyOptions = {}
): Promise<SafetyVerdict> {
  const { thread, workspaceId } = input;
  const limits = limitsFor(thread.platform);
  const credentials = options.credentials ?? envCredentials;
  const declared = options.account !== undefined ? null : readAccountProfiles(credentials);
  const profile =
    options.account !== undefined ? options.account : (declared?.profiles[thread.platform] ?? null);
  // A malformed profiles variable degrades to "no profile" and says so in the
  // check detail, rather than throwing and taking the whole run with it.
  const profileNote = declared?.warning ? ` ${declared.warning}` : '';
  const checks: SafetyCheck[] = [];
  const counters = options.counters ?? dbCounters(db, workspaceId);

  const community = thread.community?.trim() ? thread.community.trim() : null;
  const communityKey = community?.toLowerCase() ?? null;

  const blacklistedCommunity =
    communityKey !== null && BLACKLISTED_COMMUNITIES.includes(communityKey);
  checks.push({
    check: 'blacklisted-community',
    passed: !blacklistedCommunity,
    detail: blacklistedCommunity
      ? `${community} is on the blacklist; it is not a place to reply with a link.`
      : community
        ? `${community} is not blacklisted.`
        : 'Platform has no community concept; nothing to blacklist.'
  });

  const text = `${thread.title} ${thread.content}`.toLowerCase();
  const hitKeyword = BLACKLISTED_KEYWORDS.find((keyword) => text.includes(keyword));
  checks.push({
    check: 'blacklisted-keyword',
    passed: hitKeyword === undefined,
    detail: hitKeyword
      ? `Thread text contains the blacklisted term '${hitKeyword}'.`
      : 'Thread text contains no blacklisted terms.'
  });

  const postsToday = await counters.postsToday(thread.platform, now);
  const underCap = postsToday < limits.maxPostsPerDay;
  checks.push({
    check: 'daily-cap',
    passed: underCap,
    detail: `${postsToday} of ${limits.maxPostsPerDay} ${thread.platform} posts used in the last 24 hours.`
  });

  // An undeclared profile fails any non-zero minimum. Unproven standing is not
  // sufficient standing -- the safe default when the answer is unknown is no.
  const ageOk =
    limits.minAccountAgeDays === 0 ||
    (profile !== null && profile.accountAgeDays >= limits.minAccountAgeDays);
  checks.push({
    check: 'account-age',
    passed: ageOk,
    detail:
      limits.minAccountAgeDays === 0
        ? `${thread.platform} sets no account-age minimum.`
        : profile === null
          ? `${thread.platform} requires an account at least ${limits.minAccountAgeDays} days old, and no profile is declared in OUTREACH_ACCOUNT_PROFILES_JSON.${profileNote}`
          : `Account is ${profile.accountAgeDays} days old; ${limits.minAccountAgeDays} required.`
  });

  const karmaOk = limits.minKarma === 0 || (profile !== null && profile.karma >= limits.minKarma);
  checks.push({
    check: 'account-karma',
    passed: karmaOk,
    detail:
      limits.minKarma === 0
        ? `${thread.platform} sets no karma minimum.`
        : profile === null
          ? `${thread.platform} requires at least ${limits.minKarma} karma, and no profile is declared in OUTREACH_ACCOUNT_PROFILES_JSON.${profileNote}`
          : `Account has ${profile.karma} karma; ${limits.minKarma} required.`
  });

  if (community === null) {
    checks.push({
      check: 'community-cooldown',
      passed: true,
      detail: `${thread.platform} has no community concept; the cooldown does not apply.`
    });
    checks.push({
      check: 'self-promo-ratio',
      passed: true,
      detail: `${thread.platform} has no community concept; the self-promotion ratio does not apply.`
    });
  } else {
    const last = await counters.lastPostInCommunity(thread.platform, community);
    const hoursSince =
      last === null ? Number.POSITIVE_INFINITY : (now.getTime() - last.getTime()) / 3_600_000;
    const cooldownOk = hoursSince >= limits.cooldownHours;
    checks.push({
      check: 'community-cooldown',
      passed: cooldownOk,
      detail: cooldownOk
        ? last === null
          ? `No prior post in ${community}.`
          : `Last post in ${community} was ${hoursSince.toFixed(1)}h ago; ${limits.cooldownHours}h required.`
        : `Posted in ${community} ${hoursSince.toFixed(1)}h ago; ${limits.cooldownHours}h cooldown not elapsed.`
    });

    // (posts + 1) / discovered: what the ratio WOULD become if this reply went
    // out. The reference measured the same way, and its comment explains why --
    // the tool sees only the threads it discovered, never a community's total
    // traffic, so this throttles our frequency against our own visibility.
    const volume = await counters.communityVolume(thread.platform, community);
    const ratio = volume.discovered === 0 ? 0 : (volume.posted + 1) / volume.discovered;
    const ratioOk = volume.discovered === 0 || ratio <= MAX_SELF_PROMO_RATIO;
    checks.push({
      check: 'self-promo-ratio',
      passed: ratioOk,
      detail:
        volume.discovered === 0
          ? `No threads discovered in ${community} yet; the ratio has no denominator.`
          : `Replying makes ${volume.posted + 1} of ${volume.discovered} discovered ${community} threads ours (${(ratio * 100).toFixed(1)}%, ceiling ${(MAX_SELF_PROMO_RATIO * 100).toFixed(0)}%).`
    });
  }

  const failed = checks.find((entry) => !entry.passed);
  return {
    allowed: failed === undefined,
    reason: failed ? `${failed.check}: ${failed.detail}` : null,
    checks,
    ...automationOf(thread.platform)
  };
}

const accountSchema = z.object({
  accountAgeDays: z.number().min(0),
  karma: z.number().min(0)
});

const inputSchema = z.object({
  thread: outreachThreadSchema,
  /** Overrides the platform profile from OUTREACH_ACCOUNT_PROFILES_JSON for this call. */
  account: accountSchema.nullish(),
  /**
   * Fail the run when the gate says no, instead of reporting it.
   *
   * The playbook sets this. The engine's steps are an unconditional DAG, so a
   * verdict that is merely REPORTED cannot stop the chain -- a blocked thread
   * would still be drafted and put in front of a founder to approve, which is
   * how a gate becomes decoration. Throwing is the only stop signal the engine
   * offers, and `runSkill` turns it into a failed step.
   *
   * Defaults to false so the skill stays usable as a question ("may I post
   * here?") without failing the caller.
   */
  requireAllowed: z.boolean().default(false)
});

const outputSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  checks: z.array(
    z.object({
      check: z.enum([
        'blacklisted-community',
        'blacklisted-keyword',
        'daily-cap',
        'account-age',
        'account-karma',
        'community-cooldown',
        'self-promo-ratio'
      ]),
      passed: z.boolean(),
      detail: z.string()
    })
  ),
  automationMode: z.enum(['api-publish', 'prepare-only', 'disabled', 'unknown']),
  automationReason: z.string()
});

type GuardInput = z.infer<typeof inputSchema>;

export const outreachGuardSkill: Skill<GuardInput, SafetyVerdict> = {
  manifest: {
    id: 'gtm.outreach-guard',
    name: 'Community outreach safety gate',
    version: '1.0.0',
    description:
      'Enforce daily caps, account-age and karma minimums, per-community cooldowns, blacklists, and the self-promotion ratio before any reply is prepared for approval.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx: SkillContext) {
    const verdict = await evaluateSafety(
      ctx.db,
      { workspaceId: ctx.workspaceId, thread: input.thread as OutreachThread },
      ctx.now(),
      input.account === undefined ? {} : { account: input.account ?? null }
    );
    if (input.requireAllowed && !verdict.allowed) {
      throw new Error(
        `Outreach blocked for ${input.thread.url} -- ${verdict.reason}. Failing checks: ${verdict.checks
          .filter((entry) => !entry.passed)
          .map((entry) => entry.check)
          .join(', ')}.`
      );
    }
    return verdict;
  }
};
