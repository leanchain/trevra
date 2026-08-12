import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { TrevraAgentClient } from '../agent/client.js';

/**
 * The stdio bridge is transport, not a second tool surface. It speaks MCP to
 * `POST /api/agent/mcp`, which is the one place tool names, schemas,
 * annotations, scope checks and dispatch live (`src/server/agent/tools.ts`).
 * A tool added there is visible over stdio with no change here.
 */

/** Used only if the API build behind us is older than instructions support. */
const FALLBACK_INSTRUCTIONS = [
  'Trevra is the ledger and control plane for modular go-to-market skills.',
  'Use skill tools to perform typed GTM work. Every attempt is recorded in the workspace ledger.',
  'A tool marked approval-required may prepare consequential work, but its output must not be sent or executed without the founder approving it in Trevra.',
  'External-write skills are rejected by the generic runner and must use Trevra\'s hash-pinned action approval path.'
].join(' ');

const api = configure();
const endpoint = new URL(`${api.baseUrl}/api/agent/mcp`);
// TrevraAgentClient owns token resolution -- environment variable first, then
// TREVRA_AGENT_TOKEN_FILE -- and refuses to construct without one. Reading the
// variable again here would send an empty bearer whenever the token came from
// the file, which the API answers with a 401 the bridge reports as "could not
// reach the Trevra API".
const requestTimeoutMs = timeoutMs();

const upstream = new Client({ name: 'trevra-stdio-bridge', version: '0.1.0' });
const upstreamTransport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: api.authorization } }
});
upstream.onerror = (error) => console.error(`Trevra MCP bridge upstream error: ${describe(error)}`);
upstreamTransport.onerror = (error) => console.error(`Trevra MCP bridge transport error: ${describe(error)}`);

let toolCount = 0;
try {
  await upstream.connect(upstreamTransport);
  toolCount = (await upstream.listTools(undefined, { timeout: requestTimeoutMs })).tools.length;
} catch (error) {
  await upstream.close().catch(() => undefined);
  fatal([
    `Trevra MCP bridge could not reach the Trevra API at ${endpoint}.`,
    `Cause: ${describe(error)}`,
    'Set TREVRA_API_URL to the Trevra API origin (default http://localhost:43887)',
    'and TREVRA_AGENT_TOKEN to a scoped workspace agent token, then retry.'
  ]);
}

// Prefer what the endpoint advertises, for the same reason the tool list is
// proxied: one surface, no silent drift between hosted and laptop agents.
const server = new Server(
  { name: 'trevra', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: upstream.getInstructions() ?? FALLBACK_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  forward(() => upstream.listTools(request.params, { timeout: requestTimeoutMs }), 'list tools')
);

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  forward(
    () => upstream.callTool(request.params, undefined, { timeout: requestTimeoutMs }),
    `call ${request.params.name}`
  )
);

let closing = false;
server.onclose = () => void shutdown(0);
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// A bridge that dies silently is the worst outcome for a founder mid-session,
// so a stray rejection is reported on stderr instead of taking the process out.
process.on('unhandledRejection', (reason) =>
  console.error(`Trevra MCP bridge unhandled rejection: ${describe(reason)}`)
);

await server.connect(new StdioServerTransport());
console.error(`Trevra MCP bridge connected to ${endpoint} with ${toolCount} tools`);

/** Transport failures become readable MCP errors rather than a dead bridge. */
async function forward<T>(run: () => Promise<T>, what: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Trevra MCP bridge could not ${what} via ${endpoint}: ${describe(error)}`
    );
  }
}

function configure(): TrevraAgentClient {
  try {
    return new TrevraAgentClient();
  } catch (error) {
    fatal([`Trevra MCP bridge cannot start: ${describe(error)}`]);
  }
}

function timeoutMs(): number {
  const configured = Number(process.env.TREVRA_AGENT_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    await server.close().catch(() => undefined);
    await upstream.close().catch(() => undefined);
  }
  process.exit(code);
}

function fatal(lines: string[]): never {
  console.error(lines.join('\n'));
  process.exit(1);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
  return String(error);
}
