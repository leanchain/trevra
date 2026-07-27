import { describe, expect, it } from 'vitest';
import { findContacts } from './contact.js';
import type { FetchLike } from './guard.js';

const HOME = `<!doctype html><html><body>
<a href="mailto:hello@acme.test">Email us</a>
<a href="/contact">Contact us</a>
<a href="/team">Our team</a>
<a href="https://partners.example/contact">Contact our partner</a>
<a href="https://www.linkedin.com/company/acme">LinkedIn</a>
<a href="/collections/shoes">Shop shoes</a>
</body></html>`;

const CONTACT = `<!doctype html><html><body>
<a href="mailto:Press@Acme.test?subject=Hi">Press enquiries</a>
<a href="https://x.com/acmehq">X</a>
<p>Or write to sales@acme.test</p>
</body></html>`;

function site(routes: Record<string, () => Response>, log?: string[]): FetchLike {
  return async (url: string) => {
    log?.push(url);
    const route = routes[new URL(url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
}

function html(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });
}

const ROUTES: Record<string, () => Response> = {
  '/robots.txt': () => new Response('User-agent: *\nAllow: /\n', { status: 200 }),
  '/': () => html(HOME),
  '/contact': () => html(CONTACT),
  '/team': () => html('<a href="mailto:team@acme.test">Team</a>')
};

describe('gtm.find-contact', () => {
  it('returns published contacts, each carrying the exact URL it came from', async () => {
    const result = await findContacts('acme.test', { fetchImpl: site(ROUTES) });

    const emails = result.contacts.filter((contact) => contact.kind === 'email');
    expect(emails.map((contact) => [contact.value, contact.source])).toEqual([
      ['hello@acme.test', 'https://acme.test/'],
      ['press@acme.test', 'https://acme.test/contact'],
      ['team@acme.test', 'https://acme.test/team']
    ]);
    expect(result.contacts.every((contact) => contact.confidence === 'published')).toBe(true);

    // sales@acme.test appears as body text with no mailto: anchor. It is not a
    // published way to reach them, so it is not returned.
    expect(result.contacts.map((contact) => contact.value)).not.toContain('sales@acme.test');
  });

  it('reads social handles without ever fetching them', async () => {
    const log: string[] = [];
    const result = await findContacts('acme.test', { fetchImpl: site(ROUTES, log) });

    const socials = result.contacts.filter((contact) => contact.kind === 'social');
    expect(socials.map((contact) => [contact.platform, contact.value])).toEqual([
      ['linkedin', 'acme'],
      ['x', 'acmehq']
    ]);
    expect(socials[0].source).toBe('https://acme.test/');
    expect(log.every((url) => new URL(url).host === 'acme.test')).toBe(true);
  });

  it('never follows an off-origin link, however contact-ish its text', async () => {
    const log: string[] = [];
    await findContacts('acme.test', { fetchImpl: site(ROUTES, log) });
    expect(log.some((url) => url.includes('partners.example'))).toBe(false);
  });

  it('respects robots.txt per path using the audit parser', async () => {
    const log: string[] = [];
    const result = await findContacts('acme.test', {
      fetchImpl: site({ ...ROUTES, '/robots.txt': () => new Response('User-agent: *\nDisallow: /team\n', { status: 200 }) }, log)
    });

    expect(log).not.toContain('https://acme.test/team');
    expect(result.pagesSkipped).toContainEqual({ url: 'https://acme.test/team', reason: 'robots.txt disallows this path' });
    expect(result.contacts.map((contact) => contact.value)).not.toContain('team@acme.test');
    expect(result.robotsFound).toBe(true);
  });

  it('treats an unreachable robots.txt as no restriction, matching the audit', async () => {
    const result = await findContacts('acme.test', {
      fetchImpl: site({ ...ROUTES, '/robots.txt': () => new Response('nope', { status: 500 }) })
    });
    expect(result.robotsFound).toBe(false);
    expect(result.pagesFetched).toContain('https://acme.test/');
  });

  it('bounds outbound requests by the page budget', async () => {
    const log: string[] = [];
    const result = await findContacts('acme.test', { pageBudget: 2, fetchImpl: site(ROUTES, log) });
    // robots.txt plus exactly two page requests.
    expect(log).toHaveLength(3);
    expect(result.pagesFetched).toHaveLength(2);
    expect(result.pagesSkipped.some((page) => page.reason === 'page budget exhausted')).toBe(true);
  });

  it('emits no guesses by default', async () => {
    const result = await findContacts('acme.test', { fetchImpl: site(ROUTES) });
    expect(result.contacts.some((contact) => contact.confidence === 'guessed')).toBe(false);
  });

  it('labels a requested pattern address as guessed, with no source', async () => {
    const result = await findContacts('acme.test', { includeGuesses: true, fetchImpl: site(ROUTES) });
    const guessed = result.contacts.filter((contact) => contact.confidence === 'guessed');

    expect(guessed.map((contact) => contact.value)).toEqual(['contact@acme.test', 'info@acme.test']);
    expect(guessed.every((contact) => contact.source === null)).toBe(true);
    // hello@ was actually published, so it stays a published contact and is not
    // duplicated as a guess.
    expect(result.contacts.filter((contact) => contact.value === 'hello@acme.test')).toHaveLength(1);
    expect(result.contacts.find((contact) => contact.value === 'hello@acme.test')?.confidence).toBe('published');
    // Published contacts always sort ahead of guessed ones.
    expect(result.contacts[0].confidence).toBe('published');
  });

  it('degrades an unreachable site to an empty, non-throwing result', async () => {
    const result = await findContacts('down.test', {
      fetchImpl: async () => {
        throw new TypeError('network down');
      }
    });
    expect(result.contacts).toEqual([]);
    expect(result.pagesFetched).toEqual([]);
    expect(result.pagesSkipped.every((page) => page.reason === 'unreachable')).toBe(true);
  });

  it('rejects a non-public host before any probe runs', async () => {
    await expect(findContacts('localhost', { fetchImpl: site({}) })).rejects.toThrow('localhost not allowed');
  });
});
