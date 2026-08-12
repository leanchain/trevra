/**
 * The agent tool surface. One declarative list, two consumers.
 *
 * `src/server/mcp-http.ts` serves this over MCP to an agent on someone's
 * laptop. The hosted in-process loop (BYOK) will serve the same list to a
 * model Trevra drives itself. byok-and-hosted-agent.md §6 opens with the
 * reason they must be the same list: "Exactly what your laptop agent may do.
 * No more, for living closer to the data." Two hand-maintained copies would
 * drift, and the drift would be a privilege escalation.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT, before you add a tool here. app-spec.md §11:
 *
 *   "No agent approves its own work. Not the one on your laptop, not the one
 *    Trevra hosts, not a future one that is very convincing.
 *
 *    `actions:prepare` is an agent scope. `approve` and `execute` deliberately
 *    are not, and adding them is not a feature request -- it is a redesign of
 *    the product's only real promise. Every external write goes through the
 *    hash-pinned approval path: a human signs an exact payload, and a payload
 *    that changed afterwards is rejected rather than sent."
 *
 * So: no tool in this list may approve an action, execute an external write,
 * or send anything. `trevra_prepare_recommendation` stops at 'draft' on
 * purpose. `callAgentTool` enforces scopes, but a scope check cannot save a
 * surface that offers the wrong capability in the first place -- the list
 * itself is the boundary. `tools.test.ts` asserts this and will fail loudly.
 * ---------------------------------------------------------------------------
 */

import type { AgentScope } from '../agent-access.js';
import type { Db } from '../db.js';
import {
  getAgentRevenueBrief,
  listAgentPendingActions,
  prepareRecommendationForAgent
} from '../agent-operations.js';
import {
  getPlaybookRun,
  listPlaybookRuns,
  listWorkspacePlaybooks,
  startPlaybookRun
} from '../playbooks/engine.js';
import { listDomainEvents } from '../control-plane/events.js';
import {
  executeWorkspaceSkill,
  getWorkspaceSkillRun,
  listWorkspaceSkillRuns,
  listWorkspaceSkills,
  type PublicSkillManifest
} from '../skill-api.js';

export interface AgentToolContext {
  db: Db;
  workspaceId: string;
  /** Whoever the run is attributed to: an agent token id, or the hosted run id. */
  actorId: string;
}

export interface AgentToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The agent-token scope this tool requires. `null` = no scope beyond authentication. */
  scope: AgentScope | null;
  /** JSON Schema, object type. Handed to MCP verbatim. */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  run(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown>;
}

/** The built-in tools. Skill tools are appended per workspace by `listAgentTools`. */
export const BUILT_IN_AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'trevra_list_skills',
    title: 'List Trevra skills',
    description: 'List installed GTM skills with versions, side effects, approval requirements, and schemas.',
    // Reading the catalog is what an agent does before it can do anything else,
    // and it reveals nothing a token holder cannot already see.
    scope: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx) => listWorkspaceSkills(ctx.db, ctx.workspaceId)
  },
  {
    name: 'trevra_list_playbooks',
    title: 'List Trevra playbooks',
    description: 'List installed versioned GTM playbooks and their input contracts.',
    scope: 'playbooks:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx) => listWorkspacePlaybooks(ctx.db, ctx.workspaceId)
  },
  {
    name: 'trevra_start_playbook',
    title: 'Start a Trevra playbook',
    description: 'Start a durable playbook run. The run persists each step and pauses at approval boundaries.',
    scope: 'playbooks:run',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'string' },
        version: { type: 'string' },
        input: { type: 'object', additionalProperties: true }
      },
      required: ['playbookId', 'input'],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    run: (ctx, args) => {
      const input = asObject(args);
      return startPlaybookRun(ctx.db, {
        workspaceId: ctx.workspaceId,
        playbookId: requiredString(input.playbookId, 'playbookId'),
        version: optionalString(input.version),
        payload: input.input ?? {},
        actorType: 'agent',
        actorId: ctx.actorId
      });
    }
  },
  {
    name: 'trevra_list_playbook_runs',
    title: 'List Trevra playbook runs',
    description: 'List durable playbook runs and their current status.',
    scope: 'workflows:read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued','running','waiting_approval','completed','failed','cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => {
      const input = asObject(args);
      const status = typeof input.status === 'string' ? input.status as never : undefined;
      return listPlaybookRuns(ctx.db, ctx.workspaceId, { status, limit: optionalInteger(input.limit) });
    }
  },
  {
    name: 'trevra_get_playbook_run',
    title: 'Get a Trevra playbook run',
    description: 'Read one durable playbook run with persisted step state and approval status.',
    scope: 'workflows:read',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: async (ctx, args) => {
      const run = await getPlaybookRun(ctx.db, ctx.workspaceId, requiredString(asObject(args).runId, 'runId'));
      if (!run) throw new Error('Playbook run not found');
      return run;
    }
  },
  {
    name: 'trevra_list_events',
    title: 'List Trevra control-plane events',
    description: 'Read ordered append-only domain events for a workspace or workflow.',
    scope: 'workflows:read',
    inputSchema: {
      type: 'object',
      properties: {
        streamType: { type: 'string' },
        streamId: { type: 'string' },
        correlationId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
      },
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => {
      const input = asObject(args);
      return listDomainEvents(ctx.db, ctx.workspaceId, {
        streamType: optionalString(input.streamType),
        streamId: optionalString(input.streamId),
        correlationId: optionalString(input.correlationId),
        limit: optionalInteger(input.limit)
      });
    }
  },
  {
    name: 'trevra_list_runs',
    title: 'List Trevra skill runs',
    description: 'Read recent skill-ledger entries for this workspace.',
    scope: 'runs:read',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'error'] },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => {
      const input = asObject(args);
      return listWorkspaceSkillRuns(ctx.db, ctx.workspaceId, {
        skillId: optionalString(input.skillId),
        status: input.status === 'ok' || input.status === 'error' ? input.status : undefined,
        limit: optionalInteger(input.limit)
      });
    }
  },
  {
    name: 'trevra_get_run',
    title: 'Get a Trevra skill run',
    description: 'Read one recorded skill run with input, output, evidence, timing, and error.',
    scope: 'runs:read',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: async (ctx, args) => {
      const run = await getWorkspaceSkillRun(ctx.db, ctx.workspaceId, requiredString(asObject(args).runId, 'runId'));
      if (!run) throw new Error('Skill run not found');
      return run;
    }
  },
  {
    name: 'trevra_revenue_brief',
    title: 'Read the Trevra revenue brief',
    description: 'Read current evidence-backed recommendations, connected sources, standing instructions, and pending actions.',
    scope: 'workspace:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx) => getAgentRevenueBrief(ctx.db, ctx.workspaceId)
  },
  {
    name: 'trevra_list_pending_actions',
    title: 'List pending Trevra actions',
    description: 'List draft, approved, scheduled, and failed actions in the workspace control plane.',
    scope: 'workspace:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx) => listAgentPendingActions(ctx.db, ctx.workspaceId)
  },
  {
    // The far end of what an agent may do. It stops at 'draft'; a human moves it.
    name: 'trevra_prepare_recommendation',
    title: 'Prepare a Trevra recommendation',
    description: 'Prepare one recommendation as a draft action for founder review. This never approves or executes it.',
    scope: 'actions:prepare',
    inputSchema: {
      type: 'object',
      properties: { recommendationId: { type: 'string' } },
      required: ['recommendationId'],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => prepareRecommendationForAgent(
      ctx.db,
      ctx.workspaceId,
      ctx.actorId,
      requiredString(asObject(args).recommendationId, 'recommendationId')
    )
  }
];

