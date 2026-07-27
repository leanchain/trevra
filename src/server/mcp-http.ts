import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentIdentity } from './agent-access.js';
import { hasAgentScope } from './agent-access.js';
import type { Db } from './db.js';
import { getAgentRevenueBrief, listAgentPendingActions, prepareRecommendationForAgent } from './agent-operations.js';
import {
  getPlaybookRun,
  listPlaybookRuns,
  listWorkspacePlaybooks,
  startPlaybookRun
} from './playbooks/engine.js';
import { listDomainEvents } from './control-plane/events.js';
import {
  executeWorkspaceSkill,
  getWorkspaceSkillRun,
  listWorkspaceSkillRuns,
  listWorkspaceSkills,
  type PublicSkillManifest
} from './skill-api.js';

export async function handleMcpHttpRequest(
  db: Db,
  identity: AgentIdentity,
  req: Request,
  res: Response
): Promise<void> {
  const skills = await listWorkspaceSkills(db, identity.workspaceId);
  const skillByToolName = new Map<string, PublicSkillManifest>();
  for (const skill of skills) skillByToolName.set(toolNameForSkill(skill.id), skill);

  const server = new Server(
    { name: 'trevra', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'Trevra runs modular go-to-market skills and records every attempt in a workspace ledger.',
        'Approval-required outputs must not be sent or otherwise used consequentially until the founder approves them in Trevra.',
        'External-write skills cannot execute through the generic skill runner.'
      ].join(' ')
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'trevra_list_skills',
        title: 'List Trevra skills',
        description: 'List installed GTM skills with versions, side effects, approval requirements, and schemas.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_list_playbooks',
        title: 'List Trevra playbooks',
        description: 'List installed versioned GTM playbooks and their input contracts.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_start_playbook',
        title: 'Start a Trevra playbook',
        description: 'Start a durable playbook run. The run persists each step and pauses at approval boundaries.',
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
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      {
        name: 'trevra_list_playbook_runs',
        title: 'List Trevra playbook runs',
        description: 'List durable playbook runs and their current status.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['queued','running','waiting_approval','completed','failed','cancelled'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_get_playbook_run',
        title: 'Get a Trevra playbook run',
        description: 'Read one durable playbook run with persisted step state and approval status.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' } },
          required: ['runId'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_list_events',
        title: 'List Trevra control-plane events',
        description: 'Read ordered append-only domain events for a workspace or workflow.',
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
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_list_runs',
        title: 'List Trevra skill runs',
        description: 'Read recent skill-ledger entries for this workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            skillId: { type: 'string' },
            status: { type: 'string', enum: ['ok', 'error'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_get_run',
        title: 'Get a Trevra skill run',
        description: 'Read one recorded skill run with input, output, evidence, timing, and error.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' } },
          required: ['runId'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_revenue_brief',
        title: 'Read the Trevra revenue brief',
        description: 'Read current evidence-backed recommendations, connected sources, standing instructions, and pending actions.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_list_pending_actions',
        title: 'List pending Trevra actions',
        description: 'List draft, approved, scheduled, and failed actions in the workspace control plane.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: 'trevra_prepare_recommendation',
        title: 'Prepare a Trevra recommendation',
        description: 'Prepare one recommendation as a draft action for founder review. This never approves or executes it.',
        inputSchema: {
          type: 'object',
          properties: { recommendationId: { type: 'string' } },
          required: ['recommendationId'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      ...skills.filter((skill) => skill.enabled).map(skillTool)
    ] as Tool[]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args = {} } = request.params;
      if (name === 'trevra_list_skills') return toolResult(skills);
      if (name === 'trevra_list_playbooks') {
        requireScope(identity, 'playbooks:read');
        return toolResult(await listWorkspacePlaybooks(db, identity.workspaceId));
      }
      if (name === 'trevra_start_playbook') {
        requireScope(identity, 'playbooks:run');
        const input = asObject(args);
        return toolResult(await startPlaybookRun(db, {
          workspaceId: identity.workspaceId,
          playbookId: requiredString(input.playbookId, 'playbookId'),
          version: optionalString(input.version),
          payload: input.input ?? {},
          actorType: 'agent',
          actorId: identity.tokenId
        }));
      }
      if (name === 'trevra_list_playbook_runs') {
        requireScope(identity, 'workflows:read');
        const input = asObject(args);
        const status = typeof input.status === 'string' ? input.status as never : undefined;
        return toolResult(await listPlaybookRuns(db, identity.workspaceId, { status, limit: optionalInteger(input.limit) }));
      }
      if (name === 'trevra_get_playbook_run') {
        requireScope(identity, 'workflows:read');
        const run = await getPlaybookRun(db, identity.workspaceId, requiredString(asObject(args).runId, 'runId'));
        if (!run) throw new Error('Playbook run not found');
        return toolResult(run);
      }
      if (name === 'trevra_list_events') {
        requireScope(identity, 'workflows:read');
        const input = asObject(args);
        return toolResult(await listDomainEvents(db, identity.workspaceId, {
          streamType: optionalString(input.streamType),
          streamId: optionalString(input.streamId),
          correlationId: optionalString(input.correlationId),
          limit: optionalInteger(input.limit)
        }));
      }
      if (name === 'trevra_list_runs') {
        requireScope(identity, 'runs:read');
        const input = asObject(args);
        return toolResult(await listWorkspaceSkillRuns(db, identity.workspaceId, {
          skillId: optionalString(input.skillId),
          status: input.status === 'ok' || input.status === 'error' ? input.status : undefined,
          limit: optionalInteger(input.limit)
        }));
      }
      if (name === 'trevra_get_run') {
        requireScope(identity, 'runs:read');
        const run = await getWorkspaceSkillRun(db, identity.workspaceId, requiredString(asObject(args).runId, 'runId'));
        if (!run) throw new Error('Skill run not found');
        return toolResult(run);
      }
      if (name === 'trevra_revenue_brief') {
        requireScope(identity, 'workspace:read');
        return toolResult(await getAgentRevenueBrief(db, identity.workspaceId));
      }
      if (name === 'trevra_list_pending_actions') {
        requireScope(identity, 'workspace:read');
        return toolResult(await listAgentPendingActions(db, identity.workspaceId));
      }
      if (name === 'trevra_prepare_recommendation') {
        requireScope(identity, 'actions:prepare');
        return toolResult(await prepareRecommendationForAgent(
          db,
          identity.workspaceId,
          identity.tokenId,
          requiredString(asObject(args).recommendationId, 'recommendationId')
        ));
      }

      const skill = skillByToolName.get(name);
      if (!skill) throw new Error(`Unknown Trevra tool: ${name}`);
      requireScope(identity, 'skills:run');
      const result = await executeWorkspaceSkill(db, {
        workspaceId: identity.workspaceId,
        skillId: skill.id,
        payload: args,
        actorType: 'agent',
        actorId: identity.tokenId
      });
      return toolResult({
        ...result,
        instruction: result.approvalRequired
          ? 'Founder approval is required before this output is used for any consequential or external action.'
          : 'The run completed and was recorded in the Trevra ledger.'
      }, result.run.status === 'error');
    } catch (error) {
      return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal MCP error' },
        id: null
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export function rejectMcpNonPost(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use MCP Streamable HTTP POST.' },
    id: null
  });
}

function skillTool(skill: PublicSkillManifest): Tool {
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
    inputSchema: skill.inputSchema.type === 'object'
      ? skill.inputSchema as Tool['inputSchema']
      : { type: 'object', properties: { input: skill.inputSchema }, required: ['input'], additionalProperties: false },
    annotations: {
      readOnlyHint: skill.sideEffect !== 'external-write',
      destructiveHint: skill.sideEffect === 'external-write',
      idempotentHint: skill.sideEffect !== 'external-write',
      openWorldHint: skill.sideEffect !== 'none'
    }
  };
}

function toolNameForSkill(skillId: string): string {
  return `trevra_${skillId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function requireScope(identity: AgentIdentity, scope:
  | 'skills:run' | 'runs:read' | 'workspace:read' | 'actions:prepare'
  | 'playbooks:read' | 'playbooks:run' | 'workflows:read'
): void {
  if (!hasAgentScope(identity, scope)) throw new Error(`Agent token is missing scope: ${scope}`);
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
