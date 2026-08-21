/**
 * ONE INTERFACE, TWO WAYS TO GET A BROWSER: this machine's own Chromium, or a
 * cloud browser attached to over the DevTools protocol.
 *
 * WHY THIS EXISTS. Everything about the LinkedIn worker assumed the browser
 * was HERE -- `launchPersistentContext` at a directory on local disk, a display
 * to draw on, a Chromium binary in the image. That assumption is what made
 * hosted execution impossible: a container has none of the three, so a hosted
 * Trevra could plan an invite and never send one. A cloud browser has all
 * three, somewhere else, and speaks CDP.
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION. Nothing here names Browserbase,
 * browserless or Steel. A remote provider is an endpoint URL, an optional API
 * key and which protocol the endpoint speaks -- which is the whole of what
 * those services (and a `docker run browserless/chrome` on the operator's own
 * VPS) actually differ by. The URL is a TEMPLATE so the per-session facts that
 * every provider takes as query parameters -- the key, and above all the
 * per-seat proxy -- can be placed where that provider wants them.
 *
 * WHAT THE REMOTE PATH CANNOT DO, SAID OUT LOUD. A CDP attach has no
 * user-data-dir: there is no persistent profile, so the seat's signed-in state
 * has to travel as `storageState` (see `linkedin/session-state.ts`). And a
 * context created over CDP cannot be given a proxy -- the proxy belongs to the
 * browser the provider launched, before we ever connected. That is why a seat
 * with no usable proxy is REFUSED here rather than run: a cloud browser's
 * datacentre IP is the single fastest way to get a LinkedIn account
 * restricted, and "we could not honour the proxy" must never resolve to
 * "connect from the provider's shared address". The same fail-closed rule
 * `resolveSeatProxy` already applies to a malformed proxy URL.
 *
 * NOTHING HERE LOGS A SECRET. The API key and the proxy password are
 * substituted into a URL that is never returned, never logged and never put
 * into a refusal sentence; {@link redactEndpoint} is what every message goes
 * through.
 */

/** The cookies-and-origins bundle Playwright round-trips a signed-in session as. */
export interface BrowserStorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

/** One attached DevTools-protocol client, as the LinkedIn worker uses it. */
export interface ProviderCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  detach?(): Promise<void>;
}

/**
 * The slice of a Playwright context this codebase touches.
 *
 * `storageState` is optional because a persistent context on local disk has no
 * need of it and because every test fake in this repository is a hand-written
 * object. Its absence degrades the remote path to "cannot save a session",
 * which is reported; it never throws.
 */
export interface ProviderBrowserContext {
  pages(): unknown[];
  newPage(): Promise<unknown>;
  close(): Promise<void>;
  on(event: 'close', handler: () => void): void;
  storageState?(options?: Record<string, unknown>): Promise<BrowserStorageState>;
  newCDPSession?(page: unknown): Promise<ProviderCdpSession>;
}

/** A connected remote browser, which owns contexts rather than being one. */
export interface ProviderBrowser {
  newContext(options?: Record<string, unknown>): Promise<ProviderBrowserContext>;
  contexts?(): ProviderBrowserContext[];
  close(): Promise<void>;
}

/**
 * The driver, injected.
 *
 * `connectOverCDP` and `connect` are optional so that a driver too old to have
 * them -- or a test fake that implements only what it needs -- is a REFUSAL
 * with a sentence rather than a TypeError three frames deep.
 */
export interface ProviderDriver {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options?: Record<string, unknown>
    ): Promise<ProviderBrowserContext>;
    connectOverCDP?(
      endpointURL: string,
      options?: Record<string, unknown>
    ): Promise<ProviderBrowser>;
    connect?(wsEndpoint: string, options?: Record<string, unknown>): Promise<ProviderBrowser>;
  };
}

export type BrowserProviderKind = 'local' | 'remote';