const BUILT_IN_BY_NAME = new Map(BUILT_IN_AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** Is this a built-in, as opposed to a per-workspace skill tool? */
export function isBuiltInAgentTool(name: string): boolean {
  return BUILT_IN_BY_NAME.has(name);
}

export function toolNameForSkill(skillId: string): string {
  return `trevra_${skillId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Built-ins + one tool per enabled workspace skill. */
export async function listAgentTools(db: Db, workspaceId: string): Promise<AgentToolDefinition[]> {
  const skills = await listWorkspaceSkills(db, workspaceId);
  return [...BUILT_IN_AGENT_TOOLS, ...skills.filter((skill) => skill.enabled).map(skillToolDefinition)];
}

/** Resolve, enforce scope, run. Throws on an unknown tool or a missing scope. */
export async function callAgentTool(
  ctx: AgentToolContext,
  identityScopes: readonly AgentScope[],
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = await resolveAgentTool(ctx.db, ctx.workspaceId, name);
  if (!tool) throw new Error(`Unknown Trevra tool: ${name}`);
  if (tool.scope && !identityScopes.includes(tool.scope)) {
    throw new Error(`Agent token is missing scope: ${tool.scope}`);
  }
  return tool.run(ctx, args);
}

/**
 * Resolution deliberately sees DISABLED skills too, while `listAgentTools`
 * hides them. `executeWorkspaceSkill` already refuses a disabled skill with
 * "Skill is disabled: <id>", which is the answer an operator can act on --
 * resolving to nothing here would report it as an unknown tool instead and send
 * them looking for a typo. A disabled skill is still unrunnable either way.
 */
async function resolveAgentTool(db: Db, workspaceId: string, name: string): Promise<AgentToolDefinition | null> {
  const builtIn = BUILT_IN_BY_NAME.get(name);
  if (builtIn) return builtIn;
  const skills = await listWorkspaceSkills(db, workspaceId);
  const skill = skills.find((candidate) => toolNameForSkill(candidate.id) === name);
  return skill ? skillToolDefinition(skill) : null;
}

function skillToolDefinition(skill: PublicSkillManifest): AgentToolDefinition {
  const approval = skill.requiresApproval ? ' Founder approval is required before consequential use.' : '';
  const sideEffect = skill.sideEffect === 'none'
    ? 'Pure computation.'
    : skill.sideEffect === 'network-read'
      ? 'Reads public network resources.'
      : 'Changes an external system and must use the approved-action path.';
  return {
    name: toolNameForSkill(skill.id),
    title: skill.name,
    description: `${skill.description} ${sideEffect}${approval}`,
    scope: 'skills:run',
    inputSchema: skill.inputSchema.type === 'object'
      ? skill.inputSchema
      : { type: 'object', properties: { input: skill.inputSchema }, required: ['input'], additionalProperties: false },
    readOnly: skill.sideEffect !== 'external-write',
    destructive: skill.sideEffect === 'external-write',
    idempotent: skill.sideEffect !== 'external-write',
    openWorld: skill.sideEffect !== 'none',
    run: async (ctx, args) => {
      const result = await executeWorkspaceSkill(ctx.db, {
        workspaceId: ctx.workspaceId,
        skillId: skill.id,
        payload: args,
        actorType: 'agent',
        actorId: ctx.actorId
      });
      return {
        ...result,
        instruction: result.approvalRequired
          ? 'Founder approval is required before this output is used for any consequential or external action.'
          : 'The run completed and was recorded in the Trevra ledger.'
      };
    }
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
