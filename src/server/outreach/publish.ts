import { z } from 'zod';
import type { Db } from '../db.js';
import { getChannel } from '../channels/registry.js';
import { envCredentials, type CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { createSsrfFetch } from '../skills/guard.js';
import { countPostsToday, existingPost, lastPostInCommunity, recordPost, settlePost } from './store.js';
import { limitsFor } from './config.js';

/**
 * Delivery for an APPROVED community reply.
 *
 * Reached only from `control-plane/execution.ts`, which the playbook engine
 * calls only after it has matched the action payload's canonical hash against
 * the hash a human approved. There is no other entry point, and nothing here
 * posts anything that a human has not signed off byte for byte.
 *
 * TWO GATES DECIDE WHETHER TREVRA MAY PRESS THE BUTTON, and both must pass:
 *
 * 1. THE CHANNEL'S POLICY (`channels/adapters/*.ts`). `prepare-only` means the
 *    platform's rules make unattended posting a ban risk. Reddit is the case
 *    that matters: its API can post, the reference happily did, and doing so
 *    unattended is what gets an account shadowbanned.
 * 2. WHETHER A REPLY API EXISTS AT ALL. This is NOT the same question, and
 *    conflating them would be a real bug: a channel is `api-publish` when it
 *    can PUBLISH YOUR OWN POST. dev.to can publish an article and has no
 *    comment endpoint whatsoever; replying to someone else's thread there is
 *    not something an API can do at any policy setting.
 *
 * Failing either gate is not an error. The reply becomes a MANUAL HANDOFF: the
 * approved text is written to the post log with the thread URL, and the
 * founder posts it themselves. That still consumes the daily cap and starts
 * the community cooldown, because a human posting it costs the community
 * exactly as much attention as a machine posting it would.
 */

export const communityReplyPayloadSchema = z.object({
  platform: z.string().min(1).max(40),
  threadExternalId: z.string().min(1).max(200),
  threadUrl: z.string().url(),
  community: z.string().max(200).nullish(),
  body: z.string().min(1).max(20_000),
  /**
   * Carries `safetyAllowed`, which this module REQUIRES to be exactly `true`.
   *
   * The safety verdict is part of the payload a human approved, so it is
   * covered by the approval hash: it cannot be flipped after the fact without
   * invalidating the approval and failing the action. That is what makes
   * carrying the decision here equivalent to re-deriving it, and it closes the
   * gap where a custom playbook omits the guard step entirely.
   */
  metadata: z.record(z.unknown()).optional()
});

export type CommunityReplyPayload = z.infer<typeof communityReplyPayloadSchema>;

export interface PublishOptions {
  credentials?: CredentialAccessor;
  fetchImpl?: FetchLike;
}

interface PublishOutcome {
  provider: string;
  externalRef: string;
}

/** The platform answered and refused. The claim on this payload is released for retry. */
export class PlatformRejection extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PlatformRejection';
  }
}

/**
 * We never learned whether the platform accepted it -- timeout, DNS, reset.
 *
 * Deliberately NOT retryable. If the request landed and only the response was
 * lost, retrying posts a second public comment on a stranger's thread. A
 * missing comment can be posted by hand; a duplicate cannot be unposted, and
 * duplicate replies are exactly what gets an account banned for spam.
 */
export class PlatformUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformUnreachable';
  }
}

/**
 * POST and parse, distinguishing "refused" from "never answered".
 *
 * The scouts' `getJson` collapses both into `null` because for a READ they are
 * the same thing -- no data. For a WRITE they are opposite: one is safe to
 * retry and the other is not.
 */