/** Which protocol the configured endpoint speaks. */
export type RemoteConnectProtocol = 'cdp' | 'playwright';

export interface RemoteBrowserSettings {
  /** Connect URL template; per-session placeholders are resolved by {@link resolveRemoteEndpoint}. */
  endpointTemplate: string;
  apiKey: string | null;
  connect: RemoteConnectProtocol;
  /** Extra headers on the connect handshake. Never logged. */
  headers: Record<string, string>;
  /** What to call this provider in an operator-facing sentence. */
  label: string;
  /** Cloud browsers require a residential proxy; a companion already exits from the member's own network. */
  requireProxy?: boolean;
  /** Cloud sessions round-trip through Postgres; a companion keeps its Chrome profile on the member's disk. */
  sessionPersistence?: 'server' | 'browser';
  /** A companion exposes Chrome's already-running persistent default context. */
  useExistingContext?: boolean;
}

export interface BrowserProviderSettings {
  kind: BrowserProviderKind;
  /** Present exactly when `kind === 'remote'`. */
  remote: RemoteBrowserSettings | null;
  /** Why remote was asked for and is not configured. */
  problem: string | null;
}
export const PROVIDER_ENV = 'TREVRA_BROWSER_PROVIDER';
export const ENDPOINT_ENV = 'TREVRA_BROWSER_CDP_URL';
export const API_KEY_ENV = 'TREVRA_BROWSER_API_KEY';
export const CONNECT_ENV = 'TREVRA_BROWSER_CONNECT';
export const HEADERS_ENV = 'TREVRA_BROWSER_HEADERS';
export const LABEL_ENV = 'TREVRA_BROWSER_LABEL';

/** Schemes a CDP endpoint may use. `ws`/`http` are for a provider on the operator's own network. */
const ENDPOINT_SCHEMES = ['ws:', 'wss:', 'http:', 'https:'];

/**
 * Which browser this deployment drives, read from the environment and nowhere
 * else.
 *
 * NEVER THROWS. A missing or misconfigured external provider reports
 * `kind: 'local'` for compatibility, but that value no longer means "launch a
 * browser here". Server-local Chrome is disabled; callers either attach to a
 * remote/Companion browser or fail closed using `problem`.
 */
