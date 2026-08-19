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
  sweepStalePublishing,
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

  it("skips excluded seats, so a different seat's due post is still claimable in the same pass", async () => {
    await createPost(
      db,
      {
        id: 'lipost_seat_a',
        workspaceId: WORKSPACE_ID,
        seatKey: 'seat-a',
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z', // earlier -- would normally claim first
        createdBy: 'usr_1'
      },
      NOW
    );
    await createPost(
      db,
      {
        id: 'lipost_seat_b',
        workspaceId: WORKSPACE_ID,
        seatKey: 'seat-b',
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T09:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW, ['seat-a']);
    expect(claimed?.id).toBe('lipost_seat_b');
    // seat-a's post is untouched -- still scheduled, ready for a future tick.
    expect(await getPost(db, WORKSPACE_ID, 'lipost_seat_a')).toMatchObject({
      status: 'scheduled'
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

  it('never lets two racing callers both claim the same due post', async () => {
    await createPost(
      db,
      {
        id: 'lipost_race',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    // Two callers racing on the ONE due post -- FOR UPDATE SKIP LOCKED must let
    // exactly one of them claim it, never both (a worker tick double-posting)
    // and never neither (a post silently never claimed).
    const [first, second] = await Promise.all([
      claimNextDuePost(db, WORKSPACE_ID, NOW),
      claimNextDuePost(db, WORKSPACE_ID, NOW)
    ]);
    const winners = [first, second].filter((result) => result !== undefined);
    const losers = [first, second].filter((result) => result === undefined);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.id).toBe('lipost_race');
    expect(winners[0]?.status).toBe('publishing');
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

/**
 * The crash window. `claimNextDuePost` moves a row to 'publishing' BEFORE the
 * driver runs; if the worker dies in between (deploy, OOM, restart) nothing
 * else in this module will ever look at that row again -- `claimNextDuePost`
 * only selects 'scheduled' and `assertEditable` refuses 'publishing'.
 */
describe('sweepStalePublishing', () => {
  async function claimAndBackdate(postId: string, updatedAt: string): Promise<void> {
    await createPost(
      db,
      {
        id: postId,
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'scheduled',
        scheduledAt: '2026-08-19T08:00:00.000Z',
        createdBy: 'usr_1'
      },
      NOW
    );
    const claimed = await claimNextDuePost(db, WORKSPACE_ID, NOW);
    expect(claimed?.id).toBe(postId);
    await db
      .prepare('UPDATE linkedin_posts SET updated_at = ? WHERE id = ?')
      .run(updatedAt, postId);
  }

  it('fails a post left publishing past the stale threshold, with a reason the queue can show', async () => {
    await claimAndBackdate('lipost_stuck', '2026-08-19T08:30:00.000Z'); // 30 min before NOW
    expect(await sweepStalePublishing(db, WORKSPACE_ID, NOW)).toBe(1);
    expect(await getPost(db, WORKSPACE_ID, 'lipost_stuck')).toMatchObject({
      status: 'failed',
      error: {
        kind: 'unknown',
        detail: 'worker restarted mid-publish -- check LinkedIn before rescheduling'
      }
    });
  });

  it('leaves a post that is publishing RIGHT NOW alone -- it is mid-type, not stuck', async () => {
    await claimAndBackdate('lipost_inflight', '2026-08-19T08:58:00.000Z'); // 2 min before NOW
    expect(await sweepStalePublishing(db, WORKSPACE_ID, NOW)).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, 'lipost_inflight')).toMatchObject({
      status: 'publishing',
      error: null
    });
  });

  it('never reaches another workspace', async () => {
    await claimAndBackdate('lipost_ws_scoped', '2026-08-19T07:00:00.000Z');
    expect(await sweepStalePublishing(db, 'ws_someone_else', NOW)).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, 'lipost_ws_scoped')).toMatchObject({
      status: 'publishing'
    });
  });

  it('leaves the swept post recoverable -- edit it back to scheduled and it claims again', async () => {
    await claimAndBackdate('lipost_recover', '2026-08-19T08:00:00.000Z');
    await sweepStalePublishing(db, WORKSPACE_ID, NOW);
    const rescheduled = await updatePost(
      db,
      WORKSPACE_ID,
      'lipost_recover',
      { status: 'scheduled', scheduledAt: '2026-08-19T08:45:00.000Z' },
      NOW
    );
    expect(rescheduled).toMatchObject({ status: 'scheduled', error: null });
    expect((await claimNextDuePost(db, WORKSPACE_ID, NOW))?.id).toBe('lipost_recover');
  });
});

/**
 * A post that failed or was missed is NOT a dead end. The spec's words for a
 * missed post are "the user reschedules or discards from the UI", and the
 * driver's post selectors are explicitly unverified against a live LinkedIn --
 * first-rollout failures are expected, and every one of them has to be
 * reachable again.
 */
describe('recovering failed and missed posts', () => {
  async function failedPost(postId: string): Promise<void> {
    await createPost(
      db,
      {
        id: postId,
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
  }

  it('edits a failed post back to a draft, clearing the stale failure reason', async () => {
    await failedPost('lipost_failed_edit');
    const edited = await updatePost(
      db,
      WORKSPACE_ID,
      'lipost_failed_edit',
      { status: 'draft', blocks: [{ runs: [{ type: 'text', text: 'Rewritten' }] }] },
      NOW
    );
    expect(edited).toMatchObject({ status: 'draft', error: null });
    expect(edited.blocks).toEqual([{ runs: [{ type: 'text', text: 'Rewritten' }] }]);
  });

  it('cancels a failed post', async () => {
    await failedPost('lipost_failed_cancel');
    expect(await cancelPost(db, WORKSPACE_ID, 'lipost_failed_cancel', NOW)).toMatchObject({
      status: 'canceled'
    });
  });

  it('reschedules a missed post to a new time', async () => {
    await createPost(
      db,
      {
        id: 'lipost_missed_reschedule',
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
    const rescheduled = await updatePost(
      db,
      WORKSPACE_ID,
      'lipost_missed_reschedule',
      { status: 'scheduled', scheduledAt: '2026-08-20T09:00:00.000Z' },
      NOW
    );
    expect(rescheduled).toMatchObject({
      status: 'scheduled',
      scheduledAt: '2026-08-20T09:00:00.000Z'
    });
  });

  it('still refuses a posted or canceled post -- widening editability is not removing the guard', async () => {
    const post = await createPost(
      db,
      {
        id: 'lipost_terminal',
        workspaceId: WORKSPACE_ID,
        blocks: BLOCKS,
        status: 'draft',
        createdBy: 'usr_1'
      },
      NOW
    );
    await markPostPublished(db, post.id, { postedUrl: null }, NOW);
    await expect(
      updatePost(db, WORKSPACE_ID, post.id, { status: 'draft' }, NOW)
    ).rejects.toBeInstanceOf(LinkedInPostsApiError);
    await expect(cancelPost(db, WORKSPACE_ID, post.id, NOW)).rejects.toBeInstanceOf(
      LinkedInPostsApiError
    );
  });
});
