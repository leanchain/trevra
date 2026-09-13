import type { Db } from '../db.js';
import { prepareStoryEvidenceCard } from './evidence-card.js';
import { prepareStoryCarousel } from './carousel.js';
import { getContentFormatTemplate, type ContentFormatTemplate } from './format-templates.js';
import { prepareStoryLinkedInDraft, StoryDraftError } from './story-draft.js';
import type { ContentAsset } from './types.js';
import type { LinkedInPost } from '../linkedin/posts.js';

export interface PreparedFormatClone {
  template: ContentFormatTemplate;
  asset: ContentAsset;
  post: LinkedInPost;
  reused: boolean;
}

function aspectFor(template: ContentFormatTemplate): 'portrait' | 'square' | 'wide' | null {
  switch (template.structure.visualLayout) {
    case 'portrait_card':
      return 'portrait';
    case 'square_card':
      return 'square';
    case 'wide_card':
      return 'wide';
    default:
      return null;
  }
}

async function resolveTextAssetForPost(
  db: Db,
  workspaceId: string,
  postId: string
): Promise<ContentAsset> {
  const row = await db
    .prepare(
      `SELECT a.id FROM content_assets a
       JOIN linkedin_posts p ON p.workspace_id=a.workspace_id AND p.content_asset_id=a.id
       WHERE p.workspace_id=? AND p.id=? LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, postId);
  if (!row) throw new StoryDraftError('Cloned text asset could not be resolved.', 409);
  const { getContentAsset } = await import('./assets.js');
  const asset = await getContentAsset(db, workspaceId, row.id);
  if (!asset) throw new StoryDraftError('Cloned text asset could not be resolved.', 409);
  return asset;
}

/**
 * Apply a reusable structure to current evidence. The template contains no
 * reference wording, so this path cannot copy the source post's sentences.
 */
export async function prepareStoryFormatClone(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    templateId: string;
    seatKey?: string;
    actorUserId?: string | null;
  },
  now: Date = new Date()
): Promise<PreparedFormatClone> {
  const template = await getContentFormatTemplate(db, input.workspaceId, input.templateId);
  if (!template) throw new StoryDraftError('Content format template not found.', 404);

  if (template.structure.visualLayout === 'carousel') {
    const result = await prepareStoryCarousel(
      db,
      {
        workspaceId: input.workspaceId,
        opportunityId: input.opportunityId,
        seatKey: input.seatKey,
        actorUserId: input.actorUserId,
        formatTemplateId: template.id
      },
      now
    );
    const asset = await resolveTextAssetForPost(db, input.workspaceId, result.post.id);
    return { template, asset, post: result.post, reused: result.reused };
  }

  const aspect = aspectFor(template);
  if (aspect) {
    const result = await prepareStoryEvidenceCard(
      db,
      {
        workspaceId: input.workspaceId,
        opportunityId: input.opportunityId,
        seatKey: input.seatKey,
        actorUserId: input.actorUserId,
        aspect,
        formatTemplateId: template.id
      },
      now
    );
    // The evidence card is a separate asset. Resolve the text asset linked to
    // the post so callers keep one stable response shape.
    const asset = await resolveTextAssetForPost(db, input.workspaceId, result.post.id);
    return { template, asset, post: result.post, reused: result.reused };
  }

  const result = await prepareStoryLinkedInDraft(
    db,
    {
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      seatKey: input.seatKey,
      actorUserId: input.actorUserId,
      formatTemplateId: template.id
    },
    now
  );
  return { template, ...result };
}
