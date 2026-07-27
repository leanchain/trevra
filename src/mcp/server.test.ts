import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let httpServer: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
  httpServer = undefined;
});

describe('Trevra MCP server', () => {
  it('publishes installed skill schemas and invokes the restricted agent API', async () => {
    const requests: Array<{ method: string; url: string; authorization?: string; body?: unknown }> = [];
    httpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined
        });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url === '/api/agent/skills') {
          return res.end(JSON.stringify({ skills: [{
            id: 'gtm.test-score',
            name: 'Test score',
            version: '1.0.0',
            description: 'Score one test lead.',
            sideEffect: 'none',
            requiresApproval: false,
            enabled: true,
            inputSchema: {
              type: 'object',
              properties: { company: { type: 'string' } },
              required: ['company'],
              additionalProperties: false
            },
            outputSchema: { type: 'object' }
          }] }));
        }
        if (req.method === 'POST' && req.url === '/api/agent/skills/gtm.test-score/run') {
          return res.end(JSON.stringify({
            run: {
              id: 'run_test', skillId: 'gtm.test-score', skillVersion: '1.0.0', workspaceId: 'ws_test',
              status: 'ok', input: JSON.parse(raw), output: { score: 0.9 }, error: null, evidence: [],
              startedAt: '2026-07-27T00:00:00.000Z', finishedAt: '2026-07-27T00:00:00.010Z', durationMs: 10
            },
            approvalRequired: false,
            sideEffect: 'none'
          }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Mock API did not bind');

    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      env: {
        ...env,
        TREVRA_API_URL: `http://127.0.0.1:${address.port}`,
        TREVRA_AGENT_TOKEN: 'trv_live_test_token_abcdefghijklmnopqrstuvwxyz'
      },
      stderr: 'pipe'
    });
    client = new Client({ name: 'trevra-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    const tool = listed.tools.find((item) => item.name === 'trevra_gtm_test-score');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { company: { type: 'string' } },
      required: ['company']
    });

    const called = await client.callTool({
      name: 'trevra_gtm_test-score',
      arguments: { company: 'Acme' }
    });
    expect(called.isError).not.toBe(true);
    const content = called.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === 'text');
    expect(text?.text ? JSON.parse(text.text).run.output.score : null).toBe(0.9);
    expect(requests.every((request) => request.authorization === 'Bearer trv_live_test_token_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ company: 'Acme' });
  });
});
