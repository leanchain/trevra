import { describe, expect, it } from 'vitest';
import {
  browserProviderSettings,
  endpointCarriesProxy,
  noProxyRefusal,
  openSeatBrowser,
  redactEndpoint,
  remoteBrowserConfigured,
  resolveRemoteEndpoint,
  type BrowserStorageState,
  type ProviderBrowserContext,
  type ProviderDriver
} from './provider.js';

/**
 * WHICH BROWSER, AND WHEN IT REFUSES TO BE ONE AT ALL.
 *
 * Two properties are load-bearing here and neither can be checked by reading
 * the code once:
 *
 *   1. REMOTE IS NEVER REACHED BY ACCIDENT. A stale endpoint variable, a typo
 *      in the provider name, a malformed URL -- none of them may quietly move
 *      a seat onto somebody else's IP, and none of them may quietly fall back
 *      to a local browser a hosted container does not have.
 *   2. A SEAT WITH NO USABLE PROXY IS NOT RUN. Not degraded, not warned about
 *      -- not run. A cloud browser's shared datacentre address is the fastest
 *      way to have a LinkedIn account restricted, and it would happen silently
 *      because a browser that connects looks like a browser that works.
 */

const FINGERPRINT = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0',
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  viewport: { width: 1440, height: 900 }
};

function request(overrides: Partial<Parameters<typeof openSeatBrowser>[2]> = {}): Parameters<typeof openSeatBrowser>[2] {
  return {
    workspaceId: 'ws_a',
    seatKey: 'sales',
    headless: true,
    profileDir: '/tmp/trevra-profile',
    fingerprint: FINGERPRINT,
    proxy: null,
    storageState: null,
    args: [],
    ignoreDefaultArgs: [],
    channels: ['chrome', 'chromium'],
    ...overrides
  };
}

/** A context that records what it was built with and opens no browser at all. */
function fakeContext(seen: { contextOptions?: Record<string, unknown> }): ProviderBrowserContext {
  return {
    pages: () => [],
    newPage: async () => ({ url: () => 'about:blank' }),
    close: async () => {},
    on: () => {},
    storageState: async (): Promise<BrowserStorageState> => ({ cookies: [{ name: 'li_at', value: 'x' }], origins: [] })
  };
}

function fakeRemoteDriver(seen: {
  endpoint?: string;
  connectOptions?: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
  via?: string;
}): ProviderDriver {
  const browser = {
    newContext: async (options?: Record<string, unknown>) => {
      seen.contextOptions = options ?? {};
      return fakeContext(seen);
    },
    contexts: () => [],
    close: async () => {}
  };
  return {
    chromium: {
      launchPersistentContext: async () => {
        throw new Error('a remote provider must never launch a local browser');
      },
      connectOverCDP: async (endpoint: string, options?: Record<string, unknown>) => {
        seen.via = 'cdp';
        seen.endpoint = endpoint;
        seen.connectOptions = options ?? {};
        return browser;
      },
      connect: async (endpoint: string, options?: Record<string, unknown>) => {
        seen.via = 'playwright';
        seen.endpoint = endpoint;
        seen.connectOptions = options ?? {};
        return browser;
      }
    }
  };
}

