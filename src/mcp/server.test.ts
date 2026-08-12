import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const UPSTREAM_INSTRUCTIONS = 'Mock Trevra instructions from the HTTP endpoint.';
const UPSTREAM_TOOLS = [
  {
    name: 'trevra_revenue_brief',
    title: 'Read the Trevra revenue brief',
    description: 'Read current evidence-backed recommendations.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'trevra_gtm_test-score',
    title: 'Test score',
    description: 'Score one test lead. Pure computation.',
    inputSchema: {
      type: 'object' as const,
      properties: { company: { type: 'string' } },
      required: ['company'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

interface Upstream {
  url: string;
  authorizations: string[];
  calls: Array<{ name: string; arguments: unknown }>;
  close: () => Promise<void>;
}

let upstream: Upstream | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await upstream?.close();
  upstream = undefined;
});

/** A stand-in for POST /api/agent/mcp that speaks the same Streamable HTTP MCP. */
async function startUpstream(): Promise<Upstream> {
  const authorizations: string[] = [];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const httpServer: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      void (async () => {
        if (req.headers.authorization) authorizations.push(req.headers.authorization);
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const server = new McpServer(
          { name: 'trevra', version: '0.1.0' },
          { capabilities: { tools: {} }, instructions: UPSTREAM_INSTRUCTIONS }
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: UPSTREAM_TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args = {} } = request.params;
          calls.push({ name, arguments: args });
          if (name === 'trevra_gtm_test-score') {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ run: { output: { score: 0.9 } } }) }],
              isError: false
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown Trevra tool: ${name}` }) }],
            isError: true
          };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
        } finally {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
      })();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Mock Trevra API did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizations,
    calls,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve()))
  };
}

function bridgeEnv(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  return { ...inherited, ...overrides };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Probe did not bind');
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('Trevra MCP stdio bridge', () => {
  it('proxies listTools, callTool and instructions to the HTTP MCP endpoint', async () => {
    upstream = await startUpstream();
    client = new Client({ name: 'trevra-mcp-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      env: bridgeEnv({
        TREVRA_API_URL: upstream.url,
        TREVRA_AGENT_TOKEN: 'trv_live_test_token_abcdefghijklmnopqrstuvwxyz'
      }),
      stderr: 'pipe'
    }));

    // The bridge advertises the endpoint's instructions, not a local copy.
    expect(client.getInstructions()).toBe(UPSTREAM_INSTRUCTIONS);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['trevra_gtm_test-score', 'trevra_revenue_brief']);
    const scoreTool = listed.tools.find((tool) => tool.name === 'trevra_gtm_test-score');
    expect(scoreTool?.title).toBe('Test score');
    expect(scoreTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { company: { type: 'string' } },
      required: ['company']
    });
    expect(scoreTool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const called = await client.callTool({ name: 'trevra_gtm_test-score', arguments: { company: 'Acme' } });
    expect(called.isError).not.toBe(true);
    const content = called.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === 'text')?.text;
    expect(text ? JSON.parse(text).run.output.score : null).toBe(0.9);
    expect(upstream.calls).toEqual([{ name: 'trevra_gtm_test-score', arguments: { company: 'Acme' } }]);

    // An upstream tool error stays a tool error and does not kill the bridge.
    const failed = await client.callTool({ name: 'trevra_unknown', arguments: {} });
    expect(failed.isError).toBe(true);
    const stillAlive = await client.listTools();
    expect(stillAlive.tools).toHaveLength(2);

    expect(upstream.authorizations.length).toBeGreaterThan(0);
    expect(upstream.authorizations.every(
      (value) => value === 'Bearer trv_live_test_token_abcdefghijklmnopqrstuvwxyz'
    )).toBe(true);
  }, 30_000);

  it('exits with a readable message naming the URL when the API is unreachable', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp/server.ts'], {
      cwd: process.cwd(),
      env: bridgeEnv({ TREVRA_API_URL: url, TREVRA_AGENT_TOKEN: 'trv_live_test_token_abcdefghijklmnopqrstuvwxyz' }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain(`${url}/api/agent/mcp`);
    expect(stderr).toContain('TREVRA_API_URL');
    expect(stderr).toContain('TREVRA_AGENT_TOKEN');
  }, 30_000);

  it('exits with a readable message when no agent token is configured', async () => {
    const env = bridgeEnv({ TREVRA_API_URL: 'http://127.0.0.1:1' });
    delete env.TREVRA_AGENT_TOKEN;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp/server.ts'], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain('TREVRA_AGENT_TOKEN is required');
  }, 30_000);
});
