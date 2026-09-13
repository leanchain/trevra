import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createBufferDraft, listBufferChannels } from './buffer.js';

let db: Db;
const WORKSPACE = 'ws_buffer_content';
const OTHER = 'ws_buffer_content_other';
const NOW = '2026-09-13T09:00:00.000Z';
const POST_ID = 'lipost_buffer_content';

async function seedWorkspace(id: string): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(id, id, NOW);
}

async function seedConnection(workspaceId: string, suffix: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'connected',0,?,?)`
    )
    .run(
      `con_buffer_${suffix}`,
      workspaceId,
      'buffer',
      'trevra-buffer',
      `buffer-external-${suffix}`,
      `Buffer ${suffix}`,
      NOW,
      NOW
    );
}

async function seedPost(workspaceId = WORKSPACE, postId = POST_ID): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_posts
       (id,workspace_id,seat_key,status,blocks_json,media_json,link_in_comment,created_at,updated_at)
       VALUES (?,?,'owner','draft',?::jsonb,'[]'::jsonb,FALSE,?,?)`
    )
    .run(
      postId,
      workspaceId,
      JSON.stringify([{ runs: [{ type: 'text', text: 'Proof-backed story' }] }]),
      NOW,
      NOW
    );
}

function proxySequence(...responses: Array<unknown | Error>) {
  const post = vi.fn(async (_endpoint: string, _data: unknown) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { post };
}

const organizations = {
  data: { account: { organizations: [{ id: 'org_1', name: 'Founder Org' }] } }
};
const channels = {
  data: {
    channels: [
      {
        id: 'channel_linkedin',
        name: 'Founder LinkedIn',
        displayName: 'Pankaj',
        service: 'linkedin',
        isQueuePaused: false
      }
    ]
  }
};

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await seedWorkspace(WORKSPACE);
  await seedWorkspace(OTHER);
  await seedConnection(WORKSPACE, 'own');
  await seedConnection(OTHER, 'foreign');
  await seedPost();
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
});

describe('Buffer content handoff', () => {
  it('lists only channels from the authenticated workspace connection', async () => {
    const proxy = proxySequence(organizations, channels);
    const state = await listBufferChannels(db, WORKSPACE, { proxyFor: () => proxy });
    expect(state).toEqual({
      connected: true,
      channels: [
        {
          id: 'channel_linkedin',
          name: 'Founder LinkedIn',
          displayName: 'Pankaj',
          service: 'linkedin',
          organizationId: 'org_1',
          organizationName: 'Founder Org',
          isQueuePaused: false
        }
      ]
    });
    expect(proxy.post).toHaveBeenCalledTimes(2);
    const variables = (proxy.post.mock.calls[1]?.[1] as { variables?: Record<string, unknown> })
      .variables;
    expect(variables).toEqual({ organizationId: 'org_1' });
  });

  it('creates a Buffer draft only, then replays the exact approved payload without another mutation', async () => {
    const proxy = proxySequence(organizations, channels, {
      data: {
        createPost: {
          __typename: 'PostActionSuccess',
          post: { id: 'buffer_post_123', text: 'Evidence-backed text' }
        }
      }
    });
    const payload = {
      channelId: 'channel_linkedin',
      text: 'Evidence-backed text',
      metadata: {
        sourcePostId: POST_ID,
        contentAssetId: null,
        channelName: 'Pankaj · LinkedIn',
        mode: 'draft_only' as const
      }
    };
    const first = await createBufferDraft(db, WORKSPACE, payload, 'payload-hash-123', {
      proxyFor: () => proxy
    });
    expect(first).toEqual({ provider: 'buffer', externalRef: 'buffer_post_123', reused: false });
    const mutation = proxy.post.mock.calls[2]?.[1] as {
      variables?: { input?: Record<string, unknown> };
    };
    expect(mutation.variables?.input).toEqual({
      text: 'Evidence-backed text',
      channelId: 'channel_linkedin',
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true
    });
    expect(mutation.variables?.input).not.toHaveProperty('dueAt');
    expect(mutation.variables?.input).not.toHaveProperty('shareNow');

    const replayProxy = proxySequence(organizations, channels);
    const replay = await createBufferDraft(db, WORKSPACE, payload, 'payload-hash-123', {
      proxyFor: () => replayProxy
    });
    expect(replay).toEqual({ provider: 'buffer', externalRef: 'buffer_post_123', reused: true });
    expect(replayProxy.post).toHaveBeenCalledTimes(2);
  });

  it('records an ambiguous transport outcome and refuses a blind retry', async () => {
    const proxy = proxySequence(organizations, channels, new Error('socket closed after write'));
    const payload = {
      channelId: 'channel_linkedin',
      text: 'Ambiguous draft',
      metadata: { sourcePostId: POST_ID, mode: 'draft_only' as const }
    };
    await expect(
      createBufferDraft(db, WORKSPACE, payload, 'payload-hash-unknown', { proxyFor: () => proxy })
    ).rejects.toThrow(/outcome is unknown/i);
    const ledger = await db
      .prepare(
        `SELECT status,last_error FROM content_buffer_drafts
         WHERE workspace_id=? AND payload_hash=?`
      )
      .get<{ status: string; last_error: string }>(WORKSPACE, 'payload-hash-unknown');
    expect(ledger).toMatchObject({ status: 'unknown', last_error: 'socket closed after write' });

    const replayProxy = proxySequence(organizations, channels);
    await expect(
      createBufferDraft(db, WORKSPACE, payload, 'payload-hash-unknown', {
        proxyFor: () => replayProxy
      })
    ).rejects.toThrow(/check Buffer before trying again/i);
    expect(replayProxy.post).toHaveBeenCalledTimes(2);
  });

  it('marks a typed Buffer mutation rejection as failed and never accepts a foreign source post', async () => {
    const rejectedProxy = proxySequence(organizations, channels, {
      data: {
        createPost: { __typename: 'MutationError', message: 'Channel does not accept this post' }
      }
    });
    await expect(
      createBufferDraft(
        db,
        WORKSPACE,
        {
          channelId: 'channel_linkedin',
          text: 'Rejected draft',
          metadata: { sourcePostId: POST_ID, mode: 'draft_only' }
        },
        'payload-hash-rejected',
        { proxyFor: () => rejectedProxy }
      )
    ).rejects.toThrow('Channel does not accept this post');
    expect(
      await db
        .prepare('SELECT status FROM content_buffer_drafts WHERE workspace_id=? AND payload_hash=?')
        .get<{ status: string }>(WORKSPACE, 'payload-hash-rejected')
    ).toEqual({ status: 'failed' });

    await seedPost(OTHER, 'lipost_buffer_foreign');
    const unusedProxy = proxySequence(organizations, channels);
    await expect(
      createBufferDraft(
        db,
        WORKSPACE,
        {
          channelId: 'channel_linkedin',
          text: 'No cross tenant post',
          metadata: { sourcePostId: 'lipost_buffer_foreign', mode: 'draft_only' }
        },
        'payload-hash-foreign',
        { proxyFor: () => unusedProxy }
      )
    ).rejects.toThrow(/Source post not found/i);
    expect(unusedProxy.post).not.toHaveBeenCalled();
  });
});