async function postJson(
  client: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await client(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (cause) {
    throw new PlatformUnreachable(`no response from ${new URL(url).host}: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    // A 5xx comes from a gateway or a half-failed backend and does NOT prove
    // the origin skipped creating the comment. Treated as unknown, not as a
    // refusal, so the claim is held rather than released for retry. Only a 4xx
    // is evidence that nothing was written.
    const detail = await response.text().catch(() => '');
    throw new PlatformUnreachable(
      `${new URL(url).host} answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}; whether the write landed is unknown`
    );
  }

  if (response.status === 408) {
    // "I stopped waiting", not "I did not write it".
    throw new PlatformUnreachable(`${new URL(url).host} answered HTTP 408; whether the write landed is unknown`);
  }

  if (response.status < 200 || response.status > 299) {
    const detail = await response.text().catch(() => '');
    throw new PlatformRejection(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // A 2xx we cannot parse still means the write happened.
    throw new PlatformUnreachable(`${new URL(url).host} accepted the write but returned an unreadable body`);
  }
  // `null` parses fine and is not indexable, so reading `.id` off it throws a
  // bare TypeError -- which the caller would classify as "nothing published"
  // and RELEASE the claim on a write the platform answered 2xx for. Anything
  // that is not an object is an unknown outcome, never a refusal.
  if (parsed === null || typeof parsed !== 'object') {
    throw new PlatformUnreachable(`${new URL(url).host} accepted the write but returned an unreadable body`);
  }
  return parsed as Record<string, unknown>;
}

const WRITE_TIMEOUT_MS = 15_000;

/**
 * The guarded client for WRITES. Not `scoutClient`.
 *
 * `createSsrfFetch` follows redirects by re-issuing `{ ...init }`, which for a
 * POST re-sends the method AND the body on every hop -- so one approved comment
 * becomes up to `maxRedirects` identical comments, all inside a single claim
 * and therefore invisible to the replay guard. GitHub answers 301 on the REST
 * API for a renamed repo, so this needs no attacker.
 *
 * A write must never be replayed to a destination we did not address, so the
 * budget is zero: at most one request leaves, and a redirect surfaces as an
 * `SsrfError` that `postJson` converts to `PlatformUnreachable`, holding the
 * claim. `control-plane/execution.ts` reaches the same conclusion with
 * `redirect: 'error'` on its own write path.
 */
function writeClient(fetchImpl?: FetchLike): FetchLike {
  return createSsrfFetch({ resolve: fetchImpl === undefined, fetchImpl, maxRedirects: 0 });
}

type ReplyPublisher = (
  payload: CommunityReplyPayload,
  options: { credentials: CredentialAccessor; client: FetchLike }
) => Promise<PublishOutcome>;

/**
 * Platforms with a documented API for replying to SOMEONE ELSE'S thread.
 *
 * Deliberately short. Everything absent from this map is a manual handoff, and
 * the reason is a fact about the platform, not a gap in this file:
 * - hackernews    -- no write API of any kind.
 * - devto         -- publishes articles; exposes no comment endpoint.
 * - lobsters      -- no write API.
 * - stackoverflow -- the Stack Exchange write API does not cover answers.
 * - reddit        -- has one, and is `prepare-only` by policy. Gate 1 stops it.
 * - linkedin      -- disabled outright; see scouts/linkedin.ts.
 */
const REPLY_PUBLISHERS: Readonly<Record<string, ReplyPublisher>> = {
  async github(payload, { credentials, client }) {
    const token = credentials.get('GITHUB_TOKEN');
    if (!token) throw new Error('GITHUB_TOKEN is required to post a GitHub comment.');
    const match = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(payload.threadUrl);
    if (!match) throw new Error(`Could not derive owner/repo/number from GitHub URL: ${payload.threadUrl}`);
    const [, owner, repo, number] = match;

    const result = await postJson(
      client,
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      JSON.stringify({ body: payload.body })
    );
    if (!result.id) throw new PlatformUnreachable('GitHub accepted the comment but returned no id.');
    return { provider: 'github', externalRef: String(result.html_url ?? result.id) };
  },

  async mastodon(payload, { credentials, client }) {
    const token = credentials.get('MASTODON_ACCESS_TOKEN');
    if (!token) throw new Error('MASTODON_ACCESS_TOKEN is required to post a Mastodon reply.');
    const instance = (credentials.get('MASTODON_INSTANCE_URL') ?? 'https://mastodon.social').replace(/\/+$/, '');

    const result = await postJson(
      client,
      `${instance}/api/v1/statuses`,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Mastodon's own replay guard, on top of ours.
        'Idempotency-Key': payload.threadExternalId
      },
      JSON.stringify({ status: payload.body, in_reply_to_id: payload.threadExternalId, visibility: 'public' })
    );
    if (!result.id) throw new PlatformUnreachable('Mastodon accepted the status but returned no id.');
    return { provider: 'mastodon', externalRef: String(result.url ?? result.id) };
  }
};

/**
 * Throw if posting now would breach the daily cap or a live community cooldown.
 *
 * Time-varying limits only. An approval is a decision about CONTENT; these two
 * are facts about the clock, and the clock moves after the founder clicks.
 */
export async function assertPostingWindow(
  db: Db,
  workspaceId: string,
  platform: string,
  community: string | null,
  now: Date
): Promise<void> {
  const limits = limitsFor(platform);
  const postsToday = await countPostsToday(db, workspaceId, platform, now);
  if (postsToday >= limits.maxPostsPerDay) {
    throw new Error(
      `Daily cap reached for ${platform}: ${postsToday} of ${limits.maxPostsPerDay} posts used in the last 24 hours. The approval is still valid; re-run the action once the window clears.`
    );
  }
  if (community) {
    const last = await lastPostInCommunity(db, workspaceId, platform, community);
    if (last) {
      const hoursSince = (now.getTime() - last.getTime()) / 3_600_000;
      if (hoursSince < limits.cooldownHours) {
        throw new Error(
          `Cooldown active for ${community}: last post was ${hoursSince.toFixed(1)}h ago and ${limits.cooldownHours}h is required.`
        );
      }
    }
  }
}

/** Why this reply cannot be delivered by Trevra, or null when it can. */
export function handoffReason(platform: string): string | null {
  const channel = getChannel(platform);
  if (!channel) return `No channel adapter is registered for '${platform}', so Trevra has no policy statement permitting it to post there.`;
  if (channel.automation.mode !== 'api-publish') return `${channel.name} is ${channel.automation.mode}: ${channel.automation.reason}`;
  if (!REPLY_PUBLISHERS[platform]) return `${channel.name} publishes your own posts but exposes no API for replying to someone else's thread.`;
  return null;
}

/**
 * Deliver, or record the handoff. Never throws for a policy decision -- only
 * for a platform that accepted the request and then failed it.
 */
export async function publishCommunityReply(
  db: Db,
  workspaceId: string,
  payload: CommunityReplyPayload,
  payloadHash: string,
  now: Date,
  options: PublishOptions = {}
): Promise<PublishOutcome & { status: 'posted' | 'manual_handoff'; postId: string; duplicate: boolean }> {
  const credentials = options.credentials ?? envCredentials;
  const community = payload.community?.trim() ? payload.community.trim() : null;
  const base = {
    workspaceId,
    platform: payload.platform,
    community,
    threadExternalId: payload.threadExternalId,
    threadUrl: payload.threadUrl,
    payloadHash,
    body: payload.body
  };

  // ORDER MATTERS, and it is: safety decision -> replay guard -> time-varying
  // limits -> handoff-or-post. The handoff branch used to run first, which
  // skipped the replay guard and the cap entirely.

  // Gate 0. The safety verdict travels inside the hash-approved payload, so a
  // blocked reply cannot be posted even by a playbook that omits the guard
  // step or by a hand-built action. Absent means blocked: fail closed.
  if (payload.metadata?.safetyAllowed !== true) {
    throw new Error(
      `Refusing to post to ${payload.platform}: the approved payload does not carry a passing safety verdict (metadata.safetyAllowed !== true).`
    );
  }

  const already = await existingPost(db, workspaceId, payloadHash);
  if (already) {
    if (already.status === 'pending') {
      // A previous execution claimed this payload and never learned the
      // outcome. Returning a handoff here would send a human to post a reply
      // that may already be live -- the same duplicate the hold exists to
      // prevent, just committed by a person instead of a process.
      throw new Error(
        `A previous execution of this approved payload for ${payload.threadUrl} is unresolved (post ${already.id}); its outcome is unknown. Check the thread and settle post ${already.id} by hand rather than retrying.`
      );
    }
    return {
      provider: already.provider ?? 'manual-handoff',
      externalRef: already.external_ref ?? payload.threadUrl,
      status: already.status === 'posted' ? 'posted' : 'manual_handoff',
      postId: already.id,
      duplicate: true
    };
  }

  // Re-check the two limits that can move BETWEEN approval and execution.
  // Applies to handoffs too: a human posting it consumes the same community
  // attention, and the cap counts handoffs.
  await assertPostingWindow(db, workspaceId, payload.platform, community, now);

  const reason = handoffReason(payload.platform);
  if (reason) {
    const logged = await recordPost(
      db,
      { ...base, status: 'manual_handoff', provider: 'manual-handoff', externalRef: payload.threadUrl, error: null },
      now
    );
    if (logged.duplicate) {
      // Lost the race to a concurrent execution, same as the api-publish claim
      // below. Returning a second handoff would put the same reply in front of
      // a human twice, and a person pasting it twice is as much a duplicate as
      // a process posting it twice.
      throw new Error(
        `Another execution already prepared this approved payload for ${payload.threadUrl} (post ${logged.id}); not handing it off a second time.`
      );
    }
    return { provider: 'manual-handoff', externalRef: payload.threadUrl, status: 'manual_handoff', postId: logged.id, duplicate: false };
  }

  // CLAIM THE PAYLOAD HASH BEFORE THE WRITE. The claim is what makes a retry
  // safe: if this process dies mid-request, or the platform accepts the
  // comment and the response is lost, the `pending` row is still covered by
  // the partial unique index, so the next attempt short-circuits above rather
  // than posting a second comment.
  const claim = await recordPost(db, { ...base, status: 'pending', provider: null, externalRef: null, error: null }, now);
  if (claim.duplicate) {
    // Lost the race to a concurrent execution of the same approved payload --
    // `existingPost` above saw nothing, and between then and now the other
    // execution claimed it. Reporting a handoff here would tell the founder to
    // go post a reply that another worker is already sending, so this is an
    // error rather than an outcome.
    throw new Error(
      `Another execution already claimed this approved payload for ${payload.threadUrl} (post ${claim.id}); not posting a second time.`
    );
  }

  const publisher = REPLY_PUBLISHERS[payload.platform];
  let outcome: PublishOutcome;
  try {
    outcome = await publisher(payload, { credentials, client: writeClient(options.fetchImpl) });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof PlatformUnreachable) {
      // Outcome genuinely unknown. HOLD the claim so no retry can duplicate the
      // comment, and tell the operator to check the thread by hand.
      await settlePost(db, claim.id, { status: 'pending', provider: null, externalRef: null, error: message });
      throw new Error(
        `Posting the approved reply to ${payload.platform} did not complete and its outcome is unknown: ${message}. The payload is held so a retry cannot double-post -- check ${payload.threadUrl} and settle post ${claim.id} by hand.`
      );
    }
    // The platform answered and refused, so nothing was published. Release the
    // claim ('failed' is excluded from the index) and let the engine retry.
    await settlePost(db, claim.id, { status: 'failed', provider: null, externalRef: null, error: message });
    throw new Error(`Posting the approved reply to ${payload.platform} failed: ${message}`);
  }

  // SETTLED OUTSIDE THE TRY, DELIBERATELY. The comment is public by this point.
  // If this UPDATE were inside the catch's reach, a pool blip here would write
  // 'failed', release the claim, and the engine's next retry would post a
  // SECOND comment. Letting it throw leaves the row 'pending' -- the claim
  // stands, no retry can duplicate, and the operator settles it by hand.
  await settlePost(db, claim.id, { status: 'posted', provider: outcome.provider, externalRef: outcome.externalRef, error: null });
  return { ...outcome, status: 'posted', postId: claim.id, duplicate: false };
}
