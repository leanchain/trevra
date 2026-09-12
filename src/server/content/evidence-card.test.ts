import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { loadPostImages } from '../linkedin/posts.js';
import { listContentAssets } from './assets.js';
import { prepareStoryEvidenceCard, renderEvidenceCardPng } from './evidence-card.js';
import { upsertContentOpportunity } from './opportunities.js';

let db: Db;
const WORKSPACE = 'ws_evidence_card';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Evidence card', NOW.toISOString());
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db.close();
});

async function story() {
  return upsertContentOpportunity(
    db,
    {
      workspaceId: WORKSPACE,
      kind: 'company_change',
      title: 'Acme: hiring + pricing',
      thesis: 'Two independent changes line up.',
      freshnessAt: NOW.toISOString(),
      score: 91,
      rationale: ['two kinds'],
      fingerprint: 'evidence-card-story',
      evidence: [
        {
          sourceType: 'account_signal',
          sourceId: 'card_hiring',
          label: 'Acme · hiring up',
          detail: 'Acme added five platform engineering roles.',
          sourceUrl: 'https://acme.example/careers',
          observedAt: '2026-09-12T10:00:00.000Z'
        },
        {
          sourceType: 'account_signal',
          sourceId: 'card_pricing',
          label: 'Acme · pricing changed',
          detail: 'Acme changed enterprise pricing.',
          sourceUrl: 'https://acme.example/pricing',
          observedAt: '2026-09-12T11:00:00.000Z'
        },
        {
          sourceType: 'account_signal',
          sourceId: 'card_tech',
          label: 'Acme · tech added',
          detail: 'Acme added a new data platform technology.',
          sourceUrl: 'https://acme.example/',
          observedAt: '2026-09-11T11:00:00.000Z'
        }
      ]
    },
    NOW
  );
}

describe('evidence cards', () => {
  it('renders a real portrait PNG at the deterministic card dimensions', async () => {
    const opportunity = await story();
    const bytes = await renderEvidenceCardPng(opportunity, 'portrait');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 1080, height: 1350 });
  });

  it('creates one evidence-card asset and idempotently attaches one PNG to the editable story draft', async () => {
    const opportunity = await story();
    const first = await prepareStoryEvidenceCard(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, aspect: 'portrait' },
      NOW
    );
    const second = await prepareStoryEvidenceCard(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, aspect: 'portrait' },
      new Date('2026-09-12T12:01:00.000Z')
    );
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.post.id).toBe(first.post.id);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.post).toMatchObject({ status: 'draft' });
    expect(second.post.media).toHaveLength(1);
    expect(second.post.media[0]).toMatchObject({ mimeType: 'image/png' });

    const assets = await listContentAssets(db, WORKSPACE, opportunity.id, 10);
    expect(assets.filter((asset) => asset.format === 'evidence_card')).toHaveLength(1);
    expect(first.asset.claimMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: 'Acme changed enterprise pricing.',
          evidence: [expect.objectContaining({ sourceId: 'card_pricing' })]
        })
      ])
    );
    const images = await loadPostImages(db, WORKSPACE, first.post.id);
    expect(images).toHaveLength(1);
    expect(images[0]?.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('uses a distinct card asset for a distinct aspect while keeping both attached to the same draft', async () => {
    const opportunity = await story();
    const portrait = await prepareStoryEvidenceCard(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, aspect: 'portrait' },
      NOW
    );
    const square = await prepareStoryEvidenceCard(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, aspect: 'square' },
      NOW
    );
    expect(square.asset.id).not.toBe(portrait.asset.id);
    expect(square.post.id).toBe(portrait.post.id);
    expect(square.post.media).toHaveLength(2);
  });
});