export function browserProviderSettings(
  env: NodeJS.ProcessEnv = process.env
): BrowserProviderSettings {
  const selected = (env[PROVIDER_ENV] ?? '').trim().toLowerCase();
  if (selected && selected !== 'local' && selected !== 'remote') {
    return { kind: 'local', remote: null, problem: `${PROVIDER_ENV} must be 'local' or 'remote'.` };
  }
  const endpoint = (env[ENDPOINT_ENV] ?? '').trim();
  // ABSENT OR 'local' MEANS NO EXTERNAL PROVIDER. It does not authorize a
  // server-local launch. An endpoint alone also does not turn remote on: a
  // stale URL must never silently move every seat onto somebody else's IP.
  if (selected !== 'remote') return { kind: 'local', remote: null, problem: null };

  if (!endpoint) {
    return {
      kind: 'local',
      remote: null,
      problem: `${PROVIDER_ENV}=remote needs ${ENDPOINT_ENV}, the cloud browser's CDP endpoint.`
    };
  }
  // Placeholders are not URL syntax, so the template is validated with them
  // blanked out rather than substituted -- a real key must never reach a parser
  // whose error message might quote its input.
  const probe = endpoint.replace(/\{[a-zA-Z]+\}/g, 'x');
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    return {
      kind: 'local',
      remote: null,
      problem: `${ENDPOINT_ENV} is not a URL. Use wss://..., ws://..., https://... or http://...`
    };
  }
  if (!ENDPOINT_SCHEMES.includes(parsed.protocol)) {
    return {
      kind: 'local',
      remote: null,
      problem: `${ENDPOINT_ENV} uses an unsupported scheme '${parsed.protocol.replace(':', '')}'. Use wss, ws, https or http.`
    };
  }

  const connectRaw = (env[CONNECT_ENV] ?? 'cdp').trim().toLowerCase();
  if (connectRaw !== 'cdp' && connectRaw !== 'playwright') {
    return {
      kind: 'local',
      remote: null,
      problem: `${CONNECT_ENV} must be 'cdp' (chromium.connectOverCDP) or 'playwright' (chromium.connect).`
    };
  }

  let headers: Record<string, string> = {};
  const headersRaw = (env[HEADERS_ENV] ?? '').trim();
  if (headersRaw) {
    try {
      const value = JSON.parse(headersRaw) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('not an object');
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item !== 'string') throw new Error('not a string');
        headers[name] = item;
      }
    } catch {
      // The VALUE is never quoted back: this object routinely carries a bearer token.
      return {
        kind: 'local',
        remote: null,
        problem: `${HEADERS_ENV} must be a JSON object of header names to string values.`
      };
    }
  }

  const apiKey = (env[API_KEY_ENV] ?? '').trim() || null;
  // A KEY WITH NOWHERE TO GO. Providers take it as a query parameter
  // (`?apiKey=`, `?token=`) or as a header, and which one is a fact about the
  // provider. Rather than guess, the key goes where the operator put the
  // placeholder -- and when they set a key and named no place for it, the
  // conventional header is used so the common self-hosted case still works.
  if (
    apiKey &&
    !endpoint.includes('{apiKey}') &&
    !Object.keys(headers).some((name) => /^(authorization|x-api-key)$/i.test(name))
  ) {
    headers = { ...headers, 'x-api-key': apiKey };
  }
  return {
    kind: 'remote',
    remote: {
      endpointTemplate: endpoint,
      apiKey,
      connect: connectRaw,
      headers,
      label: (env[LABEL_ENV] ?? '').trim() || parsed.host,
      requireProxy: true,
      sessionPersistence: 'server',
      useExistingContext: false
    },
    problem: null
  };
}

/** True when this deployment has a usable remote browser. */
export function remoteBrowserConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return browserProviderSettings(env).kind === 'remote';
}
export interface ProviderProxy {
  server: string;
  username?: string;
  password?: string;
}

/** Every placeholder that can carry a per-seat proxy into the endpoint. */
const PROXY_PLACEHOLDERS = [
  '{proxyUrl}',
  '{proxyServer}',
  '{proxyUsername}',
  '{proxyPassword}'
] as const;

/** True when the operator's endpoint template has somewhere to put the proxy. */
export function endpointCarriesProxy(template: string): boolean {
  return PROXY_PLACEHOLDERS.some((token) => template.includes(token));
}

/** The proxy as one URL, credentials included. Only ever substituted, never logged. */
function proxyUrl(proxy: ProviderProxy): string {
  const url = new URL(proxy.server);
  if (proxy.username) url.username = encodeURIComponent(proxy.username);
  if (proxy.password) url.password = encodeURIComponent(proxy.password);
  return url.toString().replace(/\/$/, '');
}

/**
 * The endpoint for ONE session, with every placeholder filled.
 *
 * Everything substituted is URL-encoded, because a proxy password with a `&`
 * in it would otherwise silently become a second query parameter -- which is a
 * connection to the provider's own IP wearing a proxy's clothes.
 */
export function resolveRemoteEndpoint(
  settings: RemoteBrowserSettings,
  session: { workspaceId: string; seatKey: string; proxy: ProviderProxy | null }
): string {
  const substitutions: Record<string, string> = {
    '{apiKey}': settings.apiKey ?? '',
    '{workspace}': session.workspaceId,
    '{seat}': session.seatKey,
    '{proxyUrl}': session.proxy ? proxyUrl(session.proxy) : '',
    '{proxyServer}': session.proxy?.server ?? '',
    '{proxyUsername}': session.proxy?.username ?? '',
    '{proxyPassword}': session.proxy?.password ?? ''
  };
  let resolved = settings.endpointTemplate;
  for (const [token, value] of Object.entries(substitutions)) {
    if (!resolved.includes(token)) continue;
    resolved = resolved.split(token).join(encodeURIComponent(value));
  }
  return resolved;
}