describe('choosing a browser provider', () => {
  it('is local when nothing is configured', () => {
    const settings = browserProviderSettings({});
    expect(settings.kind).toBe('local');
    expect(settings.remote).toBeNull();
    expect(settings.problem).toBeNull();
    expect(remoteBrowserConfigured({})).toBe(false);
  });

  it('does NOT go remote just because an endpoint is lying around', () => {
    // The dangerous accident: a stale variable in a .env silently moving every
    // seat onto a datacentre IP. Selecting remote has to be an explicit act.
    const settings = browserProviderSettings({ TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com?apiKey={apiKey}' });
    expect(settings.kind).toBe('local');
    expect(settings.problem).toBeNull();
  });

  it('is remote when selected with an endpoint, and reports the provider by host', () => {
    const settings = browserProviderSettings({
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}'
    });
    expect(settings.kind).toBe('remote');
    expect(settings.remote?.connect).toBe('cdp');
    expect(settings.remote?.label).toBe('connect.example.com');
    expect(remoteBrowserConfigured({
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/'
    })).toBe(true);
  });

  it('refuses to fall back to local when remote was asked for and is broken', () => {
    // Every one of these must land on `problem`, because a hosted container
    // that quietly reverts to a local browser it does not have is a queue that
    // fills up forever with no error anywhere.
    for (const env of [
      { TREVRA_BROWSER_PROVIDER: 'remote' },
      { TREVRA_BROWSER_PROVIDER: 'remote', TREVRA_BROWSER_CDP_URL: 'not a url' },
      { TREVRA_BROWSER_PROVIDER: 'remote', TREVRA_BROWSER_CDP_URL: 'ftp://elsewhere/' },
      { TREVRA_BROWSER_PROVIDER: 'remote', TREVRA_BROWSER_CDP_URL: 'wss://x/', TREVRA_BROWSER_CONNECT: 'grpc' },
      { TREVRA_BROWSER_PROVIDER: 'remote', TREVRA_BROWSER_CDP_URL: 'wss://x/', TREVRA_BROWSER_HEADERS: '{not json' },
      { TREVRA_BROWSER_PROVIDER: 'sideways' }
    ]) {
      const settings = browserProviderSettings(env);
      expect(settings.kind, JSON.stringify(env)).toBe('local');
      expect(settings.problem, JSON.stringify(env)).toBeTruthy();
    }
  });

  it('never puts the API key or a header value into the problem sentence', () => {
    const settings = browserProviderSettings({
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://x/',
      TREVRA_BROWSER_HEADERS: '{"Authorization": "Bearer sk-canary-9f3"',
      TREVRA_BROWSER_API_KEY: 'sk-canary-9f3'
    });
    expect(settings.problem).toBeTruthy();
    expect(settings.problem).not.toContain('sk-canary-9f3');
  });

  it('carries the key where the operator put the placeholder, and headers it otherwise', () => {
    const withPlaceholder = browserProviderSettings({
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}',
      TREVRA_BROWSER_API_KEY: 'sk-canary-9f3'
    });
    expect(withPlaceholder.remote?.headers).toEqual({});

    const withoutPlaceholder = browserProviderSettings({
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://chrome.internal:3000/',
      TREVRA_BROWSER_API_KEY: 'sk-canary-9f3'
    });
    expect(withoutPlaceholder.remote?.headers['x-api-key']).toBe('sk-canary-9f3');
  });

  it('redacts the query string, where every provider keeps its key', () => {
    const redacted = redactEndpoint('wss://connect.example.com/session?apiKey=sk-canary-9f3&proxy=http%3A%2F%2Fu%3Ap%40h%3A1');
    expect(redacted).toBe('wss://connect.example.com/session');
    expect(redacted).not.toContain('sk-canary-9f3');
  });
});

