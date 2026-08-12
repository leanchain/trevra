/**
 * The BYOK model provider: workspace configuration in, a language model out.
 *
 * This is the ONLY place a stored model key is decrypted, and the key exists
 * here for the length of one function call. byok-and-hosted-agent.md §3, access
 * rule 4: "It is applied as an HTTP header at the edge of the model call and
 * never crosses back into application state."
 *
 * Concretely, and non-negotiably: the key is not returned by
 * `resolveWorkspaceModel`, not stored on the object it returns, not logged, not
 * put in an error message, and never placed in a system prompt, a message, a
 * tool input, a tool output, a run step, or a run summary. `createOpenAICompatible`
 * closes over it and turns it into an `Authorization` header; nothing else in
 * Trevra ever sees it. §2 spells out why this matters more than it looks: the
 * hosted agent reads Reddit threads, GitHub issues and scraped pages, so the
 * model's context is attacker-influenced by design. A key that is never in that
 * context cannot be talked out of it.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Db } from '../db.js';
import {
  describeWorkspaceSecret,
  getWorkspaceAgentConfig,
  readWorkspaceSecretPlaintext
} from '../secrets/store.js';
import { createSsrfFetch } from '../skills/guard.js';

export interface ResolvedWorkspaceModel {
  model: LanguageModel;
  modelId: string;
  baseUrl: string;
}

/**
 * The provider name the SDK reports on every step. Deliberately fixed rather
 * than taken from the workspace's label: the label is user-supplied text and
 * this value ends up in step metadata and telemetry.
 */
const PROVIDER_NAME = 'byok';

/**
 * The self-host escape hatch, read here exactly as `secrets/store.ts` reads it
 * at write time. Both halves must agree: the store lets an operator SAVE a
 * private endpoint under this flag, and this module is what lets the model call
 * actually reach it. Anything less and the documented Ollama / vLLM / LiteLLM
 * path saves fine and then fails on every call.
 */
const PRIVATE_HOSTS_ENV = 'TREVRA_ALLOW_PRIVATE_MODEL_HOSTS';

/** What replaces the key in any text on its way back out. */
const KEY_REDACTION = '[redacted:model-api-key]';

function privateModelHostsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PRIVATE_HOSTS_ENV] === 'true';
}

/**
 * Build the workspace's model, or `null` when BYOK is not set up.
 *
 * `null` is not an error: a workspace with no endpoint or no key has simply not
 * opted in, which is the documented default (§7 -- "the BYO-agent path stays
 * available and stores no key at all. That is the default, and it should stay
 * the default"). Callers that need to tell a founder what is missing should ask
 * {@link describeMissingWorkspaceModel}.
 */
export async function resolveWorkspaceModel(db: Db, workspaceId: string): Promise<ResolvedWorkspaceModel | null> {
  const config = await getWorkspaceAgentConfig(db, workspaceId);
  if (!config) return null;

  const apiKey = await readWorkspaceSecretPlaintext(db, workspaceId, 'model_api_key');
  if (!apiKey) return null;

  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: config.baseUrl,
    // Transport credential only. It goes into an Authorization header inside the
    // provider and is never read back out -- see the module comment.
    apiKey,
    // REQUIRED, not an optimisation. `baseUrl` is workspace-supplied and this
    // server dials it, so it is an SSRF primitive. The write-time check in
    // secrets/store.ts is STRUCTURAL only (`resolve: false`) -- it cannot see a
    // public hostname whose DNS answer is 169.254.169.254. This call-time hook
    // resolves and revalidates the host on every request and every redirect hop,
    // which is the layer that actually defeats that attack. It also scrubs the
    // key out of whatever the endpoint says back.
    fetch: modelFetch(apiKey)
  });

  return { model: provider(config.model), modelId: config.model, baseUrl: config.baseUrl };
}

/**
 * Why {@link resolveWorkspaceModel} returned `null`, in words a founder can act
 * on. Reads the secret's SUMMARY (last4, label) only -- never the plaintext.
 */
