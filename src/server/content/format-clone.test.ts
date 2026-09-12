import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPostBody } from '../../shared/linkedin-post-format.js';
import { openDatabase, type Db } from '../db.js';
import { loadPostImages } from '../linkedin/posts.js';
import { prepareStoryFormatClone } from './format-clone.js';
import { upsertContentOpportunity } from './opportunities.js';

let db: Db;
const WORKSPACE = 'ws_format_clone';
const OTHER = 'ws_format_clone_other';
const NOW = new Date('2026-09-13T00:00:00.000Z');

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

async function insertTemplate(workspaceId: string, id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO content_format_templates
       (id,workspace_id,status,name,source_kind,source_ref,structure_json,provenance_json,performance_json,fingerprint,created_at,updated_at)
       VALUES (?,?,'active',?,'own_published_post',?,?::jsonb,?::jsonb,?::jsonb,?,?,?)`
    )
    .run(
      id,
      workspaceId,
      'question · bullet list · short + portrait card',
      'historical_post_1',
      JSON.stringify({
        version: 1,
        hookType: 'question',
        listStyle: 'bullet',
        rhythm: 'short',
        ctaType: 'question',
        paragraphCountBand: 'compact',
        evidenceSlots: 2,
        visualLayout: 'portrait_card'
      }),
      JSON.stringify({
        sourcePostIds: ['historical_post_1', 'historical_post_2', 'historical_post_3'],
        extractedAt: NOW.toISOString()
      }),
      JSON.stringify({
        sampleSize: 3,
        metricSampleSize: 3,
        medianImpressions: 700,
        qualifiedDemand: 2,
        verifiedReplies: 1,
        opportunities: 1,
        won: 0
      }),
      `format:${workspaceId}:${id}`,
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function currentStory() {
  return upsertContentOpportunity(
    db,
    {
      workspaceId: WORKSPACE,
      kind: 'company_change',
      title: 'Nova: hiring + pricing',
      thesis: 'Nova shows two source-backed changes.',
      freshnessAt: NOW.toISOString(),
      score: 90,
      rationale: ['two independent changes'],
      fingerprint: 'format-clone-current-story',
      evidence: [
        {
          sourceType: 'external_observation',
          sourceId: 'nova-hiring',
          label: 'Nova · hiring',
          detail: 'Nova added seven platform roles.',
          sourceUrl: 'https://nova.example/careers',
          observedAt: NOW.toISOString()
        },
        {
          sourceType: 'external_observation',
          sourceId: 'nova-pricing',
          label: 'Nova · pricing',
          detail: 'Nova changed enterprise pricing.',
          sourceUrl: 'https://nova.example/pricing',
          observedAt: NOW.toISOString()
        }
      ]
    },
    NOW
  );
}

describe('format clone preparation', () => {
  it('applies only the historical structure and generates a fresh evidence card from current facts', async () => {
    await insertTemplate(WORKSPACE, 'fmt_clone_portrait');
    const story = await currentStory();

    const first = await prepareStoryFormatClone(
      db,
      {
        workspaceId: WORKSPACE,
        opportunityId: story.id,
        templateId: 'fmt_clone_portrait',
        seatKey: 'owner'
      },
      NOW
    );
    const replay = await prepareStoryFormatClone(
      db,
      {
        workspaceId: WORKSPACE,
        opportunityId: story.id,
        templateId: 'fmt_clone_portrait',
        seatKey: 'owner'
      },
      new Date(NOW.getTime() + 60_000)
    );

    expect(first.reused).toBe(false);
    expect(replay.reused).toBe(true);
    expect(replay.post.id).toBe(first.post.id);
    expect(first.template).toMatchObject({ recommended: true, performance: { sampleSize: 3 } });
    const body = renderPostBody(first.post.blocks);
    expect(body).toContain('What do these changes add up to?');
    expect(body).toContain('• Nova added seven platform roles.');
    expect(body).toContain('• Nova changed enterprise pricing.');
    expect(body).toContain('What are you seeing in this market?');
    expect(body).not.toContain('historical_post');

    const images = await loadPostImages(db, WORKSPACE, first.post.id);
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toMatch(/-portrait\.png$/);
    const metadata = await sharp(images[0]!.buffer).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 1080, height: 1350 });
    expect(first.asset.generation).toMatchObject({
      mode: 'deterministic-format-clone',
      formatTemplate: { id: 'fmt_clone_portrait', sampleSize: 3 }
    });
  });

  it('cannot use a format template from another workspace', async () => {
    await insertTemplate(OTHER, 'fmt_foreign');
    const story = await currentStory();
    await expect(
      prepareStoryFormatClone(
        db,
        {
          workspaceId: WORKSPACE,
          opportunityId: story.id,
          templateId: 'fmt_foreign'
        },
        NOW
      )
    ).rejects.toMatchObject({ status: 404 });
  });
});
