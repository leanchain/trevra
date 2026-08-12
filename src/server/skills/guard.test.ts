import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
  default: { lookup: lookupMock }
}));

const { SsrfError, createSsrfFetch, isBlockedAddress, validatePublicHost } = await import('./guard.js');

beforeEach(() => {
  lookupMock.mockReset();
});

// Ported from the Python reference tests/test_netguard.py.
describe('validatePublicHost structural checks', () => {
  // resolve: false -> no DNS; every case must be caught structurally.
  const rejected: Array<[string, string]> = [
    ['', 'empty host'],
    ['   ', 'empty host'],
    ['.', 'empty host'],
    ['[::1]', 'bracketed IP literal'],
    ['[fe80::1]:8080', 'bracketed IP literal'],
    ['127.0.0.1:8123', 'explicit port'],
    ['example.com:8080', 'explicit port'],
    ['db:5432', 'explicit port'],
    ['169.254.169.254', 'raw IP address'],
    ['10.0.0.5', 'raw IP address'],
    ['::1', 'raw IP address'],
    ['fe80::1', 'raw IP address'],
    ['localhost', 'localhost not allowed'],
    ['api.localhost', 'localhost not allowed'],
    ['printer.local', 'mDNS .local host not allowed'],
    ['db', 'single-label host']
  ];

  for (const [host, reason] of rejected) {
    it(`rejects ${JSON.stringify(host)} (${reason})`, async () => {
      await expect(validatePublicHost(host, { resolve: false })).rejects.toThrow(SsrfError);
      await expect(validatePublicHost(host, { resolve: false })).rejects.toThrow(reason);
    });
  }

  it('accepts a normal FQDN without touching DNS', async () => {
    await expect(validatePublicHost('example.com', { resolve: false })).resolves.toBeUndefined();
    await expect(validatePublicHost('shop.example.co.uk', { resolve: false })).resolves.toBeUndefined();
    await expect(validatePublicHost('Example.COM.', { resolve: false })).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('is an Error subclass so callers can catch it generically', () => {
    expect(new SsrfError('x')).toBeInstanceOf(Error);
  });
});

describe('validatePublicHost resolution', () => {
  it('accepts a host that resolves to public addresses only', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
    await expect(validatePublicHost('example.com')).resolves.toBeUndefined();
  });

  it('rejects a host that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(validatePublicHost('internal.example.com')).rejects.toThrow('resolves to non-public address 10.0.0.5');
  });

  it('rejects when only one of several answers is non-public', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: 'fe80::1', family: 6 }]);
    await expect(validatePublicHost('mixed.example.com')).rejects.toThrow('resolves to non-public address fe80::1');
  });

  it('rejects the IPv4-mapped form of a loopback address', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(validatePublicHost('mapped.example.com')).rejects.toThrow('non-public address');
  });

  it('rejects when the host does not resolve at all', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(validatePublicHost('nope.example.com')).rejects.toThrow('could not resolve host');
    lookupMock.mockResolvedValue([]);
    await expect(validatePublicHost('empty.example.com')).rejects.toThrow('did not resolve to any address');
  });
});

describe('isBlockedAddress', () => {
  it('blocks every non-public class', () => {
    for (const address of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
      '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', 'not-an-ip'
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows public unicast addresses', () => {
    for (const address of ['1.1.1.1', '93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('ignores an IPv6 zone index', () => {
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
  });
});

describe('createSsrfFetch', () => {
  it('blocks a redirect to an internal address before it is contacted', async () => {
    const reached: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).hostname === 'public.test') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/latest/meta-data' } });
      }
      reached.push(url);
      return new Response('internal', { status: 200 });
    });

    const guarded = createSsrfFetch({ resolve: false, fetchImpl });
    await expect(guarded('https://public.test/')).rejects.toThrow(SsrfError);
    expect(reached).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never lets the underlying fetch follow redirects itself', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 }));
    const guarded = createSsrfFetch({ resolve: false, fetchImpl });
    await guarded('https://public.test/');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a redirect to another public host', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).hostname === 'first.test') {
        return new Response(null, { status: 301, headers: { location: 'https://second.test/final' } });
      }
      return new Response('landed', { status: 200 });
    });
    const guarded = createSsrfFetch({ resolve: false, fetchImpl });
    const response = await guarded('https://first.test/');
    expect(await response.text()).toBe('landed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up on a redirect loop', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://loop.test/next' } }));
    const guarded = createSsrfFetch({ resolve: false, maxRedirects: 2, fetchImpl });
    await expect(guarded('https://loop.test/')).rejects.toThrow('too many redirects');
  });

  it('refuses non-http schemes', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 200 }));
    const guarded = createSsrfFetch({ resolve: false, fetchImpl });
    await expect(guarded('file:///etc/passwd')).rejects.toThrow('unsupported scheme');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates each distinct host exactly once', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const guarded = createSsrfFetch({ fetchImpl });
    await guarded('https://example.com/a');
    await guarded('https://example.com/b');
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The credential a redirect must not carry off. Walking the chain by hand means
 * re-issuing `init` per hop, which would otherwise re-attach the `Authorization`
 * header the platform deliberately drops when the origin changes.
 */
