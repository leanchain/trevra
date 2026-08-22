import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentIdentity } from './agent-access.js';
import type { Db } from './db.js';
import {
  callAgentTool,
  isBuiltInAgentTool,
  listAgentTools,
  type AgentToolDefinition
} from './agent/tools.js';

/**
 * MCP is a transport over the agent tool surface, not a second definition of
 * it. Every tool, schema, annotation and scope check lives in `agent/tools.ts`
 * so the hosted loop and a laptop agent cannot end up with different powers.
 */
export async function handleMcpHttpRequest(
  db: Db,
  identity: AgentIdentity,
  req: Request,
  res: Response
): Promise<void> {
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
    tools: (await listAgentTools(db, identity.workspaceId, identity.agentId)).map(mcpTool)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args = {} } = request.params;
      const value = await callAgentTool(
        { db, workspaceId: identity.workspaceId, actorId: identity.agentId },
        identity.scopes,
        name,
        args
      );
      // A skill run that ended in 'error' is reported as a tool error, so the
      // caller does not read a failed run as a successful one. Built-ins signal
      // failure by throwing.
      return toolResult(value, !isBuiltInAgentTool(name) && skillRunStatus(value) === 'error');
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
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal MCP error'
        },
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

function mcpTool(definition: AgentToolDefinition): Tool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema as Tool['inputSchema'],
    annotations: {
      readOnlyHint: definition.readOnly,
      destructiveHint: definition.destructive,
      idempotentHint: definition.idempotent,
      openWorldHint: definition.openWorld
    }
  };
}

function skillRunStatus(value: unknown): string | undefined {
  const run = (value as { run?: { status?: unknown } } | null | undefined)?.run;
  return typeof run?.status === 'string' ? run.status : undefined;
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError };
}
