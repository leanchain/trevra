import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPostBody } from '../../shared/linkedin-post-format.js';
import { openDatabase, type Db } from '../db.js';
import { getPost } from '../linkedin/posts.js';
import { upsertContentOpportunity } from './opportunities.js';
import { prepareStoryLinkedInDraft } from './story-draft.js';

let db: Db;
const WORKSPACE = 'ws_story_draft';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Story draft', NOW.toISOString());
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
      thesis: 'Acme shows two independent changes worth explaining together.',
      freshnessAt: NOW.toISOString(),
      score: 92,
      rationale: ['two kinds'],
      fingerprint: 'story-draft-acme',
      evidence: [
        {
          sourceType: 'account_signal',
          sourceId: 'sig_hiring',
          label: 'hiring up',
          detail: 'Acme added five platform roles.',
          sourceUrl: 'https://acme.example/careers',
          observedAt: '2026-09-12T10:00:00.000Z'
        },
        {
          sourceType: 'account_signal',
          sourceId: 'sig_pricing',
          label: 'pricing changed',
          detail: 'Acme changed enterprise pricing.',
          sourceUrl: 'https://acme.example/pricing',
          observedAt: '2026-09-12T11:00:00.000Z'
        }
      ]
    },
    NOW
  );
}

describe('prepareStoryLinkedInDraft', () => {
  it('creates an editable unscheduled draft with ContentAsset provenance and exact claim evidence', async () => {
    const opportunity = await story();
    const result = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, actorUserId: 'usr_test' },
      NOW
    );
    expect(result.reused).toBe(false);
    expect(result.asset).toMatchObject({
      opportunityId: opportunity.id,
      status: 'draft',
      format: 'text_post',
      angle: 'observation'
    });
    expect(result.asset.claimMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: 'Acme added five platform roles.',
          evidence: [expect.objectContaining({ sourceId: 'sig_hiring' })]
        }),
        expect.objectContaining({
          claim: 'Acme changed enterprise pricing.',
          evidence: [expect.objectContaining({ sourceId: 'sig_pricing' })]
        })
      ])
    );
    expect(result.post).toMatchObject({
      status: 'draft',
      scheduledAt: null,
      publishedAt: null,
      postedUrl: null,
      contentAssetId: result.asset.id
    });
    expect(result.post.publicationMeta).toMatchObject({
      contentOpportunityId: opportunity.id,
      renderer: 'linkedin-evidence-v2',
      contentAngle: 'observation',
      strategySource: 'heuristic'
    });
    expect(result.asset.generation).toMatchObject({
      features: {
        opportunityKind: 'company_change',
        angle: 'observation',
        hookFamily: 'change-led',
        evidenceCount: 2,
        entityCount: 1
      },
      learning: {
        source: 'heuristic',
        minimumSample: 3
      }
    });
    expect(renderPostBody(result.post.blocks)).toContain('Acme added five platform roles.');
  });

  it('uses a teardown framing for a source-rich company change before enough personal history exists', async () => {
    const opportunity = await upsertContentOpportunity(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'company_change',
        title: 'Acme: three changes',
        thesis: 'Three independent changes line up.',
        freshnessAt: NOW.toISOString(),
        score: 94,
        rationale: ['three kinds'],
        fingerprint: 'story-draft-three',
        evidence: [0, 1, 2].map((index) => ({
          sourceType: 'account_signal' as const,
          sourceId: `sig_three_${index}`,
          label: `signal ${index}`,
          detail: `Acme observed fact ${index + 1}.`,
          sourceUrl: `https://acme.example/fact-${index + 1}`,
          observedAt: NOW.toISOString()
        }))
      },
      NOW
    );
    const result = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      NOW
    );
    expect(result.asset.angle).toBe('teardown');
    expect(result.asset.generation).toMatchObject({
      features: { angle: 'teardown', hookFamily: 'teardown', evidenceCount: 3 },
      learning: { source: 'heuristic' }
    });
    expect(renderPostBody(result.post.blocks)).toContain('A quick teardown of what changed:');
  });

  it('reuses one draft for repeated preparation of the same story and seat', async () => {
    const opportunity = await story();
    const first = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      NOW
    );
    const second = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id },
      new Date('2026-09-12T12:05:00.000Z')
    );
    expect(second.reused).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.post.id).toBe(first.post.id);
    const counts = await db
      .prepare(
        `SELECT
      (SELECT COUNT(*)::int FROM content_assets WHERE workspace_id=?) AS assets,
      (SELECT COUNT(*)::int FROM linkedin_posts WHERE workspace_id=?) AS posts`
      )
      .get<{ assets: number; posts: number }>(WORKSPACE, WORKSPACE);
    expect(counts).toEqual({ assets: 1, posts: 1 });
  });

  it('creates a distinct draft for a distinct LinkedIn seat without mixing provenance', async () => {
    const opportunity = await story();
    const owner = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, seatKey: 'owner' },
      NOW
    );
    const secondary = await prepareStoryLinkedInDraft(
      db,
      { workspaceId: WORKSPACE, opportunityId: opportunity.id, seatKey: 'secondary' },
      NOW
    );
    expect(secondary.post.id).not.toBe(owner.post.id);
    expect((await getPost(db, WORKSPACE, secondary.post.id))?.seatKey).toBe('secondary');
  });
});
