import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { loadPostImages } from '../linkedin/posts.js';
import { listContentAssets } from './assets.js';
import { prepareStoryCarousel, renderStoryCarouselSlides } from './carousel.js';
import { upsertContentOpportunity } from './opportunities.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';

let db: Db;
const WORKSPACE = 'ws_content_carousel';
const OTHER = 'ws_content_carousel_other';
const NOW = new Date('2026-09-13T06:30:00.000Z');

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

async function story(workspaceId = WORKSPACE, count = 3) {
  return upsertContentOpportunity(
    db,
    {
      workspaceId,
      kind: 'company_change',
      title: 'Acme: hiring, pricing and product movement',
      thesis: 'Several independent changes line up into one current market story.',
      freshnessAt: NOW.toISOString(),
      score: 94,
      rationale: ['multiple independent facts'],
      fingerprint: `carousel-${workspaceId}-${count}`,
      evidence: Array.from({ length: count }, (_, index) => ({
        sourceType: 'account_signal' as const,
        sourceId: `carousel-signal-${index}`,
        label: `Acme · signal ${index + 1}`,
        detail: `Acme source-backed observation number ${index + 1}.`,
        sourceUrl: `https://acme.example/source-${index + 1}`,
        observedAt: new Date(NOW.getTime() - index * 3_600_000).toISOString()
      }))
    },
    NOW
  );
}

describe('story carousel', () => {
  it('renders cover + one slide per fact + sources as portrait PNGs', async () => {
    const opportunity = await story(WORKSPACE, 3);
    const slides = await renderStoryCarouselSlides(opportunity);
    expect(slides).toHaveLength(5);
    for (const slide of slides) {
      expect(slide.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(await sharp(slide.bytes).metadata()).toMatchObject({
        format: 'png',
        width: 1080,
        height: 1350
      });
    }
  });

  it('caps evidence at five fact slides so the draft stays below LinkedIn image limits', async () => {
    const opportunity = await story(WORKSPACE, 8);
    const slides = await renderStoryCarouselSlides(opportunity);
    expect(slides).toHaveLength(7);
  });

  it('creates a distinct editable carousel draft and reuses it idempotently', async () => {
    const opportunity = await story();
    const plain = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      NOW
    );
    const first = await prepareStoryCarousel(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      NOW
    );
    const replay = await prepareStoryCarousel(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      new Date(NOW.getTime() + 60_000)
    );

    expect(first.reused).toBe(false);
    expect(first.post.id).not.toBe(plain.post.id);
    expect(first.asset.format).toBe('carousel');
    expect(first.asset.generation).toMatchObject({
      renderer: 'source-carousel-v1',
      slideCount: 5,
      dimensions: { width: 1080, height: 1350 }
    });
    expect(first.post.publicationMeta).toMatchObject({
      carouselAssetId: first.asset.id,
      contentVariant: 'carousel'
    });
    expect(first.post.media).toHaveLength(5);
    expect(replay.reused).toBe(true);
    expect(replay.post.id).toBe(first.post.id);
    expect(replay.asset.id).toBe(first.asset.id);
    expect(await loadPostImages(db, WORKSPACE, first.post.id)).toHaveLength(5);

    const assets = await listContentAssets(db, WORKSPACE, opportunity.id, 20);
    expect(assets.filter((asset) => asset.format === 'carousel')).toHaveLength(1);
    expect(assets.filter((asset) => asset.format === 'text_post')).toHaveLength(2);
  });

  it('keeps workspace boundaries hard', async () => {
    const foreign = await story(OTHER);
    await expect(
      prepareStoryCarousel(db, { workspaceId: WORKSPACE, opportunityId: foreign.id }, NOW)
    ).rejects.toMatchObject({ status: 404 });
  });
});
