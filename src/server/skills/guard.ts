import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Skill } from './types.js';

/**
 * SSRF guard for outbound HTTP.
 *
 * Ported from the Python reference `src/growth/netguard.py`. Blocks requests
 * to internal / non-public destinations. Two layers:
 *
 * - {@link validatePublicHost} -- structural + DNS pre-flight, run before the
 *   first fetch of a user-supplied domain.
 * - {@link createSsrfFetch} -- the equivalent of the reference's
 *   `make_ssrf_hook`: a `fetch` wrapper that re-validates the host on EVERY
 *   redirect hop. This is the layer that actually matters: a pre-flight check
 *   alone is defeated by `https://attacker.example` answering `302` with
 *   `Location: http://169.254.169.254/latest/meta-data`. Node's `fetch`
 *   follows redirects internally, so the wrapper switches to
 *   `redirect: 'manual'` and walks the chain itself, validating before each
 *   request is issued.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Non-public IPv4 space: unspecified/this-network, RFC1918, CGNAT, loopback,
 * link-local, IETF protocol assignments, documentation ranges, 6to4 relay
 * anycast, benchmarking, multicast, and the reserved 240/4 block (which
 * includes 255.255.255.255).
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    if (!/^\d{1,3}$/.test(parts[index])) return null;
    const octet = Number(parts[index]);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  let text = value;
  // An IPv4 tail (e.g. `::ffff:192.168.0.1`) becomes the last two hex groups.
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
    const tail = parseIpv4(text.slice(lastColon + 1));
    if (!tail) return null;
    const high = ((tail[0] << 8) | tail[1]).toString(16);
    const low = ((tail[2] << 8) | tail[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups: number[] = [];
  const push = (segments: string[]): boolean => {
    for (const segment of segments) {
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return false;
      groups.push(Number.parseInt(segment, 16));
    }
    return true;
  };
  if (!push(head)) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    for (let index = 0; index < fill; index += 1) groups.push(0);
  } else if (head.length !== 8) {
    return null;
  }
  if (!push(tail)) return null;
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function inCidr(address: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const wholeBytes = prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  const remainder = prefix & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

function inCidr4(address: Uint8Array, network: string, prefix: number): boolean {
  const parsed = parseIpv4(network);
  return parsed !== null && inCidr(address, parsed, prefix);
}

function inCidr6(address: Uint8Array, network: string, prefix: number): boolean {
  const parsed = parseIpv6(network);
  return parsed !== null && inCidr(address, parsed, prefix);
}

function isBlockedIpv4(address: Uint8Array): boolean {
  return BLOCKED_V4.some(([network, prefix]) => inCidr4(address, network, prefix));
}

function isBlockedIpv6(address: Uint8Array): boolean {
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) smuggle an IPv4
  // address inside a v6 one -- judge the embedded address, not the wrapper.
  if (inCidr6(address, '::ffff:0:0', 96) || inCidr6(address, '64:ff9b::', 96)) return isBlockedIpv4(address.slice(12));
  // Only global unicast (2000::/3) is publicly routable. Everything else is
  // unspecified, loopback, unique-local, link-local, multicast, or reserved.
  if (!inCidr6(address, '2000::', 3)) return true;
  // Carve-outs that sit inside 2000::/3 but are still not public:
  // 2001::/23 IETF protocol assignments (Teredo), 2001:db8::/32 documentation,
  // and 2002::/16 6to4, which encapsulates an arbitrary IPv4 destination.
  return inCidr6(address, '2001::', 23) || inCidr6(address, '2001:db8::', 32) || inCidr6(address, '2002::', 16);
}

/** True when `address` is private, loopback, link-local, reserved, multicast, or unspecified. */
export function isBlockedAddress(address: string): boolean {
  // Drop any IPv6 zone index (`fe80::1%eth0`).
  const bare = address.split('%', 1)[0];
  const version = isIP(bare);
  if (version === 4) {
    const parsed = parseIpv4(bare);
    return parsed === null || isBlockedIpv4(parsed);
  }
  if (version === 6) {
    const parsed = parseIpv6(bare);
    return parsed === null || isBlockedIpv6(parsed);
  }
  // Not an address we can classify -- refuse rather than guess.
  return true;
}

