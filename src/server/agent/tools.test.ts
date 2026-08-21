import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { AGENT_SCOPES, type AgentScope } from '../agent-access.js';
import { BUILT_IN_AGENT_TOOLS, callAgentTool, listAgentTools, toolNameForSkill } from './tools.js';

let db: Db;
const WORKSPACE_ID = 'ws_agent_tools_test';
const ACTOR_ID = 'tok_agent_tools_test';
const SCORE_SKILL_ID = 'gtm.score-lead';
const SCORE_TOOL = 'trevra_gtm_score-lead';
const SCORE_ARGS = { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  // Dropping the workspace cascades every row this file writes, so each test
  // starts from the same empty ledger regardless of order.
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Agent tools test', new Date().toISOString());
});

afterEach(async () => {
  await db?.close();
});

function ctx() {
  return { db, workspaceId: WORKSPACE_ID, actorId: ACTOR_ID };
}

async function skillRunCount(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS count FROM skill_runs WHERE workspace_id=?')
    .get<{ count: number }>(WORKSPACE_ID);
  return row?.count ?? 0;
}

/**
 * The drift guard. MCP and the hosted loop read the same list, so a tool that
 * silently appears, disappears, or changes scope changes what an autonomous
 * agent may do. Editing this table is the deliberate act; editing tools.ts
 * alone is not.
 */
const EXPECTED_BUILT_INS: ReadonlyArray<readonly [string, AgentScope | null]> = [
  ['trevra_list_skills', null],
  ['trevra_list_people', 'workspace:read'],
  ['trevra_list_accounts', 'workspace:read'],
  ['trevra_list_opportunities', 'workspace:read'],
  ['trevra_list_conversations', 'workspace:read'],
  ['trevra_list_deliveries', 'workspace:read'],
  ['trevra_list_playbooks', 'playbooks:read'],
  ['trevra_start_playbook', 'playbooks:run'],
  ['trevra_list_playbook_runs', 'workflows:read'],
  ['trevra_get_playbook_run', 'workflows:read'],
  ['trevra_list_events', 'workflows:read'],
  ['trevra_list_runs', 'runs:read'],
  ['trevra_get_run', 'runs:read']
];

describe('the built-in tool surface', () => {
  it('is exactly the GTM-only built-in tool surface', () => {
    expect(BUILT_IN_AGENT_TOOLS.map((tool) => [tool.name, tool.scope])).toEqual(
      EXPECTED_BUILT_INS.map(([name, scope]) => [name, scope])
    );
  });

  it('declares an object input schema for every tool', async () => {
    for (const tool of await listAgentTools(db, WORKSPACE_ID)) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
  });
});

/**
 * A skill that changes something outside Trevra, installed for real.
 *
 * The point of the fixture is its NAME. `gtm.share-update` reads like a
 * reporting helper and matches no keyword any invariant test greps for, while
 * declaring `sideEffect: 'external-write'` -- so it is exactly the skill a
 * name-based check waves through. The rows are written directly rather than
 * through the signed publish path because the subject under test is the guard
 * in skill-api.ts, not the registry.
 */
const EXTERNAL_WRITE_SKILL_ID = 'gtm.share-update';
const EXTERNAL_WRITE_TOOL = 'trevra_gtm_share-update';