describe('a remote seat with no usable proxy', () => {
  const remoteEnv = {
    TREVRA_BROWSER_PROVIDER: 'remote',
    TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
    TREVRA_BROWSER_API_KEY: 'sk-canary-9f3'
  };

  it('is refused rather than run on the provider\'s own address', async () => {
    const seen: Record<string, unknown> = {};
    const result = await openSeatBrowser(
      fakeRemoteDriver(seen),
      browserProviderSettings(remoteEnv),
      request({ proxy: null })
    );
    expect('refused' in result).toBe(true);
    if (!('refused' in result)) throw new Error('unreachable');
    expect(result.refused).toBe(noProxyRefusal('connect.example.com', 'sales'));
    // The decisive assertion: nothing was attached to. A refusal that still
    // opened a session would have already leaked the IP it exists to protect.
    expect(seen.endpoint).toBeUndefined();
  });

  it('is refused when the proxy exists and the endpoint has nowhere to put it', async () => {
    const seen: Record<string, unknown> = {};
    const result = await openSeatBrowser(
      fakeRemoteDriver(seen),
      browserProviderSettings({ ...remoteEnv, TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}' }),
      request({ proxy: { server: 'http://res.example.net:8000', username: 'u', password: 'canary-proxy-pw' } })
    );
    expect('refused' in result).toBe(true);
    if (!('refused' in result)) throw new Error('unreachable');
    expect(result.refused).toContain('{proxyUrl}');
    expect(result.refused).not.toContain('canary-proxy-pw');
    expect(seen.endpoint).toBeUndefined();
  });

  it('runs when the endpoint carries the proxy, and encodes it', async () => {
    const seen: Record<string, unknown> = {};
    const result = await openSeatBrowser(
      fakeRemoteDriver(seen),
      browserProviderSettings(remoteEnv),
      request({ proxy: { server: 'http://res.example.net:8000', username: 'u', password: 'p&w' }, storageState: { cookies: [{ name: 'li_at', value: 'x' }], origins: [] } })
    );
    expect('session' in result).toBe(true);
    expect(seen.via).toBe('cdp');
    // A password with an `&` must not become a second query parameter -- that
    // is a connection to the provider's own IP wearing a proxy's clothes.
    expect(String(seen.endpoint)).not.toContain('p&w');
    expect(String(seen.endpoint)).toContain('apiKey=sk-canary-9f3');
    expect((seen.contextOptions as Record<string, unknown>).storageState).toEqual({ cookies: [{ name: 'li_at', value: 'x' }], origins: [] });
    // Over CDP the proxy travels in the URL and is NOT passed to newContext,
    // where it would be silently ignored.
    expect((seen.contextOptions as Record<string, unknown>).proxy).toBeUndefined();
  });

  it('passes the proxy to newContext on the Playwright protocol, where it is honoured', async () => {
    const seen: Record<string, unknown> = {};
    const proxy = { server: 'http://res.example.net:8000', username: 'u', password: 'p' };
    const result = await openSeatBrowser(
      fakeRemoteDriver(seen),
      browserProviderSettings({
        TREVRA_BROWSER_PROVIDER: 'remote',
        TREVRA_BROWSER_CDP_URL: 'wss://chrome.internal:3000/playwright',
        TREVRA_BROWSER_CONNECT: 'playwright'
      }),
      request({ proxy })
    );
    expect('session' in result).toBe(true);
    expect(seen.via).toBe('playwright');
    expect((seen.contextOptions as Record<string, unknown>).proxy).toEqual(proxy);
  });

  it('refuses when the installed driver cannot connect at all', async () => {
    const result = await openSeatBrowser(
      { chromium: { launchPersistentContext: async () => { throw new Error('no'); } } },
      browserProviderSettings(remoteEnv),
      request({ proxy: { server: 'http://res.example.net:8000' } })
    );
    expect('refused' in result).toBe(true);
    if (!('refused' in result)) throw new Error('unreachable');
    expect(result.refused).toContain('connectOverCDP');
  });

  it('answers the proxy-placeholder question the same way the refusal does', () => {
    expect(endpointCarriesProxy('wss://x/?p={proxyUrl}')).toBe(true);
    expect(endpointCarriesProxy('wss://x/?s={proxyServer}&u={proxyUsername}')).toBe(true);
    expect(endpointCarriesProxy('wss://x/?apiKey={apiKey}')).toBe(false);
  });

  it('substitutes the seat and workspace for providers that key sessions on them', () => {
    const resolved = resolveRemoteEndpoint(
      { endpointTemplate: 'wss://x/?s={seat}&w={workspace}', apiKey: null, connect: 'cdp', headers: {}, label: 'x' },
      { workspaceId: 'ws a', seatKey: 'sales/eu', proxy: null }
    );
    expect(resolved).toBe('wss://x/?s=sales%2Feu&w=ws%20a');
  });
});

describe('the local provider', () => {
  it('launches a persistent context with the seat\'s own identity and proxy', async () => {
    let seenDir = '';
    let seenOptions: Record<string, unknown> = {};
    const driver: ProviderDriver = {
      chromium: {
        launchPersistentContext: async (dir, options) => {
          seenDir = dir;
          seenOptions = options ?? {};
          return fakeContext({});
        }
      }
    };
    const proxy = { server: 'http://res.example.net:8000' };
    const result = await openSeatBrowser(driver, browserProviderSettings({}), request({ proxy }));
    expect('session' in result).toBe(true);
    if (!('session' in result)) throw new Error('unreachable');
    expect(result.session.kind).toBe('local');
    // NULL, and this is the property that keeps the local session single-homed:
    // its profile directory is the session, and a copy in Postgres would be a
    // second source of truth for the one fact that must not have two.
    expect(result.session.exportStorageState).toBeNull();
    expect(seenDir).toBe('/tmp/trevra-profile');
    expect(seenOptions.userAgent).toBe(FINGERPRINT.userAgent);
    expect(seenOptions.timezoneId).toBe('Europe/London');
    expect(seenOptions.proxy).toEqual(proxy);
  });

  it('reports the last channel\'s failure rather than launching nothing quietly', async () => {
    const driver: ProviderDriver = {
      chromium: {
        launchPersistentContext: async () => {
          throw new Error('Executable doesn\'t exist');
        }
      }
    };
    const result = await openSeatBrowser(driver, browserProviderSettings({}), request());
    expect('refused' in result).toBe(true);
    if (!('refused' in result)) throw new Error('unreachable');
    expect(result.refused).toContain('/tmp/trevra-profile');
    expect(result.refused).toContain('Executable doesn\'t exist');
  });
});