/**
 * Throw {@link SsrfError} unless `host` is a safe, public hostname.
 *
 * Structural checks (always applied): reject empty hosts, bracketed IP
 * literals, explicit ports, raw IPv4/IPv6 literals, `localhost` /
 * `*.localhost`, `*.local`, and single-label hosts (no dot). When `resolve` is
 * true, additionally resolve the host and require EVERY resolved address to be
 * public -- one public A record does not excuse an AAAA record pointing at
 * link-local space.
 */
export async function validatePublicHost(host: string, options: { resolve?: boolean } = {}): Promise<void> {
  const shouldResolve = options.resolve ?? true;
  if (!host || !host.trim()) throw new SsrfError('empty host');
  const cleaned = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!cleaned) throw new SsrfError('empty host');
  if (cleaned.startsWith('[')) throw new SsrfError(`bracketed IP literal not allowed: '${host}'`);
  // Explicit port (`host:port`). Bare IPv6 literals carry multiple colons and
  // are caught by the IP-literal check below instead.
  const lastColon = cleaned.lastIndexOf(':');
  if (lastColon >= 0) {
    const head = cleaned.slice(0, lastColon);
    const tail = cleaned.slice(lastColon + 1);
    if (tail.length > 0 && /^\d+$/.test(tail) && !head.includes(':')) throw new SsrfError(`explicit port not allowed: '${host}'`);
  }
  if (isIP(cleaned) !== 0) throw new SsrfError(`raw IP address not allowed: '${host}'`);
  if (cleaned === 'localhost' || cleaned.endsWith('.localhost')) throw new SsrfError(`localhost not allowed: '${host}'`);
  if (cleaned.endsWith('.local')) throw new SsrfError(`mDNS .local host not allowed: '${host}'`);
  if (!cleaned.includes('.')) throw new SsrfError(`single-label host not allowed: '${host}'`);
  if (!shouldResolve) return;

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(cleaned, { all: true, verbatim: true });
  } catch (cause) {
    throw new SsrfError(`could not resolve host '${host}': ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const addresses = [...new Set(resolved.map((entry) => entry.address))];
  if (addresses.length === 0) throw new SsrfError(`host '${host}' did not resolve to any address`);
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new SsrfError(`host '${host}' resolves to non-public address ${address}`);
  }
}

export interface SsrfFetchOptions {
  /** Set false when a mocked fetch is injected: structural checks still run, DNS does not. */
  resolve?: boolean;
  maxRedirects?: number;
  fetchImpl?: FetchLike;
}

/**
 * Build a `fetch` wrapper that validates every request host, redirect hops
 * included. Resolutions are cached per wrapper (i.e. per audit run), mirroring
 * the per-client cache of the reference's `make_ssrf_hook`.
 */
export function createSsrfFetch(options: SsrfFetchOptions = {}): FetchLike {
  const shouldResolve = options.resolve ?? true;
  const maxRedirects = options.maxRedirects ?? 5;
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const checked = new Set<string>();

  return async function ssrfFetch(input: string, init?: RequestInit): Promise<Response> {
    let url = new URL(input);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError(`unsupported scheme: ${url.protocol}`);
      if (!checked.has(url.hostname)) {
        await validatePublicHost(url.hostname, { resolve: shouldResolve });
        checked.add(url.hostname);
      }
      // `manual` hands each hop back to us so the guard runs again before the
      // next request leaves the process.
      const response = await fetchImpl(url.toString(), { ...init, redirect: 'manual' });
      if (!REDIRECT_STATUS.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (response.body) await response.body.cancel().catch(() => undefined);
      url = new URL(location, url);
    }
    throw new SsrfError(`too many redirects (>${maxRedirects})`);
  };
}

const inputSchema = z.object({
  host: z.string(),
  /** Skip DNS and run structural checks only. */
  structuralOnly: z.boolean().optional()
});

const outputSchema = z.object({
  host: z.string(),
  allowed: z.boolean(),
  reason: z.string().nullable()
});

type GuardInput = z.infer<typeof inputSchema>;
type GuardOutput = z.infer<typeof outputSchema>;

export const validateHostSkill: Skill<GuardInput, GuardOutput> = {
  manifest: {
    id: 'net.validate-host',
    name: 'Validate outbound host',
    version: '1.0.0',
    description: 'Reject hosts that are not safe, public outbound destinations (SSRF pre-flight).',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    try {
      await validatePublicHost(input.host, { resolve: !input.structuralOnly });
      return { host: input.host, allowed: true, reason: null };
    } catch (cause) {
      if (cause instanceof SsrfError) return { host: input.host, allowed: false, reason: cause.message };
      throw cause;
    }
  }
};
