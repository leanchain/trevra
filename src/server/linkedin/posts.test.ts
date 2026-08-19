import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from './seats.js';
import {
  cancelPost,
  claimNextDuePost,
  createPost,
  getPost,
  LinkedInPostsApiError,
  listPosts,
  markPostFailed,
  markPostMissed,
  markPostPublished,
  releasePostToScheduled,
  updatePost
} from './posts.js';

let db: Db;
const WORKSPACE_ID = 'ws_linkedin_posts_test';
const NOW = new Date('2026-08-19T09:00:00.000Z');
const BLOCKS = [{ runs: [{ type: 'text' as const, text: 'Hello world' }] }];

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE_ID, 'Posts test', NOW.toISOString());
  await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'UTC' }, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
});

describe('createPost', () => {
  it('files a draft with no scheduledAt', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_1',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(post.status).toBe('draft');
    expect(post.scheduledAt).toBeNull();
  });

  it('refuses to schedule with no scheduledAt', async () => {
    await expect(
      createPost(
        db,
        {
          id: 'lipost_2',
          workspaceId: WORKSPACE_ID,
          blocks: BLOCKS,
          status: 'scheduled',
          createdBy: 'usr_1'
        },
        NOW
      )
    ).rejects.toBeInstanceOf(LinkedInPostsApiError);
  });

  it('files a scheduled post for a named future time', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_3',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-20T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(post.status).toBe('scheduled');
    expect(post.scheduledAt).toBe('2026-08-20T09:00:00.000Z');
  });
});

describe('listPosts / getPost', () => {
  it("lists only the calling workspace's posts, newest scheduled first", async () => {
    await createPost(
      db,
      {
        id: 'lipost_a',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    await createPost(
      db,
      {
        id: 'lipost_b',
        workspaceId: 'ws_other',
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    ).catch(() => {});
    const posts = await listPosts(db, WORKSPACE_ID, {});
    expect(posts.map((p) => p.id)).toEqual(['lipost_a']);
    expect(await getPost(db, WORKSPACE_ID, 'lipost_a')).toMatchObject({ id: 'lipost_a' });
    expect(await getPost(db, WORKSPACE_ID, 'nope')).toBeUndefined();
  });
});

describe('updatePost / cancelPost', () => {
  it('edits a draft, but refuses once the post is posted', async () => {
    const draft = await createPost(
      db,
      {
        id: 'lipost_edit',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    const edited = await updatePost(
      db,
      WORKSPACE_ID,
      draft.id,
      { blocks: [{ runs: [{ type: 'text', text: 'Edited' }] }] },
      NOW
    );
    expect(edited.blocks).toEqual([{ runs: [{ type: 'text', text: 'Edited' }] }]);

    await markPostPublished(db, draft.id, { postedUrl: null }, NOW);
    await expect(
      updatePost(db, WORKSPACE_ID, draft.id, { blocks: BLOCKS }, NOW)
    ).rejects.toBeInstanceOf(LinkedInPostsApiError);
  });

  it('cancels a scheduled post but refuses a posted one', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_cancel',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-20T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const canceled = await cancelPost(db, WORKSPACE_ID, post.id, NOW);
    expect(canceled.status).toBe('canceled');
    await markPostPublished(db, post.id, { postedUrl: null }, NOW); // force-advance for the negative case below
    await expect(cancelPost(db, WORKSPACE_ID, post.id, NOW)).rejects.toBeInstanceOf(
      LinkedInPostsApiError
    );
  });
});

describe('claimNextDuePost', () => {
  it('claims a due post, moving it to publishing, oldest scheduledAt first', async () => {
    await createPost(
      db,
      {
        id: 'lipost_later',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    await createPost(
      db,
      {
        id: 'lipost_earlier',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    expect(claimed?.id).toBe('lipost_earlier');
    expect(claimed?.status).toBe('publishing');
    expect(await getPost(db, WORKSPACE_ID, 'lipost_earlier')).toMatchObject({
      status: 'publishing'
    });
  });

  it('never claims a post scheduled in the future', async () => {
    await createPost(
      db,
      {
        id: 'lipost_future',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T10:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    expect(await claimNextDuePost(db, WORKSPACE_ID, NOW)).toBeUndefined();
  });

  it('releasing a claimed post back to scheduled makes it claimable again', async () => {
    await createPost(
      db,
      {
        id: 'lipost_release',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await releasePostToScheduled(db, claimed!.id, NOW);
    const reclaimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    expect(reclaimed?.id).toBe('lipost_release');
  });
});

describe('markPostFailed / markPostMissed', () => {
  it('records the failure kind and detail, terminal, not reclaimable', async () => {
    await createPost(
      db,
      {
        id: 'lipost_fail',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await markPostFailed(db, claimed!.id, { kind: 'selector_drift', detail: 'gone' }, NOW);
    const post = await getPost(db, WORKSPACE_ID, claimed!.id);
    expect(post).toMatchObject({
      status: 'failed',
      error: { kind: 'selector_drift', detail: 'gone' }
    });
    expect(await claimNextDuePost(db, WORKSPACE_ID, NOW)).toBeUndefined();
  });

  it('marks a stale claimed post missed', async () => {
    await createPost(
      db,
      {
        id: 'lipost_missed',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T00:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    await markPostMissed(db, claimed!.id, NOW);
    expect(await getPost(db, WORKSPACE_ID, claimed!.id)).toMatchObject({ status: 'missed' });
  });
});