/**
 * An endpoint safe to put in a log line or a refusal.
 *
 * Scheme, host and path only. Every query parameter is dropped rather than
 * filtered by name, because the parameter a given provider carries its key in
 * is a fact about that provider and an allowlist would be a guess -- and a
 * wrong guess prints a credential.
 */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint.replace(/\{[a-zA-Z]+\}/g, 'x'));
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return 'the configured endpoint';
  }
}

/** Everything one seat's browser needs, whichever provider opens it. */
export interface SeatBrowserRequest {
  workspaceId: string;
  seatKey: string;
  headless: boolean;
  /** Legacy/local compatibility field. External providers ignore this path. */
  profileDir: string;
  fingerprint: {
    userAgent: string;
    locale: string;
    timezoneId: string;
    viewport: { width: number; height: number };
  };
  /** Null means "this seat has no proxy configured", which the remote provider refuses. */
  proxy: ProviderProxy | null;
  /** Remote only: the seat's signed-in state, restored into the fresh context. */
  storageState: BrowserStorageState | null;
  /** Legacy local-launch fields retained for request-shape compatibility; external providers ignore them. */
  args: string[];
  ignoreDefaultArgs: string[];
  channels: readonly string[];
}

export interface SeatBrowserSession {
  kind: BrowserProviderKind;
  context: ProviderBrowserContext;
  page: unknown;
  /**
   * Read the signed-in state back out, or null when there is nothing to read.
   *
   * NULL FOR LOCAL, ALWAYS: the persistent profile directory IS the session,
   * so writing a copy of it into Postgres would be a second source of truth
   * for the one fact that must not have two. Non-null for remote, where the
   * database is the only place the session can live.
   */
  exportStorageState: null | (() => Promise<BrowserStorageState | null>);
  /** Which channel a local launch landed on, for the one-line log. Null for remote. */
  channel: string | null;
  close(): Promise<void>;
}

export type OpenSeatBrowserResult = { session: SeatBrowserSession } | { refused: string };

/**
 * The refusal a seat with no proxy gets in remote mode, as a function so the
 * provider label is in it.
 *
 * THIS IS THE MOST IMPORTANT SENTENCE IN THE FILE. Running a LinkedIn account
 * from a cloud browser's shared datacentre address, from a different country,
 * with a different ASN every session, is the fastest way to have that account
 * restricted -- and it would happen silently, because a browser that connects
 * is a browser that appears to work. So there is no fallback: the seat waits.
 */
export function noProxyRefusal(label: string, seatKey: string): string {
  return (
    `Seat '${seatKey}' has no proxy configured, so it will not be run on ${label}. ` +
    'A cloud browser exits from a shared datacentre address that changes between sessions, and a LinkedIn account seen from one is restricted quickly. ' +
    'Give this seat a residential proxy (TREVRA_LINKEDIN_PROXIES, keyed "<workspace>/<seat>"), or run it from a machine with `npm run linkedin:worker`.'
  );
}

/**
 * Open one seat's browser, wherever this deployment's browsers live.
 *
 * NEVER THROWS. Every failure is `{ refused }` with one operator-facing
 * sentence, because both callers are loops that must survive a browser that
 * will not open -- the same contract `openPersistentBrowser` has always had.
 *
 * NOTHING IS LEFT OPEN ON A FAILURE PATH. A context that was created and then
 * could not be prepared is closed before the refusal is returned; a connected
 * remote browser is closed with it. A leaked remote session is a leaked bill
 * as well as a leaked handle.
 */
