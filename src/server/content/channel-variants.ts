import { renderPostBody } from '../../shared/linkedin-post-format.js';
import type { Db } from '../db.js';
import { getPost } from '../linkedin/posts.js';
import { listEnabled } from '../channels/registry.js';
import { prepareChannelPost, type PreparedChannelPost } from '../channels/prepare.js';
import { getContentAsset } from './assets.js';
import { getContentOpportunity } from './opportunities.js';

export interface ContentChannelVariant extends PreparedChannelPost {
  key: string;
  name: string;
  /** This surface is intentionally copy/export only even when the platform has an API. */
  delivery: 'copy_only';
}

export class ContentChannelVariantError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

/**
 * Shape one saved, provenance-linked story draft for Trevra's existing channel
 * registry. This is a pure preparation surface: it reads the current saved post
 * text, applies platform constraints + the copy critic, and never publishes.
 */
export async function contentChannelVariants(
  db: Db,
  input: { workspaceId: string; postId: string; channelKeys?: string[] }
): Promise<ContentChannelVariant[]> {
  const post = await getPost(db, input.workspaceId, input.postId);
  if (!post) throw new ContentChannelVariantError('Content draft not found.', 404);
  if (!post.contentAssetId)
    throw new ContentChannelVariantError(
      'Channel variants require an evidence-backed Trevra content draft.',
      409
    );
  const asset = await getContentAsset(db, input.workspaceId, post.contentAssetId);
  if (!asset)
    throw new ContentChannelVariantError('Content provenance could not be resolved.', 409);
  const opportunity = asset.opportunityId
    ? await getContentOpportunity(db, input.workspaceId, asset.opportunityId)
    : null;

  const requested = input.channelKeys?.length ? new Set(input.channelKeys) : null;
  const channels = listEnabled().filter((channel) => !requested || requested.has(channel.key));
  if (requested) {
    const known = new Set(channels.map((channel) => channel.key));
    const missing = [...requested].filter((key) => !known.has(key));
    if (missing.length > 0)
      throw new ContentChannelVariantError(
        `Unknown or disabled channel: ${missing.join(', ')}.`,
        400
      );
  }

  const body = renderPostBody(post.blocks);
  if (!body.trim()) throw new ContentChannelVariantError('The saved content draft is empty.', 409);
  const title =
    opportunity?.title || asset.hook || body.split(/\n+/)[0]?.slice(0, 200) || 'Trevra story';
  const evidence = [
    ...(opportunity?.evidence.map((item) => item.detail) ?? []),
    ...asset.claimMap.map((claim) => claim.claim)
  ];
  const draft = { title, body };

  return channels.map((channel) => ({
    key: channel.key,
    name: channel.name,
    delivery: 'copy_only' as const,
    ...prepareChannelPost(channel.key, draft, {
      evidence,
      // Long-form destinations should not fail simply because the LinkedIn
      // draft exceeds the email-oriented default critic word ceiling.
      criticOptions: channel.formats.includes('article') ? { maxWords: 5_000 } : undefined
    })
  }));
}