async function installExternalWriteSkill(): Promise<void> {
  const manifest = {
    id: EXTERNAL_WRITE_SKILL_ID,
    version: '1.0.0',
    name: 'Share update',
    description: 'Posts a workspace update to a connected external channel.',
    runtime: 'remote',
    artifact: { ref: 'https://module.example/share-update', digest: `sha256:${'b'.repeat(64)}` },
    entrypoint: [],
    sideEffect: 'external-write',
    requiresApproval: true,
    permissions: { network: ['module.example'], secrets: [], filesystem: 'none' },
    resources: { timeoutSeconds: 5, memoryMb: 64, cpu: 0.25, maxOutputBytes: 10_000 },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: { posted: { type: 'boolean' } },
      required: ['posted'],
      additionalProperties: false
    },
    source: {
      repository: 'https://example.com/test/share-update',
      commit: 'abcdef1',
      license: 'MIT'
    }
  };

  await db
    .prepare(
      `
    INSERT INTO module_packages (module_id, publisher_id, source_type, name, description, visibility, latest_version)
    VALUES (?, NULL, 'community', ?, ?, 'public', ?)
    ON CONFLICT (module_id) DO NOTHING
  `
    )
    .run(manifest.id, manifest.name, manifest.description, manifest.version);

  await db
    .prepare(
      `
    INSERT INTO module_releases (
      module_id, version, runtime, artifact_ref, artifact_digest, manifest_json, permissions_json,
      input_schema_json, output_schema_json, side_effect, requires_approval, signature_payload_hash, status
    ) VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,'external-write',TRUE,?, 'verified')
    ON CONFLICT (module_id, version) DO NOTHING
  `
    )
    .run(
      manifest.id,
      manifest.version,
      manifest.runtime,
      manifest.artifact.ref,
      manifest.artifact.digest,
      JSON.stringify(manifest),
      JSON.stringify(manifest.permissions),
      JSON.stringify(manifest.inputSchema),
      JSON.stringify(manifest.outputSchema),
      'a'.repeat(64)
    );

  await db
    .prepare(
      `
    INSERT INTO workspace_module_installations (workspace_id, module_id, version, enabled, config_json)
    VALUES (?,?,?,TRUE,'{}'::jsonb)
    ON CONFLICT (workspace_id, module_id) DO NOTHING
  `
    )
    .run(WORKSPACE_ID, manifest.id, manifest.version);
}

describe('the invariant (app-spec section 11)', () => {
  it('offers no tool that can approve, execute, or send anything', async () => {
    const tools = await listAgentTools(db, WORKSPACE_ID);
    expect(tools.length).toBeGreaterThan(EXPECTED_BUILT_INS.length);
    const forbidden = tools.filter((tool) => /approve|execute|send/i.test(tool.name));
    expect(forbidden.map((tool) => tool.name)).toEqual([]);
    // Recommendation preparation is not an agent escape hatch around the action approval boundary.
    expect(tools.some((tool) => tool.name === 'trevra_prepare_recommendation')).toBe(false);
  });

  /**
   * The invariant as a BEHAVIOUR, which is the only version of it worth having.
   *
   * The name filter above is a cheap extra and nothing more: it greps for
   * approve/execute/send/publish, and a skill called `gtm.share-update` sails
   * straight through it while declaring `sideEffect: 'external-write'`. The
   * real boundary is the refusal in skill-api.ts, and until this test existed
   * nothing anywhere -- not `callAgentTool`, not MCP -- ever exercised it. So
   * an agent-reachable external write was guarded only by a naming convention,
   * and a convention is not a boundary.
   */
  it('refuses to run a skill that writes to an external system, whatever it is called', async () => {
    await installExternalWriteSkill();

    const tools = await listAgentTools(db, WORKSPACE_ID);
    const shareUpdate = tools.find((tool) => tool.name === EXTERNAL_WRITE_TOOL);
    // It really is on the surface handed to the model, and really does slip the
    // name filter -- otherwise this test would be proving nothing.
    expect(shareUpdate, 'the external-write fixture must be offered as a tool').toBeDefined();
    expect(/approve|execute|send|publish/i.test(EXTERNAL_WRITE_TOOL)).toBe(false);
    expect(shareUpdate?.destructive).toBe(true);

    // Invoked through the same entry point the hosted loop and MCP both use,
    // holding every scope an agent token can carry. It is still refused.
    await expect(
      callAgentTool(ctx(), [...AGENT_SCOPES], EXTERNAL_WRITE_TOOL, { text: 'we shipped' })
    ).rejects.toThrow(
      `Skill ${EXTERNAL_WRITE_SKILL_ID} changes an external system and must be executed through a prepared, approved Trevra action`
    );

    // Refused before anything ran: no skill run, so nothing left the building.
    expect(await skillRunCount()).toBe(0);
  });

  it('gates every tool on a real agent scope, and leaves only reads ungated', async () => {
    const allowed = new Set<string>(AGENT_SCOPES);
    const ungated: string[] = [];
    for (const tool of await listAgentTools(db, WORKSPACE_ID)) {
      if (tool.scope === null) {
        ungated.push(tool.name);
        // No scope means no scope check, so it had better not change anything.
        expect(tool.readOnly, tool.name).toBe(true);
        expect(tool.destructive, tool.name).toBe(false);
        continue;
      }
      expect(allowed.has(tool.scope), `${tool.name} -> ${tool.scope}`).toBe(true);
    }
    // Reading the catalog is the one thing authentication alone buys.
    expect(ungated).toEqual(['trevra_list_skills']);
  });

  it('never grants approve or execute as a scope, because neither exists', () => {
    expect(AGENT_SCOPES).not.toContain('actions:approve');
    expect(AGENT_SCOPES).not.toContain('actions:execute');
  });
});