describe('createSsrfFetch credentials across redirects', () => {
  const AUTH = 'Bearer sk-THE-WORKSPACE-KEY';

  /** Redirects the first request to `target`, then answers 200. */
  function chain(target: string) {
    const hops: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      hops.push({ url, headers: new Headers((init?.headers ?? {}) as HeadersInit) });
      if (hops.length === 1) return new Response(null, { status: 302, headers: { location: target } });
      return new Response('landed', { status: 200 });
    });
    return { hops, fetchImpl };
  }

  // `init.headers` is three different types in practice, and the SDK passes the
  // first of them.
  const shapes: Array<[string, () => HeadersInit]> = [
    ['a Headers instance', () => new Headers({ authorization: AUTH, cookie: 'session=abc', 'content-type': 'application/json' })],
    ['a plain object', () => ({ Authorization: AUTH, Cookie: 'session=abc', 'Content-Type': 'application/json' })],
    ['an array of pairs', () => [['Authorization', AUTH], ['cookie', 'session=abc'], ['content-type', 'application/json']] as Array<[string, string]>]
  ];

  for (const [label, build] of shapes) {
    it(`drops authorization and cookie on a cross-origin hop, given ${label}`, async () => {
      const { hops, fetchImpl } = chain('https://attacker.example/collect');
      const guarded = createSsrfFetch({ resolve: false, fetchImpl });

      const response = await guarded('https://api.example/v1/chat', { method: 'POST', headers: build() });

      expect(await response.text()).toBe('landed');
      expect(hops[0].headers.get('authorization')).toBe(AUTH);
      expect(hops[0].headers.get('cookie')).toBe('session=abc');
      // The regression: hop 2 reached another origin holding the workspace key.
      expect(hops[1].url).toBe('https://attacker.example/collect');
      expect(hops[1].headers.get('authorization')).toBeNull();
      expect(hops[1].headers.get('cookie')).toBeNull();
      // Everything else still travels, so the redirect is still usable.
      expect(hops[1].headers.get('content-type')).toBe('application/json');
    });

    it(`leaves the caller's headers untouched, given ${label}`, async () => {
      const { fetchImpl } = chain('https://attacker.example/collect');
      const headers = build();
      const before = [...new Headers(headers).entries()];

      await createSsrfFetch({ resolve: false, fetchImpl })('https://api.example/v1/chat', { headers });

      expect([...new Headers(headers).entries()]).toEqual(before);
    });
  }

  it('keeps credentials on a same-origin redirect', async () => {
    const { hops, fetchImpl } = chain('https://api.example/v1/chat/final');
    const guarded = createSsrfFetch({ resolve: false, fetchImpl });

    await guarded('https://api.example/v1/chat', { headers: { authorization: AUTH } });

    expect(hops[1].headers.get('authorization')).toBe(AUTH);
  });

  // Origin is scheme + host + port: same host is not the same origin.
  it.each([
    ['a port change', 'https://api.example:8443/v1'],
    ['a scheme change', 'http://api.example/v1'],
    ['a subdomain change', 'https://logs.api.example/v1']
  ])('drops credentials on %s', async (_label, target) => {
    const { hops, fetchImpl } = chain(target);
    const guarded = createSsrfFetch({ resolve: false, fetchImpl });

    await guarded('https://api.example/v1/chat', { headers: { authorization: AUTH, 'x-trace': 'keep-me' } });

    expect(hops[1].headers.get('authorization')).toBeNull();
    expect(hops[1].headers.get('x-trace')).toBe('keep-me');
  });

  it('does not restore credentials on a later hop back to the first origin', async () => {
    const hops: Array<Headers> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      hops.push(new Headers((init?.headers ?? {}) as HeadersInit));
      if (hops.length === 1) return new Response(null, { status: 302, headers: { location: 'https://detour.example/x' } });
      if (hops.length === 2) return new Response(null, { status: 302, headers: { location: 'https://api.example/back' } });
      return new Response('landed', { status: 200 });
    });

    await createSsrfFetch({ resolve: false, fetchImpl })('https://api.example/v1', { headers: { authorization: AUTH } });

    expect(hops[2].get('authorization')).toBeNull();
  });

  it('survives a request with no headers at all', async () => {
    const { hops, fetchImpl } = chain('https://other.example/x');
    const response = await createSsrfFetch({ resolve: false, fetchImpl })('https://api.example/v1');
    expect(response.status).toBe(200);
    expect([...hops[1].headers.keys()]).toEqual([]);
  });
});

