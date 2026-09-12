import type { PostBlock } from '../../shared/linkedin-post-format.js';
import { id, type Db } from '../db.js';
import { createPost, type LinkedInPost } from '../linkedin/posts.js';
import { createContentAsset, getContentAsset } from './assets.js';
import { getContentOpportunity } from './opportunities.js';
import { contentPerformanceReport } from './performance.js';
import { contentDraftStrategy, type ContentDraftStrategy } from './strategy.js';
import type {
  ClaimMapEntry,
  ContentAngle,
  ContentAsset,
  ContentEvidenceRef,
  ContentOpportunity
} from './types.js';

const RENDERER_VERSION = 'linkedin-evidence-v2';

export class StoryDraftError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function generationKey(opportunityId: string, seatKey: string): string {
  return `story:${opportunityId}:linkedin:${seatKey}:${RENDERER_VERSION}`;
}

function textBlocks(body: string): PostBlock[] {
  return body.split(/\n\n+/).map((paragraph) => ({
    runs: [{ type: 'text' as const, text: paragraph }]
  }));
}

function hookFamily(angle: ContentAngle): string {
  switch (angle) {
    case 'teardown':
      return 'teardown';
    case 'list':
      return 'numbered-list';
    case 'comparison':
      return 'comparison';
    default:
      return 'change-led';
  }
}

function deterministicCopy(
  input: ContentOpportunity,
  strategy: ContentDraftStrategy
): { body: string; claimMap: ClaimMapEntry[] } {
  const evidence = input.evidence.slice(0, 4);
  if (evidence.length === 0) throw new StoryDraftError('This story has no source evidence.');
  let body: string;
  switch (strategy.angle) {
    case 'teardown':
      body = [
        input.title,
        'A quick teardown of what changed:',
        ...evidence.map((item) => `• ${item.detail}`),
        `Read together: ${input.thesis}`
      ].join('\n\n');
      break;
    case 'list':
      body = [
        input.title,
        `${evidence.length} changes worth watching:`,
        ...evidence.map((item, index) => `${index + 1}. ${item.detail}`),
        input.thesis
      ].join('\n\n');
      break;
    case 'comparison':
      body = [
        input.title,
        'What lines up:',
        ...evidence.map((item) => `• ${item.detail}`),
        input.thesis
      ].join('\n\n');
      break;
    default:
      body = [
        input.title,
        input.thesis,
        'What changed:',
        ...evidence.map((item) => `• ${item.detail}`)
      ].join('\n\n');
      break;
  }
  const claimMap: ClaimMapEntry[] = [
    { claim: input.title, evidence },
    { claim: input.thesis, evidence },
    ...evidence.map((item) => ({ claim: item.detail, evidence: [item] }))
  ];
  return { body, claimMap };
}

export interface PreparedStoryLinkedInDraft {
  asset: ContentAsset;
  post: LinkedInPost;
  reused: boolean;
}

/**
 * Render one evidence-backed story into an editable LinkedIn draft.
 *
 * No model, no network, no scheduling. The advisory lock plus generation key
 * makes double-clicks idempotent while still allowing future renderer versions
 * or channels to intentionally create a distinct variant.
 */
export async function prepareStoryLinkedInDraft(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    seatKey?: string;
    actorUserId?: string | null;
  },
  now: Date = new Date()
): Promise<PreparedStoryLinkedInDraft> {
  const seatKey = input.seatKey?.trim() || 'owner';
  const key = generationKey(input.opportunityId, seatKey);
  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${input.workspaceId}\u001f${key}`);

    const existing = await tx
      .prepare(
        `SELECT a.id AS asset_id,p.id AS post_id
         FROM content_assets a
         JOIN linkedin_posts p
           ON p.workspace_id=a.workspace_id AND p.content_asset_id=a.id
         WHERE a.workspace_id=?
           AND a.generation_json->>'idempotencyKey'=?
         ORDER BY a.created_at ASC,a.id ASC LIMIT 1`
      )
      .get<{ asset_id: string; post_id: string }>(input.workspaceId, key);
    if (existing) {
      const asset = await getContentAsset(tx, input.workspaceId, existing.asset_id);
      const postRow = await tx
        .prepare('SELECT id FROM linkedin_posts WHERE workspace_id=? AND id=?')
        .get<{ id: string }>(input.workspaceId, existing.post_id);
      if (!asset || !postRow)
        throw new StoryDraftError('Existing story draft could not be resolved.', 409);
      const { getPost } = await import('../linkedin/posts.js');
      const post = await getPost(tx, input.workspaceId, existing.post_id);
      if (!post) throw new StoryDraftError('Existing LinkedIn draft could not be resolved.', 409);
      return { asset, post, reused: true };
    }

    const opportunity = await getContentOpportunity(tx, input.workspaceId, input.opportunityId);
    if (!opportunity) throw new StoryDraftError('Content opportunity not found.', 404);
    if (opportunity.status === 'dismissed' || opportunity.status === 'expired')
      throw new StoryDraftError('This story is no longer available for drafting.', 409);

    const performance = await contentPerformanceReport(tx, input.workspaceId, 200);
    const strategy = contentDraftStrategy(opportunity, performance);
    const rendered = deterministicCopy(opportunity, strategy);
    const asset = await createContentAsset(
      tx,
      {
        workspaceId: input.workspaceId,
        opportunityId: opportunity.id,
        format: 'text_post',
        angle: strategy.angle,
        hook: opportunity.title,
        body: rendered.body,
        claimMap: rendered.claimMap,
        generation: {
          idempotencyKey: key,
          renderer: RENDERER_VERSION,
          mode: 'deterministic-evidence',
          features: {
            opportunityKind: opportunity.kind,
            format: 'text_post',
            angle: strategy.angle,
            hookFamily: hookFamily(strategy.angle),
            evidenceSourceTypes: [
              ...new Set(opportunity.evidence.map((item) => item.sourceType))
            ].sort(),
            evidenceLabels: [...new Set(opportunity.evidence.map((item) => item.label))].sort(),
            evidenceCount: opportunity.evidence.length,
            entityCount: opportunity.kind === 'company_change' ? 1 : null,
            contentLength: rendered.body.length
          },
          learning: {
            version: strategy.version,
            source: strategy.source,
            reason: strategy.reason,
            minimumSample: strategy.minimumSample,
            eligibleAngles: strategy.eligibleAngles,
            hints: strategy.hints
          }
        },
        createdBy: input.actorUserId ?? null
      },
      now
    );
    const post = await createPost(
      tx,
      {
        id: id('lipost'),
        workspaceId: input.workspaceId,
        seatKey,
        blocks: textBlocks(rendered.body),
        status: 'draft',
        createdBy: input.actorUserId ?? null,
        contentAssetId: asset.id,
        publicationMeta: {
          contentOpportunityId: opportunity.id,
          renderer: RENDERER_VERSION,
          contentAngle: strategy.angle,
          strategySource: strategy.source
        }
      },
      now
    );
    return { asset, post, reused: false };
  });
}