describe('callAgentTool', () => {
  it('refuses a token without the required scope and never reaches the handler', async () => {
    await expect(callAgentTool(ctx(), ['workspace:read'], SCORE_TOOL, SCORE_ARGS)).rejects.toThrow(
      'Agent token is missing scope: skills:run'
    );
    // The proof that it stopped before the handler: the skill ledger is empty.
    expect(await skillRunCount()).toBe(0);
  });

  it('runs the handler once the scope is present', async () => {
    const result = (await callAgentTool(ctx(), ['skills:run'], SCORE_TOOL, SCORE_ARGS)) as {
      run: { status: string; output: { wedge: string } };
      instruction: string;
    };
    expect(result.run.status).toBe('ok');
    expect(result.run.output.wedge).toBe('sizing');
    expect(result.instruction).toContain('recorded in the Trevra ledger');
    expect(await skillRunCount()).toBe(1);
  });

  it('runs an ungated tool with no scopes at all', async () => {
    const skills = (await callAgentTool(ctx(), [], 'trevra_list_skills', {})) as Array<{
      id: string;
    }>;
    expect(skills.some((skill) => skill.id === SCORE_SKILL_ID)).toBe(true);
  });

  it('throws on an unknown tool name', async () => {
    await expect(
      callAgentTool(ctx(), [...AGENT_SCOPES], 'trevra_take_over_the_world', {})
    ).rejects.toThrow('Unknown Trevra tool: trevra_take_over_the_world');
  });
});

describe('skill tools', () => {
  it('names a skill tool from its id', () => {
    expect(toolNameForSkill(SCORE_SKILL_ID)).toBe(SCORE_TOOL);
    expect(toolNameForSkill('vendor.thing/v2')).toBe('trevra_vendor_thing_v2');
  });

  it('lists enabled workspace skills and drops the disabled ones', async () => {
    const before = await listAgentTools(db, WORKSPACE_ID);
    expect(before.some((tool) => tool.name === SCORE_TOOL)).toBe(true);

    await db
      .prepare('UPDATE workspace_skills SET enabled=FALSE WHERE workspace_id=? AND skill_id=?')
      .run(WORKSPACE_ID, SCORE_SKILL_ID);

    const after = await listAgentTools(db, WORKSPACE_ID);
    expect(after.some((tool) => tool.name === SCORE_TOOL)).toBe(false);
    // Only that one skill went away; the built-ins are untouched.
    expect(after.length).toBe(before.length - 1);
    for (const [name] of EXPECTED_BUILT_INS) {
      expect(
        after.some((tool) => tool.name === name),
        name
      ).toBe(true);
    }
  });

  it('carries the skill scope and side-effect annotations', async () => {
    const tools = await listAgentTools(db, WORKSPACE_ID);
    const score = tools.find((tool) => tool.name === SCORE_TOOL);
    expect(score?.scope).toBe('skills:run');
    expect(score?.destructive).toBe(false);
    expect(score?.description).toContain('Pure computation.');
  });
});
