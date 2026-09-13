import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  post: vi.fn(async (config: Record<string, unknown>) => {
    const data = (config.data ?? {}) as Record<string, unknown>;
    const query = String(data.query ?? '');
    if (query.includes('TrevraBufferOrganizations')) {
      return {
        data: { data: { account: { organizations: [{ id: 'org_1', name: 'Founder Org' }] } } }
      };
    }
    if (query.includes('TrevraBufferChannels')) {
      return {
        data: {
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
        }
      };
    }
    if (query.includes('TrevraCreateBufferDraft')) {
      return {
        data: {
          data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: { id: 'buffer_draft_api_1', text: 'Evidence-backed Buffer draft' }
            }
          }
        }
      };
    }
    throw new Error(`Unexpected Buffer GraphQL query: ${query}`);
  })
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    post = nangoMock.post;
  }
}));

import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { createPost } from '../linkedin/posts.js';
import { seedPlaybooks } from '../playbooks/registry.js';
import { createContentAsset } from './assets.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE = 'ws_buffer_api';
const OTHER = 'ws_buffer_api_other';
const USER = 'usr_buffer_api';
const NOW = new Date('2026-09-13T09:15:00.000Z');

async function seedSession(): Promise<string> {
  for (const [workspaceId, name] of [
    [WORKSPACE, 'Buffer API'],
    [OTHER, 'Other Buffer API']
  ] as const) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, name, NOW.toISOString());
  }
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER, WORKSPACE, 'buffer-api@trevra.test', 'Buffer API', NOW.toISOString());
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
  return token;
}

function authed(method: 'get' | 'post', path: string) {
  return request(app)[method](path).set('Cookie', `trevra_session=${session}`);
}

async function seedBufferConnection(workspaceId = WORKSPACE): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'connected',0,?,?)`
    )
    .run(
      `con_buffer_api_${workspaceId}`,
      workspaceId,
      'buffer',
      'trevra-buffer',
      `buffer-external-${workspaceId}`,
      'Buffer',
      NOW.toISOString(),
      NOW.toISOString()
    );
}

async function seedProvenancePost(
  workspaceId: string,
  postId: string,
  withProvenance = true
): Promise<void> {
  const asset = withProvenance
    ? await createContentAsset(
        db,
        {
          workspaceId,
          format: 'text_post',
          angle: 'observation',
          hook: 'Evidence-backed Buffer draft',
          body: 'Evidence-backed Buffer draft',
          claimMap: []
        },
        NOW
      )
    : null;
  await createPost(
    db,
    {
      id: postId,
      workspaceId,
      blocks: [{ runs: [{ type: 'text', text: 'Evidence-backed Buffer draft' }] }],
      status: 'draft',
      contentAssetId: asset?.id ?? null,
      createdBy: workspaceId === WORKSPACE ? USER : null
    },
    NOW
  );
}

function bufferMutationCalls() {
  return nangoMock.post.mock.calls.filter(([config]) => {
    const data = ((config as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
    return String(data.query ?? '').includes('TrevraCreateBufferDraft');
  });
}
beforeAll(async () => {
  process.env.NANGO_API_KEY = 'buffer-api-test-key';
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  app = createApp(db);
  session = await seedSession();
  await seedPlaybooks(db, NOW);
});

beforeEach(async () => {
  nangoMock.post.mockClear();
  await db.prepare('DELETE FROM playbook_runs WHERE workspace_id IN (?,?)').run(WORKSPACE, OTHER);
  await db.prepare('DELETE FROM linkedin_posts WHERE workspace_id IN (?,?)').run(WORKSPACE, OTHER);
  await db.prepare('DELETE FROM content_assets WHERE workspace_id IN (?,?)').run(WORKSPACE, OTHER);
  await db.prepare('DELETE FROM connections WHERE workspace_id IN (?,?)').run(WORKSPACE, OTHER);
  await seedBufferConnection();
});

afterAll(async () => {
  delete process.env.NANGO_API_KEY;
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
  await closeAuthDatabase();
});

describe('Buffer content API handoff', () => {
  it('prepares without an external write and creates exactly one unscheduled Buffer draft after approval', async () => {
    await seedProvenancePost(WORKSPACE, 'lipost_buffer_api');
    const channels = await authed('get', '/api/content/buffer/channels');
    expect({ status: channels.status, body: channels.body }).toMatchObject({
      status: 200,
      body: {
        connected: true,
        channels: [expect.objectContaining({ id: 'channel_linkedin', service: 'linkedin' })]
      }
    });

    nangoMock.post.mockClear();
    const prepared = await authed('post', '/api/content/posts/lipost_buffer_api/buffer-draft')
      .send({ channelId: 'channel_linkedin' })
      .expect(201);
    expect(prepared.body.run).toMatchObject({
      workspaceId: WORKSPACE,
      playbookId: 'gtm.buffer-draft',
      status: 'waiting_approval'
    });
    expect(bufferMutationCalls()).toHaveLength(0);
    const approval = prepared.body.run.steps.find(
      (step: { stepId: string; status: string }) =>
        step.stepId === 'approve-buffer-draft' && step.status === 'waiting_approval'
    );
    expect(approval).toBeTruthy();

    const decided = await authed(
      'post',
      `/api/playbook-runs/${encodeURIComponent(prepared.body.run.id)}/steps/approve-buffer-draft/decision`
    )
      .send({ decision: 'approve' })
      .expect(200);
    expect(decided.body.run).toMatchObject({ status: 'completed' });
    expect(decided.body.run.output).toMatchObject({
      delivery: {
        provider: 'buffer',
        externalRef: 'buffer_draft_api_1',
        actionType: 'buffer.create-draft'
      }
    });
    expect(bufferMutationCalls()).toHaveLength(1);
    const mutationConfig = bufferMutationCalls()[0]![0] as Record<string, unknown>;
    const mutationData = mutationConfig.data as {
      variables?: { input?: Record<string, unknown> };
    };
    expect(mutationData.variables?.input).toMatchObject({
      text: 'Evidence-backed Buffer draft',
      channelId: 'channel_linkedin',
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true
    });
    expect(mutationData.variables?.input).not.toHaveProperty('dueAt');
  });

  it('rejects non-provenance and foreign posts before any Buffer write', async () => {
    await seedProvenancePost(WORKSPACE, 'lipost_buffer_plain', false);
    await seedProvenancePost(OTHER, 'lipost_buffer_foreign');
    await seedBufferConnection(OTHER);

    await authed('post', '/api/content/posts/lipost_buffer_plain/buffer-draft')
      .send({ channelId: 'channel_linkedin' })
      .expect(409);
    await authed('post', '/api/content/posts/lipost_buffer_foreign/buffer-draft')
      .send({ channelId: 'channel_linkedin' })
      .expect(404);
    expect(bufferMutationCalls()).toHaveLength(0);
  });
});
