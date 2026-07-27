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
