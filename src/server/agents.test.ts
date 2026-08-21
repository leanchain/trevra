import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createAgentToken, resolveAgentIdentity } from './agent-access.js';
import { startAgentRun } from './agent/runs.js';
import { createAgent, ensureDefaultAgent, listAgents, updateAgent } from './agents.js';

const WORKSPACE = 'ws_agent_principal_test';
const USER = 'usr_agent_principal_test';
const NOW = '2026-08-21T09:00:00.000Z';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Agent principals', NOW);
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'founder@agents.test', 'Founder', NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('durable Agent principals', () => {
  it('keeps credentials separate from the Agent actor identity', async () => {
    const agent = await ensureDefaultAgent(db, WORKSPACE, USER);
    const first = await createAgentToken(db, {
      workspaceId: WORKSPACE,
      userId: USER,
      agentId: agent.id,
      name: 'Claude credential'
    });
    const second = await createAgentToken(db, {
      workspaceId: WORKSPACE,
      userId: USER,
      agentId: agent.id,
      name: 'Codex credential'
    });

    const firstIdentity = await resolveAgentIdentity(db, {
      authorization: `Bearer ${first.token}`
    });
    const secondIdentity = await resolveAgentIdentity(db, {
      authorization: `Bearer ${second.token}`
    });

    expect(firstIdentity).toMatchObject({
      agentId: agent.id,
      tokenId: first.record.id,
      name: 'GTM Agent',
      tokenName: 'Claude credential'
    });
    expect(secondIdentity).toMatchObject({
      agentId: agent.id,
      tokenId: second.record.id,
      name: 'GTM Agent',
      tokenName: 'Codex credential'
    });
    expect(firstIdentity?.tokenId).not.toBe(secondIdentity?.tokenId);
    expect(firstIdentity?.agentId).toBe(secondIdentity?.agentId);
  });

  it('binds run execution to the Agent principal rather than using the run id as identity', async () => {
    const agent = await createAgent(db, {
      workspaceId: WORKSPACE,
      createdByUserId: USER,
      name: 'Prospecting Agent',
      purpose: 'Research and prepare prospecting work.'
    });
    const run = await startAgentRun(db, {
      workspaceId: WORKSPACE,
      agentId: agent.id,
      trigger: 'manual',
      goal: 'Research ten target accounts',
      maxSteps: 4
    });

    expect(run.agentId).toBe(agent.id);
    expect(run.id).not.toBe(agent.id);
    const agents = await listAgents(db, WORKSPACE);
    expect(agents.find((item) => item.id === agent.id)).toMatchObject({
      runCount: 1,
      latestRunId: run.id,
      latestRunStatus: 'running'
    });
  });

  it('stops credentials authenticating when the owning Agent is paused', async () => {
    const agent = await createAgent(db, {
      workspaceId: WORKSPACE,
      createdByUserId: USER,
      name: 'Inbox Agent',
      purpose: 'Prepare inbox follow-up work.'
    });
    const credential = await createAgentToken(db, {
      workspaceId: WORKSPACE,
      userId: USER,
      agentId: agent.id,
      name: 'Inbox credential'
    });
    expect(
      await resolveAgentIdentity(db, { authorization: `Bearer ${credential.token}` })
    ).not.toBeNull();

    await updateAgent(db, {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      agentId: agent.id,
      status: 'paused'
    });

    expect(
      await resolveAgentIdentity(db, { authorization: `Bearer ${credential.token}` })
    ).toBeNull();
  });

  it('creates only one default Agent for repeated compatibility calls', async () => {
    const first = await ensureDefaultAgent(db, WORKSPACE, USER);
    const second = await ensureDefaultAgent(db, WORKSPACE, USER);
    expect(second.id).toBe(first.id);
    expect((await listAgents(db, WORKSPACE)).filter((agent) => agent.isDefault)).toHaveLength(1);
  });
});
