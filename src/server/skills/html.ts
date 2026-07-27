/**
 * Shared HTML / robots.txt readers for the probe skills.
 *
 * Extracted from `audit.ts` the moment a second reader needed the same JSON-LD
 * and meta handling; a copy would have drifted and left two different answers
 * to "what is this company called".
 *
 * Regex, not a DOM parser. These readers run against pages we do not control,
 * to pull a handful of well-known tags -- a real parser means a dependency and
 * a whole-document build for four fields. The price of that choice is that
 * every extractor here must survive malformed markup by returning nothing
 * instead of throwing, because "absent" is a normal answer for a probe and an
 * exception would take down the whole run.
 *
 * `metaContent` and `pageTitle` are byte-for-byte what `audit.ts` shipped,
 * entity decoding deliberately included: the audit measures title and
 * description LENGTH, so decoding `&amp;` here would silently move a store
 * across the meta-quality size thresholds.
 */

const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RE = /<meta\b[^>]*>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /href\s*=\s*["']([^"']*)["']/i;
const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]+>/g;

/** Deliberately linear: an address shape check, not RFC 5322 validation. */
const EMAIL_RE = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Decode the entity forms that actually appear in link text and mailto hrefs. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#')) {
      const hex = key.startsWith('#x');
      const code = Number.parseInt(hex ? key.slice(2) : key.slice(1), hex ? 16 : 10);
      // Out-of-range code points make fromCodePoint throw; leave those literal.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[key] ?? match;
  });
}

/** Visible text of a markup fragment: scripts, styles, comments, and tags removed. */
export function stripTags(html: string): string {
  const bare = html.replace(SCRIPT_STYLE_RE, ' ').replace(COMMENT_RE, ' ').replace(TAG_RE, ' ');
  return collapse(decodeEntities(bare));
}

// --------------------------------------------------------------------------- //
// JSON-LD
// --------------------------------------------------------------------------- //

/** Flatten arrays and `@graph` containers into a single list of plain objects. */
export function flattenJsonLd(data: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (Array.isArray(data)) {
    for (const item of data) out.push(...flattenJsonLd(item));
  } else if (isRecord(data)) {
    const graph = data['@graph'];
    if (Array.isArray(graph)) {
      for (const item of graph) out.push(...flattenJsonLd(item));
    }
    out.push(data);
  }
  return out;
}

export function extractJsonLd(html: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(JSONLD_RE)) {
    try {
      objects.push(...flattenJsonLd(JSON.parse(match[1].trim())));
    } catch {
      continue;
    }
  }
  return objects;
}

export function jsonLdTypes(objects: Array<Record<string, unknown>>): Set<string> {
  const types = new Set<string>();
  for (const object of objects) {
    const type = object['@type'];
    if (typeof type === 'string') types.add(type);
    else if (Array.isArray(type)) for (const item of type) if (typeof item === 'string') types.add(item);
  }
  return types;
}

export function isType(object: Record<string, unknown>, name: string): boolean {
  const type = object['@type'];
  if (typeof type === 'string') return type === name;
  if (Array.isArray(type)) return type.includes(name);
  return false;
}

// --------------------------------------------------------------------------- //
// meta / headings / links
// --------------------------------------------------------------------------- //

export function metaContent(html: string, attribute: string, value: string): string | null {
  const matcher = new RegExp(`${attribute}\\s*=\\s*["']${escapeRegExp(value)}["']`, 'i');
  for (const tag of html.matchAll(META_RE)) {
    if (!matcher.test(tag[0])) continue;
    const content = /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag[0]);
    if (content) return content[1].trim();
  }
  return null;
}

export function pageTitle(html: string): string | null {
  const match = TITLE_RE.exec(html);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ').trim() || null;
}

/** First `<h1>` as visible text -- the closest thing to "the claim this page makes". */
export function firstHeading(html: string): string | null {
  const match = H1_RE.exec(html);
  if (!match) return null;
  return stripTags(match[1]) || null;
}

export interface PageLink {
  href: string;
  text: string;
}

export function extractLinks(html: string): PageLink[] {
  const links: PageLink[] = [];
  for (const match of html.matchAll(ANCHOR_RE)) {
    const href = HREF_RE.exec(match[1]);
    if (!href) continue;
    const value = decodeEntities(href[1]).trim();
    if (!value) continue;
    links.push({ href: value, text: stripTags(match[2]) });
  }
  return links;
}

/**
 * Addresses a `mailto:` link publishes, lowercased and sorted.
 *
 * Only `mailto:` -- never bare text that looks like an address. A string in
 * body copy may be an example, a customer's address, or an image caption, and
 * the contact skill promises that everything it returns was PUBLISHED as a way
 * to reach the company. An anchor is that promise in machine-readable form.
 */
