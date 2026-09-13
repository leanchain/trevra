import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createPost } from '../linkedin/posts.js';
import { contentChannelVariants } from './channel-variants.js';
import { upsertContentOpportunity } from './opportunities.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';

let db: Db;
const WORKSPACE = 'ws_channel_variants';
const OTHER = 'ws_channel_variants_other';
const NOW = new Date('2026-09-13T00:30:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
});

async function preparedStory() {
  const story = await upsertContentOpportunity(
    db,
    {
      workspaceId: WORKSPACE,
      kind: 'company_change',
      title: 'Nova changed hiring and pricing',
      thesis: 'Two source-backed changes happened this week.',
      freshnessAt: NOW.toISOString(),
      score: 90,
      rationale: ['two independent facts'],
      fingerprint: 'channel-variant-story',
      evidence: [
        {
          sourceType: 'external_observation',
          sourceId: 'nova-role-change',
          label: 'Nova · hiring',
          detail: 'Nova added seven platform roles.',
          sourceUrl: 'https://nova.example/careers',
          observedAt: NOW.toISOString()
        },
        {
          sourceType: 'external_observation',
          sourceId: 'nova-pricing-change',
          label: 'Nova · pricing',
          detail: 'Nova changed enterprise pricing.',
          sourceUrl: 'https://nova.example/pricing',
          observedAt: NOW.toISOString()
        }
      ]
    },
    NOW
  );
  return prepareStoryLinkedInDraft(
    db,
    { workspaceId: WORKSPACE, opportunityId: story.id, seatKey: 'owner' },
    NOW
  );
}

describe('content channel variants', () => {
  it('shapes the saved evidence-backed draft through existing adapters without publishing', async () => {
    const prepared = await preparedStory();
    const variants = await contentChannelVariants(db, {
      workspaceId: WORKSPACE,
      postId: prepared.post.id,
      channelKeys: ['linkedin', 'x', 'devto']
    });
    expect(variants.map((variant) => variant.key)).toEqual(['devto', 'linkedin', 'x']);
    for (const variant of variants) expect(variant.delivery).toBe('copy_only');
    const x = variants.find((variant) => variant.key === 'x')!;
    expect(x.post.body.length).toBeLessThanOrEqual(280);
    expect(x.mode).toBe('prepare-only');
    expect(x.post.submitUrl).toContain('x.com');
    const linkedIn = variants.find((variant) => variant.key === 'linkedin')!;
    expect(linkedIn.post.body).toContain('Nova added seven platform roles.');
    expect(linkedIn.post.body).toContain('Nova changed enterprise pricing.');
    const devto = variants.find((variant) => variant.key === 'devto')!;
    expect(devto.post.title).toContain('Nova changed hiring and pricing');

    const unchanged = await db
      .prepare(
        'SELECT status,scheduled_at,published_at FROM linkedin_posts WHERE workspace_id=? AND id=?'
      )
      .get<Record<string, unknown>>(WORKSPACE, prepared.post.id);
    expect(unchanged).toMatchObject({ status: 'draft', scheduled_at: null, published_at: null });
  });

  it('is workspace-scoped and refuses ordinary non-provenance posts', async () => {
    const prepared = await preparedStory();
    await expect(
      contentChannelVariants(db, { workspaceId: OTHER, postId: prepared.post.id })
    ).rejects.toMatchObject({ status: 404 });

    const ordinary = await createPost(
      db,
      {
        id: 'lipost_no_content_asset',
        workspaceId: WORKSPACE,
        seatKey: 'owner',
        blocks: [{ runs: [{ type: 'text', text: 'Ordinary post.' }] }],
        status: 'draft'
      },
      NOW
    );
    await expect(
      contentChannelVariants(db, { workspaceId: WORKSPACE, postId: ordinary.id })
    ).rejects.toMatchObject({ status: 409 });
  });
});
