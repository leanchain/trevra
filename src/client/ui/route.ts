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
 * this change lands
 * on the default route, deliberately: keeping a hash-route reader alive is
 * keeping the ambiguity alive, and the rule above has to be true with no
 * exceptions to stay true at all.
 * -------------------------------------------------------------------------- */

export type Section = 'loop' | 'outreach' | 'money' | 'ledger' | 'setup';

export const SECTIONS: readonly Section[] = ['loop', 'outreach', 'money', 'ledger', 'setup'];

/**
 * Which second segments each section answers to. A segment that is not here --
 * a typo, a link to a screen that was removed, `/outreach/replies` when the
 * inbox lives at `/outreach/inbox` -- falls back to the section root rather
 * than rendering nothing.
 */
const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'campaigns', 'inbox', 'leads', 'manager', 'plan', 'queue'],
  money: [''],
  ledger: ['', 'run'],
  setup: ['', 'agent', 'data', 'reddit', 'research', 'seat', 'skills', 'limits', 'spend', 'team']
};

/**
 * First segments the SHELL owns that are not `Section`s.
 *
 * `leads` is the account spine, addressed beside the sections rather than
 * inside one (see `useAccountsRoute` in App.tsx). `login` is the auth screen,
 * which is a place you can be sent to -- from the marketing page, from an
 * expired session, from a link in an email -- and therefore an address.
 *
 * They are listed here because `isAppPath` is the single answer to "is this
 * URL ours", and both the click interceptor below and the server's fallback
 * have to give the same answer to the same path.
 */
const SHELL_PATHS: readonly string[] = ['leads', 'login'];

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
 * THE ONE ANSWER, asked by three callers that must agree: the click
 * interceptor (intercept, or let the browser navigate), `App.tsx`'s
 * shell-route readers, and -- restated in its own language, because it cannot
 * import this module -- the production server's fallback in
 * `src/server/index.ts`. A path the client claims and the server 404s is a
 * broken reload; a path the server serves the app for and the client does not
 * claim is a blank screen.
 *
 * Anything with a file extension is excluded on purpose: `/logo.svg` and
 * `/catalog/modules.json` are files, and a shipped document like `/privacy` is
 * excluded by not being in the lists above.
 */
export function isAppPath(pathname: string): boolean {
  const head = pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (!head) return true;
  if (head.includes('.')) return false;
  return (SECTIONS as readonly string[]).includes(head) || SHELL_PATHS.includes(head);
}

/** True for `/login`, the auth screen's own address. */
export const isLoginPath = (pathname: string): boolean => pathname === '/login' || pathname === '/login/';

/** True for `/leads` and `/leads/:id`, the account spine. See `useAccountsRoute`. */
export const isAccountsPath = (pathname: string): boolean => pathname === '/leads' || pathname.startsWith('/leads/');

export function parseRoute(pathname: string): Route {
  const raw = pathname.replace(/\/+$/, '');
  if (!raw || raw === '/') return DEFAULT;

  const [head, sub = '', ...rest] = raw.replace(/^\//, '').split('/').map((part) => decodeURIComponent(part));
  const section = (SECTIONS as readonly string[]).includes(head) ? head as Section : DEFAULT.section;
  if (!SUB_ROUTES[section].includes(sub)) return build(section, '', null);
  const id = rest.length > 0 && rest[0] ? rest.join('/') : null;
  // `/ledger/run` with no id names no run. Send it to the list it came from.
  if (sub === 'run' && !id) return build(section, '', null);
  return build(section, sub, id);
}

/* --------------------------------------------------------------------------
 * Moving between screens.
 * -------------------------------------------------------------------------- */

/** Everything currently listening for a route change, notified in one pass. */
const subscribers = new Set<() => void>();

function announce(): void {
  // A copy, because a subscriber is free to unsubscribe while being notified.
  for (const notify of [...subscribers]) notify();
}

/**
 * Go to a path, WITHOUT a page load.
 *
 * `pushState` rather than assigning `location`, so Back returns to the
 * previous screen instead of re-fetching the document -- the same history
 * behaviour the hash router had, for the same reason. `popstate` does not fire
 * for our own `pushState`, so subscribers are told directly.
 *
 * Exported as a plain function, not only as the hook's second return value:
 * the click interceptor and a handful of screens navigate from outside a
 * component that holds the hook.
 */
export function navigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.pathname + window.location.search === next) return;
  window.history.pushState(null, '', next);
  announce();
}

/**
 * ONE listener for every in-app link in the shell, so a link stays a link.
 *
 * The alternative was a `<Link>` component and 53 call sites that have to
 * remember to use it -- and one plain `<a href="/outreach">` added later would
 * silently reload the whole app, which is the kind of failure nobody reports
 * because it still works. This way an anchor is written the way anchors are
 * written, and the ones that name a screen are caught here.
 *
 * WHAT IS DELIBERATELY NOT INTERCEPTED, in order:
 *   * a modified click -- ctrl/cmd/shift/alt, or anything but the main button.
 *     "Open in a new tab" must open a new tab;
 *   * `target`, `download`, or an explicit `rel="external"`;
 *   * another origin;
 *   * A PURE FRAGMENT ON THIS PAGE -- `#approval`, `#hosted`. This is the rule
 *     at the top of the file being enforced: the browser owns scrolling and
 *     this router does not touch the fragment;
 *   * a path that is not the app's (`/privacy`, `/catalog/modules.json`).
 *
 * Capture phase, so a screen that calls `preventDefault` in its own handler
 * still wins -- it runs after this and the navigation has already happened,
 * which is the same order the hash router produced.
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
  // An anchor into the page we are already on. The browser scrolls; we do not
  // navigate, and we do not touch the fragment.
  if (url.hash && url.pathname === window.location.pathname) return;
  if (!isAppPath(url.pathname)) return;

  event.preventDefault();
  navigate(url.pathname + url.search);
}

/**
 * Where you are, and one function that moves you.
 *
 * The click interceptor is installed by the first mounted reader and removed
 * by the last, so a test that renders one screen gets the same behaviour the
 * shell has and nothing leaks between tests.
 */
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

/**
 * Subscribe to route changes without parsing one.
 *
 * For the two shell-level readers that ask a yes/no question of the URL --
 * "are we on the accounts spine", "are we on the login screen" -- and would
 * otherwise each need their own `popstate` wiring, which is how the hash
 * version ended up with three copies of the same listener.
 */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => (typeof window === 'undefined' ? '/' : window.location.pathname));
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