export async function openSeatBrowser(
  driver: ProviderDriver,
  settings: BrowserProviderSettings,
  request: SeatBrowserRequest,
  log: (message: string) => void = () => {}
): Promise<OpenSeatBrowserResult> {
  if (settings.kind === 'remote') {
    if (!settings.remote) {
      return {
        refused:
          settings.problem ?? 'This deployment selected a remote browser and has none configured.'
      };
    }
    return openRemoteSeatBrowser(driver, settings.remote, request, log);
  }
  if (settings.problem) return { refused: settings.problem };
  return {
    refused:
      'Server-local browser launches are disabled. Pair a Companion device or configure a remote browser provider.'
  };
}

/**
 * The path this codebase has always taken: a persistent Chrome profile on this
 * machine's own disk, launched on the best channel this machine has.
 *
 * A missing channel throws at launch -- there is no way to ask Playwright
 * whether Google Chrome is installed without trying it -- so the fallback IS
 * the probe, and the last channel's failure is what gets reported.
 */
async function openLocalSeatBrowser(
  driver: ProviderDriver,
  request: SeatBrowserRequest,
  log: (message: string) => void
): Promise<OpenSeatBrowserResult> {
  const options = (channel: string): Record<string, unknown> => ({
    headless: request.headless,
    channel,
    ignoreDefaultArgs: request.ignoreDefaultArgs,
    ...(request.headless ? { viewport: request.fingerprint.viewport } : { viewport: null }),
    userAgent: request.fingerprint.userAgent,
    locale: request.fingerprint.locale,
    timezoneId: request.fingerprint.timezoneId,
    ...(request.proxy ? { proxy: request.proxy } : {}),
    args: request.args
  });

  let context: ProviderBrowserContext | null = null;
  let channel: string | null = null;
  let last: unknown;
  for (const candidate of request.channels) {
    try {
      context = await driver.chromium.launchPersistentContext(
        request.profileDir,
        options(candidate)
      );
      channel = candidate;
      break;
    } catch (cause) {
      last = cause;
    }
  }
  if (!context) {
    return {
      refused: `Could not open the browser profile at ${request.profileDir}${request.proxy ? ` through ${request.proxy.server}` : ''}: ${describe(last)}.`
    };
  }

  try {
    const existing = context.pages()[0];
    const page = existing ?? (await context.newPage());
    return {
      session: {
        kind: 'local',
        context,
        page,
        exportStorageState: null,
        channel,
        close: async () => {
          await context.close();
        }
      }
    };
  } catch (cause) {
    await closeQuietly(context);
    return {
      refused: `Opened and then closed the browser profile at ${request.profileDir}: it could not be prepared for use (${describe(cause)}).`
    };
  }
}

/**
 * Attach to a cloud browser and give this seat its own context inside it.
 *
 * THE PROXY GATE IS FIRST, BEFORE A SOCKET IS OPENED. See
 * {@link noProxyRefusal}: there is no version of this that falls back to the
 * provider's own address.
 *
 * THE SECOND GATE IS WHETHER THE PROXY CAN ACTUALLY BE DELIVERED, and it is
 * the one that is easy to get wrong. A context created over a raw CDP attach
 * cannot be given a proxy: the browser was launched by the provider before we
 * connected, so its exit IP is already decided. The only way to influence it
 * is at session-creation time, which for every provider means the connect URL
 * -- hence the `{proxy...}` placeholders. A configuration that names a proxy
 * with no way to deliver it is REFUSED, not run: silently connecting anyway is
 * exactly the outcome the whole gate exists to prevent.
 *
 * `chromium.connect` (the Playwright server protocol) is different: the remote launches per connection and may accept a context proxy.
 */
