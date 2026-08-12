import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateText } from 'ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { putWorkspaceAgentConfig, putWorkspaceSecret } from '../secrets/store.js';
import { describeMissingWorkspaceModel, resolveWorkspaceModel } from './provider.js';

/**
 * The transport is real here, which is the point: `loop.test.ts` swaps the model
 * for a double and so cannot see anything the fetch layer does. These tests dial
 * an actual loopback HTTP server, because the two bugs below only exist between
 * `resolveWorkspaceModel` and the socket.
 */

const WORKSPACE_ID = 'ws_agent_provider_test';
const MODEL_ID = 'local-model';
// Distinctive and not a real credential: every leak assertion greps for it.
const API_KEY = 'sk-provider-test-THE-WORKSPACE-KEY-4242';

let db: Db;
let server: Server;
let port: number;
let previousSecretsKey: string | undefined;
let previousPrivateHosts: string | undefined;

interface SeenRequest {
  url: string;
  authorization: string | undefined;
}

const seen: SeenRequest[] = [];
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const chatCompletion: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    })
  );
};

let handler: Handler = chatCompletion;

/** `TREVRA_ALLOW_PRIVATE_MODEL_HOSTS`, set for the duration of `run`. */
async function withPrivateHosts<T>(value: 'true' | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
  if (value === undefined) delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
  else process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
    else process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = before;
  }
}

/** Saves BYOK config + key. The write half needs the flag on for a private URL. */
async function configure(baseUrl: string): Promise<void> {
  await withPrivateHosts('true', async () => {
    await putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl, model: MODEL_ID });
  });
  await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
}

beforeAll(async () => {
  previousSecretsKey = process.env.TREVRA_SECRETS_KEY;
  previousPrivateHosts = process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });

  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(async () => {
  seen.length = 0;
  handler = chatCompletion;
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Agent provider test', new Date().toISOString());
});

afterEach(() => {
  handler = chatCompletion;
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  if (previousPrivateHosts === undefined) delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
  else process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = previousPrivateHosts;
});

describe('resolveWorkspaceModel', () => {
  it('returns null, not an error, until both halves are configured', async () => {
    expect(await resolveWorkspaceModel(db, WORKSPACE_ID)).toBeNull();
    expect(await describeMissingWorkspaceModel(db, WORKSPACE_ID)).toMatch(/not set up/i);

    await withPrivateHosts('true', async () => {
      await putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl: `http://127.0.0.1:${port}/v1`, model: MODEL_ID });
    });
    // Endpoint but no key is still "not opted in".
    expect(await resolveWorkspaceModel(db, WORKSPACE_ID)).toBeNull();

    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
    expect(resolved).toMatchObject({ modelId: MODEL_ID, baseUrl: `http://127.0.0.1:${port}/v1` });
    // Access rule 4: the key is not on the object that comes back.
    expect(JSON.stringify(resolved)).not.toContain(API_KEY);
    expect(await describeMissingWorkspaceModel(db, WORKSPACE_ID)).toMatch(/is set up/i);
  });
});

/**
 * byok-and-hosted-agent.md §3: "A self-hoster running Ollama or vLLM on their own
 * network sets TREVRA_ALLOW_PRIVATE_MODEL_HOSTS=true deliberately." Saving such
 * an endpoint used to work while every call to it failed, so both halves are
 * tested here.
 */
describe('the self-host escape hatch', () => {
  it('dials a loopback endpoint when the operator has opted in', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);

    const result = await withPrivateHosts('true', async () => {
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      return generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 });
    });

    expect(result.text).toBe('pong');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/chat/completions');
    // Transport credential, applied at the HTTP edge and nowhere else.
    expect(seen[0].authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('refuses the same loopback endpoint at call time without the flag', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);

    await withPrivateHosts(undefined, async () => {
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      await expect(generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow(/raw IP address not allowed/);
    });

    // Refused before the socket, not after.
    expect(seen).toEqual([]);
  });

  it('refuses a named loopback host at call time without the flag', async () => {
    await configure('http://localhost:11434/v1');

    await withPrivateHosts(undefined, async () => {
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      await expect(generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow(/localhost not allowed/);
    });
  });

  it('never opts in on anything other than the exact string "true"', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);

    for (const value of ['TRUE', '1', 'yes', '']) {
      process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = value;
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      await expect(generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow(/not allowed/);
    }
    delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
    expect(seen).toEqual([]);
  });
});

/**
 * §2: the key is "never in an error message". The endpoint is workspace-supplied,
 * so its error text is not Trevra's to trust -- and `loop.ts` persists it to
 * `agent_runs.error`, which the API returns and the browser renders.
 */
describe('the endpoint cannot leak the key back through an error', () => {
  it('redacts the key from an error body a debug proxy echoed', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);
    handler = (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'x-echo-auth': req.headers.authorization ?? '' });
      res.end(
        JSON.stringify({
          error: {
            message: `upstream rejected ${req.headers.authorization ?? ''} for ${MODEL_ID}`,
            type: 'invalid_request_error'
          }
        })
      );
    };

    const error = await withPrivateHosts('true', async () => {
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      return generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 }).then(
        () => null,
        (cause: unknown) => cause as Error & { responseBody?: string; responseHeaders?: Record<string, string> }
      );
    });

    if (!error) throw new Error('expected the model call to fail');
    // The endpoint really did echo it; the request left with the key attached.
    expect(seen[0].authorization).toBe(`Bearer ${API_KEY}`);

    // Everything the ledger, the API and pino can reach is clean.
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted:model-api-key]');
    expect(String(error.stack ?? '')).not.toContain(API_KEY);
    expect(String(error.responseBody ?? '')).not.toContain(API_KEY);
    expect(JSON.stringify(error.responseHeaders ?? {})).not.toContain(API_KEY);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(API_KEY);
  });

  it('leaves a successful response untouched', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);

    const result = await withPrivateHosts('true', async () => {
      const resolved = await resolveWorkspaceModel(db, WORKSPACE_ID);
      if (!resolved) throw new Error('expected a resolved model');
      return generateText({ model: resolved.model, prompt: 'ping', maxRetries: 0 });
    });

    expect(result.text).toBe('pong');
  });
});
