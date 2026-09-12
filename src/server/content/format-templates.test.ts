import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPostBody } from '../../shared/linkedin-post-format.js';
import { openDatabase, type Db } from '../db.js';
import { createPost, markPostPublished } from '../linkedin/posts.js';
import { createContentAsset } from './assets.js';
import { upsertContentOpportunity } from './opportunities.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';
import { appendLinkedInContentMetric } from './performance.js';
import {
  extractContentFormatStructure,
  listContentFormatTemplates,
  syncOwnPublishedFormatTemplates
} from './format-templates.js';

let db: Db;
const WORKSPACE = 'ws_format_templates';
const OTHER = 'ws_format_templates_other';
const NOW = new Date('2026-09-12T12:00:00.000Z');

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
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db.close();
});

async function published(
  workspaceId: string,
  postId: string,
  paragraphs: string[],
  impressions: number,
  evidenceCount = 2
): Promise<void> {
  const claimMap = Array.from({ length: evidenceCount }, (_, index) => ({
    claim: `claim-${postId}-${index}`,
    evidence: [
      {
        sourceType: 'external_observation' as const,
        sourceId: `src-${postId}-${index}`,
        label: 'source',
        detail: `fact-${postId}-${index}`,
        sourceUrl: `https://${postId}.example/${index}`,
        observedAt: NOW.toISOString()
      }
    ]
  }));
  const asset = await createContentAsset(
    db,
    {
      workspaceId,
      format: 'text_post',
      angle: 'observation',
      body: paragraphs.join('\n\n'),
      claimMap,
      generation: { source: 'test' }
    },
    NOW
  );
  await createPost(
    db,
    {
      id: postId,
      workspaceId,
      blocks: paragraphs.map((text) => ({ runs: [{ type: 'text' as const, text }] })),
      contentAssetId: asset.id
    },
    NOW
  );
  await markPostPublished(
    db,
    postId,
    { postedUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/` },
    NOW
  );
  await appendLinkedInContentMetric(
    db,
    { workspaceId, postId, observedAt: NOW.toISOString(), impressions },
    NOW
  );
}

describe('content format templates', () => {
  it('extracts structure without retaining reference wording', () => {
    const structure = extractContentFormatStructure({
      body: [
        'What changed this week?',
        '• Acme expanded hiring.',
        '• Beta changed pricing.',
        'What are you seeing?'
      ].join('\n\n'),
      evidenceCount: 2,
      visualLayout: 'portrait_card'
    });
    expect(structure).toEqual({
      version: 1,
      hookType: 'question',
      listStyle: 'bullet',
      rhythm: 'short',
      ctaType: 'question',
      paragraphCountBand: 'compact',
      evidenceSlots: 2,
      visualLayout: 'portrait_card'
    });
    const serialized = JSON.stringify(structure);
    expect(serialized).not.toContain('Acme');
    expect(serialized).not.toContain('pricing');
  });

  it('groups differently worded own posts by shape and recommends only after three samples', async () => {
    await published(
      WORKSPACE,
      'post_shape_a',
      [
        'Market changed.',
        '• Alpha hired engineers.',
        '• Alpha changed pricing.',
        'Worth watching.'
      ],
      100
    );
    await published(
      WORKSPACE,
      'post_shape_b',
      [
        'Another market move.',
        '• Bravo expanded sales.',
        '• Bravo launched pricing.',
        'Keep watching.'
      ],
      300
    );
    await published(
      WORKSPACE,
      'post_shape_c',
      ['A third shift.', '• Charlie added roles.', '• Charlie changed plans.', 'More soon.'],
      200
    );
    await published(
      WORKSPACE,
      'post_numbered_once',
      ['3 moves to watch', '1. Delta hired.', '2. Delta repriced.', 'Read the sources.'],
      900
    );
    await published(
      OTHER,
      'post_foreign',
      ['Foreign market.', '• Secret fact one.', '• Secret fact two.', 'Keep watching.'],
      5000
    );

    const synced = await syncOwnPublishedFormatTemplates(db, WORKSPACE, NOW);
    expect(synced).toHaveLength(2);
    const recommended = synced.find((template) => template.recommended);
    expect(recommended).toBeTruthy();
    expect(recommended?.performance).toMatchObject({
      sampleSize: 3,
      metricSampleSize: 3,
      medianImpressions: 200
    });
    expect(recommended?.provenance.sourcePostIds.sort()).toEqual(
      ['post_shape_a', 'post_shape_b', 'post_shape_c'].sort()
    );
    expect(recommended?.structure).toMatchObject({ listStyle: 'bullet', evidenceSlots: 2 });
    expect(JSON.stringify(recommended?.structure)).not.toContain('Alpha');
    expect(JSON.stringify(recommended?.structure)).not.toContain('Bravo');
    expect(JSON.stringify(recommended?.structure)).not.toContain('Charlie');

    const oneOff = synced.find((template) => template.structure.listStyle === 'numbered');
    expect(oneOff?.recommended).toBe(false);
    expect(oneOff?.performance.sampleSize).toBe(1);
    expect(JSON.stringify(synced)).not.toContain('Secret fact');
    expect(await listContentFormatTemplates(db, OTHER)).toHaveLength(0);

    const story = await upsertContentOpportunity(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'company_change',
        title: 'Echo: hiring + pricing',
        thesis: 'Echo shows two current changes.',
        freshnessAt: NOW.toISOString(),
        score: 88,
        rationale: ['source-backed'],
        fingerprint: 'format-clone-echo',
        evidence: [
          {
            sourceType: 'external_observation',
            sourceId: 'echo-hiring',
            label: 'hiring',
            detail: 'Echo added six engineering roles.',
            sourceUrl: 'https://echo.example/careers',
            observedAt: NOW.toISOString()
          },
          {
            sourceType: 'external_observation',
            sourceId: 'echo-pricing',
            label: 'pricing',
            detail: 'Echo changed enterprise pricing.',
            sourceUrl: 'https://echo.example/pricing',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );
    const normal = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: story.id },
      NOW
    );
    const cloned = await prepareStoryLinkedInDraft(
      db,
      {
        workspaceId: WORKSPACE,
        opportunityId: story.id,
        formatTemplateId: recommended!.id
      },
      NOW
    );
    const clonedReplay = await prepareStoryLinkedInDraft(
      db,
      {
        workspaceId: WORKSPACE,
        opportunityId: story.id,
        formatTemplateId: recommended!.id
      },
      new Date(NOW.getTime() + 60_000)
    );
    expect(cloned.post.id).not.toBe(normal.post.id);
    expect(clonedReplay.post.id).toBe(cloned.post.id);
    expect(clonedReplay.reused).toBe(true);
    const body = renderPostBody(cloned.post.blocks);
    expect(body).toContain('Echo added six engineering roles.');
    expect(body).toContain('Echo changed enterprise pricing.');
    expect(body).not.toContain('Alpha hired engineers.');
    expect(body).not.toContain('Bravo expanded sales.');
    expect(body).not.toContain('Charlie added roles.');
    expect(cloned.asset.generation).toMatchObject({
      mode: 'deterministic-format-clone',
      formatTemplate: {
        id: recommended!.id,
        sampleSize: 3,
        structure: expect.objectContaining({ listStyle: 'bullet' })
      }
    });
  });
});