export async function describeMissingWorkspaceModel(db: Db, workspaceId: string): Promise<string> {
  const [config, secret] = await Promise.all([
    getWorkspaceAgentConfig(db, workspaceId),
    describeWorkspaceSecret(db, workspaceId, 'model_api_key')
  ]);

  const missing: string[] = [];
  if (!config) missing.push('a model endpoint', 'a model name');
  if (!secret) missing.push('a model API key');
  if (missing.length === 0) return 'The hosted agent is set up.';

  return `The hosted agent is not set up: add ${formatList(missing)} in Setup.`;
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The transport for one model call: the SSRF guard, wrapped in a redaction
 * layer so nothing carrying the key can travel back into application state.
 * Built per call because both layers close over per-call state -- the guard's
 * resolution cache, and the key itself.
 */
function modelFetch(apiKey: string): typeof globalThis.fetch {
  return redactKey(guardedFetch(privateModelHostsAllowed()), apiKey);
}

/**
 * `createSsrfFetch` speaks `(url: string, init?)`; the SDK's `FetchFunction` is
 * the platform `fetch` signature. This adapter is the only difference between
 * them.
 *
 * `allowPrivateHosts` is the operator's `TREVRA_ALLOW_PRIVATE_MODEL_HOSTS`
 * opt-in and nothing else. It is false unless that variable is exactly `'true'`,
 * so the default deployment -- the one where a private address means someone
 * else's metadata service -- is unchanged, and no other `createSsrfFetch()`
 * caller passes it at all.
 */
function guardedFetch(allowPrivateHosts: boolean): typeof globalThis.fetch {
  const ssrfFetch = createSsrfFetch({ allowPrivateHosts });

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string') return ssrfFetch(input, init);
    if (input instanceof URL) return ssrfFetch(input.toString(), init);
    // The SDK always calls with a URL string. A `Request` would arrive only from
    // a custom middleware, so unpack it rather than silently dropping its body.
    const request = input as Request;
    return ssrfFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      duplex: 'half',
      ...init
    } as RequestInit);
  }) as typeof globalThis.fetch;
}

/**
 * Replace the key with {@link KEY_REDACTION} in anything the endpoint sends
 * back, before the SDK can turn it into an error.
 *
 * `baseUrl` is workspace-supplied, so the thing on the other end is not
 * trusted to be well behaved: a debug proxy or a sloppy OpenAI-compatible shim
 * that echoes the request it received puts `Authorization: Bearer <key>` into
 * its own 4xx body. That text becomes `APICallError.message`, which `loop.ts`
 * persists to `agent_runs.error`, which `GET /api/agent-runs/:id` returns, which
 * the browser renders -- and pino's redact list does not cover `err.message`.
 * §2 says the key is "never in an error message"; on text Trevra did not write,
 * this is the only place that can enforce it, because this module is the only
 * one holding the plaintext. `loop.ts` structurally cannot: by design it never
 * sees the key.
 *
 * DEFENCE IN DEPTH, NOT A LICENCE. This is the last net, not a reason to relax
 * anything upstream of it -- the key still never enters a prompt, a tool input,
 * a step, a summary or a log, and this wrapper is not evidence that it could.
 * It only catches a leak Trevra does not author and cannot prevent at source.
 *
 * A 2xx IS BUFFERED TOO, and that is not paranoia. An endpoint answering 200
 * with a body that is not the JSON the SDK expects produces a parse error whose
 * properties carry that body -- so a hostile endpoint echoing the Authorization
 * header back inside a successful response reached the error object with the
 * key intact, while `message` and `stack` looked clean. Buffering only failures
 * left the one shape an attacker controls entirely.
 */
function redactKey(inner: typeof globalThis.fetch, apiKey: string): typeof globalThis.fetch {
  const redact = (text: string): string => (text.includes(apiKey) ? text.split(apiKey).join(KEY_REDACTION) : text);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (cause) {
      throw redactErrorChain(cause, redact);
    }

    const body = await response.text().catch(() => '');
    const headers = new Headers();
    response.headers.forEach((value, name) => {
      // The body has been decoded and is about to be re-measured; carrying the
      // original framing headers over would describe the wrong bytes.
      if (name === 'content-encoding' || name === 'content-length') return;
      headers.set(name, redact(value));
    });
    return new Response(redact(body), { status: response.status, statusText: redact(response.statusText), headers });
  }) as typeof globalThis.fetch;
}

/**
 * Redact in place, down the `cause` chain.
 *
 * `message` and `stack` are not enough. The SDK's own error types hang the raw
 * exchange off extra properties -- `responseBody`, `text`, `url`, `requestBodyValues`
 * -- and pino's standard error serializer emits every own enumerable property,
 * so scrubbing only the two visible ones left the key one `log.error(err)` away
 * from the application log. Everything own and enumerable gets walked instead,
 * which is the surface anything downstream can actually reach.
 */
function redactErrorChain(error: unknown, redact: (text: string) => string): unknown {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    try {
      current.message = redact(current.message);
      if (typeof current.stack === 'string') current.stack = redact(current.stack);
      redactOwnProperties(current, redact, seen);
    } catch {
      // A frozen error cannot be scrubbed. Nothing further to do here, and
      // throwing instead would replace a leak with an outage.
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

/**
 * Walk own enumerable properties, redacting strings and recursing into plain
 * objects and arrays. Bounded by `seen`, so a cycle cannot spin. `cause` is
 * skipped because the caller's loop already follows it.
 */
function redactOwnProperties(target: object, redact: (text: string) => string, seen: Set<unknown>): void {
  for (const key of Object.keys(target)) {
    if (key === 'cause' || key === 'stack' || key === 'message') continue;
    const value = (target as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      try {
        (target as Record<string, unknown>)[key] = redact(value);
      } catch {
        // A read-only property. Skip it rather than fail the request.
      }
      continue;
    }
    if (typeof value === 'object' && value !== null && !seen.has(value)) {
      seen.add(value);
      redactOwnProperties(value, redact, seen);
    }
  }
}