export function extractMailtos(html: string): string[] {
  const found = new Set<string>();
  for (const link of extractLinks(html)) {
    if (!/^mailto:/i.test(link.href)) continue;
    const address = link.href.slice('mailto:'.length).split('?', 1)[0].trim().toLowerCase();
    if (EMAIL_RE.test(address)) found.add(address);
  }
  return [...found].sort();
}

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value);
}

/**
 * The path part of `href` when it stays on `base`'s origin, else `null`.
 *
 * Query and fragment are dropped so that one page reached three ways is one
 * entry in a crawl queue, not three -- an unbounded set of same-page URLs is
 * how a bounded crawl quietly stops being bounded.
 */
export function sameOriginPath(base: URL, href: string, pageUrl: string = base.href): string | null {
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.host !== base.host) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

export interface SocialProfile {
  platform: string;
  handle: string;
  url: string;
}

const SOCIAL_HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)linkedin\.com$/i, 'linkedin'],
  [/(^|\.)twitter\.com$/i, 'twitter'],
  [/(^|\.)x\.com$/i, 'x'],
  [/(^|\.)instagram\.com$/i, 'instagram'],
  [/(^|\.)facebook\.com$/i, 'facebook'],
  [/(^|\.)github\.com$/i, 'github'],
  [/(^|\.)youtube\.com$/i, 'youtube'],
  [/(^|\.)tiktok\.com$/i, 'tiktok'],
  [/(^|\.)threads\.net$/i, 'threads'],
  [/(^|\.)bsky\.app$/i, 'bluesky'],
  [/(^|\.)mastodon\.social$/i, 'mastodon'],
  [/(^|\.)crunchbase\.com$/i, 'crunchbase']
];

/** Path segments that name a container rather than the account itself. */
const SOCIAL_CONTAINERS: ReadonlySet<string> = new Set(['company', 'companies', 'in', 'school', 'showcase', 'profile', 'pages', 'user', 'users', 'c', 'channel', 'organization']);

/**
 * Read a social profile out of a link, or `null` when the link is not one.
 *
 * A bare `facebook.com` link carries no handle, so it is not a profile and is
 * dropped -- publishing a company as reachable at "facebook" would be a
 * fabricated contact. `@` is stripped so the handle matches what the company
 * writes on its own site.
 */
export function socialProfile(rawUrl: string, base?: string): SocialProfile | null {
  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const platform = SOCIAL_HOSTS.find(([pattern]) => pattern.test(url.hostname))?.[1];
  if (!platform) return null;
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  const handle = segments.find((segment) => !SOCIAL_CONTAINERS.has(segment.toLowerCase()));
  if (!handle) return null;
  return {
    platform,
    handle: handle.replace(/^@/, ''),
    url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  };
}

// --------------------------------------------------------------------------- //
// robots.txt
// --------------------------------------------------------------------------- //

export type RobotsRules = Map<string, Array<[string, string]>>;

/**
 * Return `{ user_agent_lower: [[directive, value], ...] }`.
 *
 * Consecutive `User-agent` lines share the rules that follow them, per the
 * robots grammar -- the `expectingAgent` latch is what implements that, and
 * getting it wrong silently mis-reads every stacked-agent robots.txt in the
 * wild. Comments and unrelated directives are ignored.
 */
export function parseRobots(text: string): RobotsRules {
  const agents: RobotsRules = new Map();
  let current: string[] = [];
  let expectingAgent = true;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line || !line.includes(':')) continue;
    const separator = line.indexOf(':');
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      // A User-agent line that follows a rule starts a fresh group.
      if (!expectingAgent) current = [];
      const agent = value.toLowerCase();
      current.push(agent);
      if (!agents.has(agent)) agents.set(agent, []);
      expectingAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      for (const agent of current) {
        const rules = agents.get(agent) ?? [];
        rules.push([key, value]);
        agents.set(agent, rules);
      }
      expectingAgent = false;
    }
  }
  return agents;
}

function robotsPathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether `agent` may fetch `path`, by the longest-match rule the major
 * crawlers implement: the most specific pattern wins and `Allow` breaks a tie.
 *
 * Prefix-only matching would read `Disallow: /` + `Allow: /contact` as a full
 * block and silently skip exactly the page the contact crawl exists to read.
 * An agent with no group of its own inherits `*`; no group at all means no
 * restriction, which is the same reading `audit.ts` gives a missing file.
 */
export function robotsAllows(rules: RobotsRules, agent: string, path: string): boolean {
  const group = rules.get(agent.toLowerCase()) ?? rules.get('*');
  if (!group || group.length === 0) return true;
  let best: { length: number; allow: boolean } | null = null;
  for (const [directive, value] of group) {
    // `Disallow:` with an empty value is the documented way to say "nothing is disallowed".
    if (value === '') continue;
    if (!robotsPathMatches(value, path)) continue;
    const allow = directive === 'allow';
    if (best === null || value.length > best.length || (value.length === best.length && allow)) {
      best = { length: value.length, allow };
    }
  }
  return best === null ? true : best.allow;
}