/**
 * The self-host escape hatch. `validatePublicHost` refuses loopback, raw IPs and
 * explicit ports STRUCTURALLY, before `resolve` is consulted, so opting a
 * private endpoint in needs its own switch -- and that switch must stay off by
 * default for every other caller.
 */
describe('createSsrfFetch allowPrivateHosts', () => {
  const privateUrls = [
    'http://localhost:11434/v1/chat/completions',
    'http://127.0.0.1:8000/v1',
    'https://vllm.internal/v1',
    'http://[::1]:11434/v1',
    'https://169.254.169.254/latest/meta-data'
  ];

  it('dials a private endpoint when the operator has opted in', async () => {
    const reached: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      reached.push(url);
      return new Response('ok', { status: 200 });
    });
    const guarded = createSsrfFetch({ allowPrivateHosts: true, fetchImpl });

    for (const url of privateUrls) await expect(guarded(url)).resolves.toBeDefined();

    expect(reached).toHaveLength(privateUrls.length);
    // No DNS either: the allow-list is skipped, not merely relaxed.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses the same endpoints by default', async () => {
    // `vllm.internal` is structurally fine; only DNS exposes it, so the default
    // wrapper has to still be resolving.
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const guarded = createSsrfFetch({ fetchImpl });

    for (const url of privateUrls) await expect(guarded(url)).rejects.toThrow(SsrfError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still refuses a non-http scheme and still bounds redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/next' } }));
    const guarded = createSsrfFetch({ allowPrivateHosts: true, maxRedirects: 2, fetchImpl });

    await expect(guarded('file:///etc/passwd')).rejects.toThrow('unsupported scheme');
    await expect(guarded('http://127.0.0.1/')).rejects.toThrow('too many redirects');
  });

  /**
   * The waiver covers the origin the operator named, and nothing else.
   *
   * An earlier version waived the allow-list for every hop, which turned the
   * self-host flag into an SSRF primitive: a self-hoster on a cloud VM pointed
   * the agent at their own Ollama, and that endpoint could answer 302 and walk
   * the guard into the instance metadata service. The operator chose one private
   * destination; the endpoint does not get to choose the next one.
   */
  it('refuses a redirect from the opted-in endpoint to a different private host', async () => {
    const reached: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      reached.push(url);
      return url.includes('169.254')
        ? new Response('instance-credentials', { status: 200 })
        : new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    });
    const guarded = createSsrfFetch({ allowPrivateHosts: true, fetchImpl });

    await expect(guarded('http://localhost:11434/v1/chat/completions')).rejects.toThrow(SsrfError);
    // Hop 0 left the process; the metadata service was never asked.
    expect(reached).toEqual(['http://localhost:11434/v1/chat/completions']);
  });

  it('follows a redirect that stays on the opted-in origin, so a local proxy still works', async () => {
    const reached: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      reached.push(url);
      return url.endsWith('/v1/chat/completions')
        ? new Response(null, { status: 307, headers: { location: 'http://localhost:11434/v1/completions' } })
        : new Response('ok', { status: 200 });
    });
    const guarded = createSsrfFetch({ allowPrivateHosts: true, fetchImpl });

    await expect(guarded('http://localhost:11434/v1/chat/completions')).resolves.toBeDefined();
    expect(reached).toEqual([
      'http://localhost:11434/v1/chat/completions',
      'http://localhost:11434/v1/completions'
    ]);
  });
});
