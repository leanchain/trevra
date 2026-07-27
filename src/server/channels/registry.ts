import type { Db } from '../db.js';
import type { ChannelAdapter } from './types.js';
import { devtoChannel } from './adapters/devto.js';
import { hashnodeChannel } from './adapters/hashnode.js';
import { githubChannel } from './adapters/github.js';
import { mastodonChannel } from './adapters/mastodon.js';
import { blueskyChannel } from './adapters/bluesky.js';
import { hackernewsChannel } from './adapters/hackernews.js';
import { redditChannel } from './adapters/reddit.js';
import { linkedinChannel } from './adapters/linkedin.js';
import { xChannel } from './adapters/x.js';
import { producthuntChannel } from './adapters/producthunt.js';
import { indiehackersChannel } from './adapters/indiehackers.js';
import { lobstersChannel } from './adapters/lobsters.js';
import { instagramChannel } from './adapters/instagram.js';

/**
 * Distribution-channel registry.
 *
 * ADDING A CHANNEL IS ONE FILE AND ONE REGISTER CALL. Drop an adapter into
 * `adapters/`, import it, and add it to the list below. Nothing else in the
 * codebase needs to know it exists -- ranking, shaping, seeding, and the tests
 * are all driven off `listChannels()`.
 *
 * THE RULE THAT MAKES THIS REGISTRY WORTH FORKING: any channel whose platform
 * forbids, gates, or meters programmatic posting MUST ship as `prepare-only`,
 * with the policy fact that makes it so written into `automation.reason` in
 * the adapter file itself. Not a doc, not a wiki -- the code, next to the
 * constraint it justifies. This is lifted directly from the `app_store` entry
 * in the Python reference registry (`src/growth/sources/registry.py`), which
 * ships disabled with its ToS reason inline. When in doubt, `prepare-only`:
 * over-claiming automation here gets a user's account banned, and a wrong
 * `api-publish` is a much more expensive mistake than a redundant human step.
 *
 * NO PUBLISH PATH LIVES HERE, DELIBERATELY. `adapt()` is pure and does no I/O;
 * the skills in `plan.ts` and `prepare.ts` are `sideEffect: 'none'`. Actually
 * posting is an `external-write`, so it must route through Trevra's existing
 * approval gate and payload-hashing path (`action-service.ts`: an action is
 * only executed while its stored `payload_hash` still matches the
 * `approved_payload_hash` a human signed off). Wiring channel publishing into
 * that path -- per-channel credentials, rate limits, retry semantics, and the
 * `channels.account_ref` / `post_count` bookkeeping -- is a separate task and
 * is intentionally absent from this pass.
 *
 * Seeding philosophy, carried over from `skills/registry.ts` and the Python
 * reference: `seedChannels` only ever CREATES missing rows and refreshes the
 * code-owned columns. It never rewrites an operator-set `enabled` flag,
 * `config_json`, or `account_ref`. `registerChannel` follows the same rule in
 * memory: a key that is already registered wins, so repeated imports are a
 * no-op rather than a silent overwrite.
 */

const channels = new Map<string, ChannelAdapter>();

/**
 * Register `channel` unless its key is already taken. Returns whatever is
 * registered under that key, so callers always get the live instance.
 */
export function registerChannel(channel: ChannelAdapter): ChannelAdapter {
  const existing = channels.get(channel.key);
  if (existing) return existing;
  channels.set(channel.key, channel);
  return channel;
}

export function getChannel(key: string): ChannelAdapter | undefined {
  return channels.get(key);
}

/** All registered channels, ordered by key so listings are stable. */
export function listChannels(): ChannelAdapter[] {
  return [...channels.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Channels a founder gets without opting in. A channel is off by default when
 * using it would silently fail or produce something unusable -- see
 * `adapters/instagram.ts`.
 */
export function listEnabled(): ChannelAdapter[] {
  return listChannels().filter((channel) => channel.enabledByDefault);
}

for (const channel of [
  devtoChannel,
  hashnodeChannel,
  githubChannel,
  mastodonChannel,
  blueskyChannel,
  hackernewsChannel,
  redditChannel,
  linkedinChannel,
  xChannel,
  producthuntChannel,
  indiehackersChannel,
  lobstersChannel,
  instagramChannel
]) {
  registerChannel(channel);
}

/**
 * Idempotently back-fill the `channels` table from the registry.
 *
 * `enabled`, `config_json`, `account_ref`, `last_post_at`, and `post_count`
 * are deliberately absent from the conflict update: they are operator and
 * runtime state, not code state. `name` and `automation_mode` are code state,
 * so a channel that loses its API access upstream flips to `prepare-only` for
 * every existing install on the next deploy.
 */
export async function seedChannels(db: Db, now: Date = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const channel of listChannels()) {
    await db.prepare(`
      INSERT INTO channels (key, name, enabled, automation_mode, config_json, created_at, updated_at)
      VALUES (?,?,?,?,?::jsonb,?,?)
      ON CONFLICT(key) DO UPDATE SET
        name=excluded.name,
        automation_mode=excluded.automation_mode,
        updated_at=excluded.updated_at
    `).run(
      channel.key,
      channel.name,
      channel.enabledByDefault,
      channel.automation.mode,
      JSON.stringify(channel.defaultConfig ?? {}),
      timestamp,
      timestamp
    );
  }
}
