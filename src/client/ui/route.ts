import { useCallback, useEffect, useState } from 'react';

/* --------------------------------------------------------------------------
 * The route is the PATH. The hash is never a route.
 *
 * THIS IS A CONTRACT, NOT A PREFERENCE, and it is written here because it kept
 * being undone. `/outreach/inbox` is the address of the inbox. `#inbox` is a
 * scroll position. The two are different kinds of thing and this shell no
 * longer spells one of them with the other:
 *
 *   * A ROUTE is a path -- `/ledger/run/abc` -- assigned whole on every
 *     navigation through `history.pushState`. It is what the address bar
 *     shows, what a bookmark keeps, what a teammate receives, and what the
 *     server answers with the app.
 *   * AN ANCHOR is a fragment -- `#hosted`, `#approval`, `#main` -- and it
 *     means one thing only: scroll to that element ON THIS PAGE. The marketing
 *     page owns every one of them and this router never reads, writes or
 *     rewrites the fragment at all.
 *
 * WHY IT WAS EVER A HASH, and why that is over. Hash routing needs no server
 * cooperation: `/#/outreach/inbox` is a request for `/`, so a static host
 * cannot 404 it. The cost is that the real URL of every screen was `/`, which
 * made an in-page anchor and a screen address indistinguishable -- a `Login`
 * link pointing at `#hosted` and a nav item pointing at `/outreach` looked
 * like the same construct and behaved nothing alike. `src/server/index.ts`
 * now answers the app's own paths with the app, so the cooperation exists and
 * the workaround is not needed.
 *
 * OLD HASH URLS ARE NOT HONOURED. A `#/outreach/inbox` bookmark from before
 * this change lands on the default route, deliberately: keeping a hash-route
 * reader alive is keeping the ambiguity alive, and the rule above has to be
 * true with no exceptions to stay true at all.
 */

export type Section = 'loop' | 'outreach' | 'ledger' | 'research' | 'setup';

export const SECTIONS: readonly Section[] = ['loop', 'outreach', 'ledger', 'research', 'setup'];

/** Which second segments each section answers to. */
const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'new', 'campaign', 'workflow', 'inbound', 'inbox', 'opportunities', 'posts'],
  ledger: ['', 'run'],
  research: [''],
  // `team` only exists with an invitation id: `/setup/team/:invitationId`.
  setup: ['', 'workspace', 'capture', 'team']
};

export interface Route {
  section: Section;
  /** The second segment, or '' for the section root. */
  sub: string;
  /** The third segment of a deep link -- `/ledger/run/:id` -- or null. */
  id: string | null;
  /** The normalised path, `/ledger/run/abc`. Stable enough to key effects on. */
  path: string;
}

const DEFAULT: Route = { section: 'loop', sub: '', id: null, path: '/loop' };

function build(section: Section, sub: string, id: string | null): Route {
  const path = `/${section}${sub ? `/${sub}` : ''}${id ? `/${id}` : ''}`;
  return { section, sub, id, path };
}

/**
 * Is this path the SPA's to answer?
 *
 * This is deliberately stricter than `parseRoute`: removed aliases and typos
 * are not intercepted by the client and are not served the SPA by production.
 * They fall through to the server's real 404 instead of silently becoming a
 * different screen.
 */
export function isAppPath(pathname: string): boolean {
  const raw = pathname.replace(/\/+$/, '');
  if (!raw || raw === '/') return true;
  if (raw === '/login') return true;
  if (raw.includes('.')) return false;

  const [head, sub = '', ...rest] = raw.replace(/^\//, '').split('/');
  if (!(SECTIONS as readonly string[]).includes(head)) return false;
  const section = head as Section;
  if (!SUB_ROUTES[section].includes(sub)) return false;

  if (section === 'ledger' && sub === 'run') return rest.length === 1 && Boolean(rest[0]);
  if (section === 'outreach' && sub === 'campaign') return rest.length === 1 && Boolean(rest[0]);
  if (section === 'outreach' && sub === 'workflow')
    return (rest.length === 1 || rest.length === 2) && rest.every(Boolean);
  if (section === 'setup' && sub === 'team') return rest.length === 1 && Boolean(rest[0]);

  return rest.length === 0;
}

/** True for `/login`, the auth screen's own address. */
export const isLoginPath = (pathname: string): boolean =>
  pathname === '/login' || pathname === '/login/';

export function parseRoute(pathname: string): Route {
  const raw = pathname.replace(/\/+$/, '');
  if (!raw || raw === '/') return DEFAULT;

  const [head, sub = '', ...rest] = raw
    .replace(/^\//, '')
    .split('/')
    .map((part) => decodeURIComponent(part));
  const section = (SECTIONS as readonly string[]).includes(head)
    ? (head as Section)
    : DEFAULT.section;
  if (!SUB_ROUTES[section].includes(sub)) return build(section, '', null);
  const id = rest.length > 0 && rest[0] ? rest.join('/') : null;
  if (sub === 'run' && !id) return build(section, '', null);
  if (section === 'setup' && sub === 'team' && !id) return build(section, '', null);
  return build(section, sub, id);
}

/* --------------------------------------------------------------------------
 * Moving between screens.
 * -------------------------------------------------------------------------- */

/** Everything currently listening for a route change, notified in one pass. */
const subscribers = new Set<() => void>();

function announce(): void {
  for (const notify of [...subscribers]) notify();
}

/** Go to a path without a page load. */
export function navigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.pathname + window.location.search === next) return;
  window.history.pushState(null, '', next);
  announce();
}

/** Replace the current in-app address without leaving it in Back history. */
export function replaceNavigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.pathname + window.location.search === next) return;
  window.history.replaceState(null, '', next);
  announce();
}

/**
 * ONE listener for every in-app link in the shell, so a link stays a link.
 * Removed/unknown app-looking paths are deliberately not intercepted: the
 * browser asks the server for them and receives a real 404.
 */
function interceptLinkClicks(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.('a');
  if (!anchor) return;
  if (anchor.target && anchor.target !== '_self') return;
  if (anchor.hasAttribute('download') || anchor.getAttribute('rel')?.includes('external')) return;

  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  if (url.hash && url.pathname === window.location.pathname) return;
  if (!isAppPath(url.pathname)) return;

  event.preventDefault();
  navigate(url.pathname + url.search);
}

/** Where you are, and one function that moves you. */
export function useRoute(): [Route, (path: string) => void] {
  const read = useCallback(() => parseRoute(window.location.pathname), []);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const sync = () => setRoute(read());
    sync();
    if (subscribers.size === 0) {
      window.addEventListener('popstate', announce);
      document.addEventListener('click', interceptLinkClicks, true);
    }
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
      if (subscribers.size === 0) {
        window.removeEventListener('popstate', announce);
        document.removeEventListener('click', interceptLinkClicks, true);
      }
    };
  }, [read]);

  return [route, navigate];
}

/** Subscribe to route changes without parsing one. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname
  );
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    sync();
    if (subscribers.size === 0) {
      window.addEventListener('popstate', announce);
      document.addEventListener('click', interceptLinkClicks, true);
    }
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
      if (subscribers.size === 0) {
        window.removeEventListener('popstate', announce);
        document.removeEventListener('click', interceptLinkClicks, true);
      }
    };
  }, []);
  return pathname;
}
