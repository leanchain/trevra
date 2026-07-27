import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TrevraAgentClient, type TrevraSkillManifest } from '../agent/client.js';

const client = new TrevraAgentClient();
const skills = await client.listSkills();
const skillByToolName = new Map<string, TrevraSkillManifest>();
for (const skill of skills) skillByToolName.set(toolNameForSkill(skill.id), skill);

const server = new Server(
  { name: 'trevra', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Trevra is the ledger and control plane for modular go-to-market skills.',
      'Use skill tools to perform typed GTM work. Every attempt is recorded in the workspace ledger.',
      'A tool marked approval-required may prepare consequential work, but its output must not be sent or executed without the founder approving it in Trevra.',
      'External-write skills are rejected by the generic runner and must use Trevra\'s hash-pinned action approval path.'
    ].join(' ')
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'trevra_list_skills',
      title: 'List Trevra skills',
      description: 'List all installed GTM skills, versions, side effects, approval requirements, and schemas.',
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
      description: 'Read the ordered append-only domain event stream for a workspace or workflow.',
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
      description: 'Read recent skill ledger entries for this workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Optional exact skill id filter.' },
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
      description: 'Read one recorded skill run, including its input, output, evidence, timing, and error.',
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
      description: 'Read current evidence-backed recommendations, connected sources, standing instructions, and pending prepared actions. This does not execute external work.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: 'trevra_list_pending_actions',
      title: 'List pending Trevra actions',
      description: 'List draft, approved, scheduled, and failed actions waiting in the control plane.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: 'trevra_prepare_recommendation',
      title: 'Prepare a Trevra recommendation',
      description: 'Turn one evidence-backed recommendation into a draft action for founder review. This never approves or executes the action.',
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
    if (name === 'trevra_list_playbooks') return toolResult(await client.listPlaybooks());
    if (name === 'trevra_start_playbook') {
      const input = asObject(args);
      return toolResult(await client.startPlaybook(
        requiredString(input.playbookId, 'playbookId'),
        input.input ?? {},
        optionalString(input.version)
      ));
    }
    if (name === 'trevra_list_playbook_runs') {
      const input = asObject(args);
      const status = typeof input.status === 'string' ? input.status as never : undefined;
      return toolResult(await client.listPlaybookRuns({ status, limit: optionalInteger(input.limit) }));
    }
    if (name === 'trevra_get_playbook_run') {
      return toolResult(await client.getPlaybookRun(requiredString(asObject(args).runId, 'runId')));
    }
    if (name === 'trevra_list_events') {
      const input = asObject(args);
      return toolResult(await client.listEvents({
        streamType: optionalString(input.streamType),
        streamId: optionalString(input.streamId),
        correlationId: optionalString(input.correlationId),
        limit: optionalInteger(input.limit)
      }));
    }
    if (name === 'trevra_list_runs') {
      const input = asObject(args);
      return toolResult(await client.listRuns({
        skillId: optionalString(input.skillId),
        status: input.status === 'ok' || input.status === 'error' ? input.status : undefined,
        limit: optionalInteger(input.limit)
      }));
    }
    if (name === 'trevra_get_run') {
      const runId = requiredString(asObject(args).runId, 'runId');
      return toolResult(await client.getRun(runId));
    }
    if (name === 'trevra_revenue_brief') return toolResult(await client.getRevenueBrief());
    if (name === 'trevra_list_pending_actions') return toolResult(await client.listPendingActions());
    if (name === 'trevra_prepare_recommendation') {
      const recommendationId = requiredString(asObject(args).recommendationId, 'recommendationId');
      return toolResult(await client.prepareRecommendation(recommendationId));
    }

    const skill = skillByToolName.get(name);
    if (!skill) return errorResult(`Unknown Trevra tool: ${name}`);
    const result = await client.runSkill(skill.id, args);
    return toolResult({
      ...result,
      instruction: result.approvalRequired
        ? 'This output requires founder approval before it is used for any consequential or external action.'
        : 'The run completed and was recorded in the Trevra ledger.'
    }, result.run.status === 'error');
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Trevra MCP connected to ${client.baseUrl} with ${skills.length} installed skills`);

function skillTool(skill: TrevraSkillManifest): Tool {
  const approval = skill.requiresApproval ? ' Output requires founder approval before consequential use.' : '';
  const sideEffect = skill.sideEffect === 'none'
    ? 'Pure computation.'
    : skill.sideEffect === 'network-read'
      ? 'Reads public network resources.'
      : 'Changes an external system and cannot run through the generic endpoint.';
  return {
    name: toolNameForSkill(skill.id),
    title: skill.name,
    description: `${skill.description} ${sideEffect}${approval}`,
    inputSchema: normalizeObjectSchema(skill.inputSchema),
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

function normalizeObjectSchema(schema: Record<string, unknown>): Tool['inputSchema'] {
  if (schema.type === 'object') return schema as Tool['inputSchema'];
  return { type: 'object', properties: { input: schema }, required: ['input'], additionalProperties: false };
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    isError
  };
}

function errorResult(message: string) {
  return toolResult({ error: message }, true);
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