async function openRemoteSeatBrowser(
  driver: ProviderDriver,
  remote: RemoteBrowserSettings,
  request: SeatBrowserRequest,
  log: (message: string) => void
): Promise<OpenSeatBrowserResult> {
  const requireProxy = remote.requireProxy !== false;
  if (requireProxy && !request.proxy)
    return { refused: noProxyRefusal(remote.label, request.seatKey) };

  const proxyTravelsInUrl = endpointCarriesProxy(remote.endpointTemplate);
  if (requireProxy && remote.connect === 'cdp' && !proxyTravelsInUrl) {
    return {
      refused:
        `Seat '${request.seatKey}' has a proxy and ${remote.label} was given no way to use it, so it will not be run. ` +
        `A context attached over CDP cannot be given a proxy -- the browser was already launched by the provider -- so ${ENDPOINT_ENV} must carry it: ` +
        'add {proxyUrl} (or {proxyServer}/{proxyUsername}/{proxyPassword}) to the endpoint where this provider expects the proxy, ' +
        `or set ${CONNECT_ENV}=playwright if the endpoint speaks the Playwright server protocol.`
    };
  }

  const connect =
    remote.connect === 'cdp' ? driver.chromium.connectOverCDP : driver.chromium.connect;
  if (typeof connect !== 'function') {
    return {
      refused:
        `The installed browser driver has no chromium.${remote.connect === 'cdp' ? 'connectOverCDP' : 'connect'}, so this deployment cannot attach to ${remote.label}. ` +
        'Install a current playwright (or patchright) in the image that runs the worker.'
    };
  }

  const endpoint = resolveRemoteEndpoint(remote, {
    workspaceId: request.workspaceId,
    seatKey: request.seatKey,
    proxy: request.proxy
  });

  let browser: ProviderBrowser;
  try {
    browser = await connect.call(driver.chromium, endpoint, {
      ...(Object.keys(remote.headers).length > 0 ? { headers: remote.headers } : {}),
      timeout: 60_000
    });
  } catch (cause) {
    return {
      refused: `Could not attach to ${remote.label} at ${redactEndpoint(remote.endpointTemplate)}: ${describe(cause)}.`
    };
  }

  try {
    // A companion launches Chrome with a persistent user-data-dir. Its default
    // CDP context is therefore the session and remains local to that computer.
    // A cloud provider starts empty and gets a new context restored from the
    // server-side encrypted storage state.
    const existingContext = remote.useExistingContext ? (browser.contexts?.()[0] ?? null) : null;
    const context =
      existingContext ??
      (await browser.newContext({
        viewport: request.fingerprint.viewport,
        userAgent: request.fingerprint.userAgent,
        locale: request.fingerprint.locale,
        timezoneId: request.fingerprint.timezoneId,
        ...(remote.connect === 'playwright' && request.proxy ? { proxy: request.proxy } : {}),
        ...(request.storageState && remote.sessionPersistence !== 'browser'
          ? { storageState: request.storageState }
          : {})
      }));
    const page = context.pages()[0] ?? (await context.newPage());
    log(
      `Browser session is remote: attached to ${remote.label} at ${redactEndpoint(remote.endpointTemplate)}` +
        (remote.sessionPersistence === 'browser'
          ? ' and is using the persistent session on that computer.'
          : `${request.storageState ? " and restored this seat's stored session" : ' with no stored session, so it must sign in'}.`)
    );
    return {
      session: {
        kind: 'remote',
        context,
        page,
        exportStorageState:
          remote.sessionPersistence === 'browser'
            ? null
            : async () => {
                if (typeof context.storageState !== 'function') return null;
                return context.storageState();
              },
        channel: null,
        close: async () => {
          if (!remote.useExistingContext) await closeQuietly(context);
          await browser.close();
        }
      }
    };
  } catch (cause) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
    return {
      refused: `Attached to ${remote.label} but could not prepare a context for seat '${request.seatKey}': ${describe(cause)}.`
    };
  }
}

async function closeQuietly(context: ProviderBrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // A context we cannot close is not a reason to fail the caller.
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
