import { useCallback, useEffect, useState } from 'react';

/* --------------------------------------------------------------------------
 * The route, as one string.
 *
 * `useHashView` (ui/dialog.tsx) reads the hash as an independent parameter
 * list -- `#view=approvals&li=setup` -- so two screens could each own a key
 * without knowing about the other. That was the right shape for two
 * independent tab strips and the wrong shape for a nav: every key any screen
 * ever set survived every navigation away from it, which is exactly the leak
 * `#view=approvals&li=setup` is. Leaving Approvals never cleared `li`.
 *
 * The loop shell has ONE thing in the hash: where you are. So the hash is a
 * path -- `#/ledger/run/abc` -- assigned whole on every navigation, and a
 * stale sibling key is not a bug to be fixed but a state that cannot be
 * reached. `useHashView` stays exported and untouched for screens that still
 * hold their own sub-state.
 *
 * Anything that is not a path -- `#get-started`, `#main`, a link out of the
 * marketing site -- parses to the default route and is NOT rewritten, so the
 * mount-time `#get-started` check still sees it.
 * -------------------------------------------------------------------------- */

export type Section = 'loop' | 'outreach' | 'money' | 'ledger' | 'setup';

export const SECTIONS: readonly Section[] = ['loop', 'outreach', 'money', 'ledger', 'setup'];

/**
 * Which second segments each section answers to. A segment that is not here --
 * a typo, a link to a screen that was removed, `#/outreach/replies` when the
 * inbox lives at `#/outreach/inbox` -- falls back to the section root rather
 * than rendering nothing.
 */
const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'campaigns', 'inbox', 'leads', 'plan', 'queue'],
  money: [''],
  ledger: ['', 'run'],
  setup: ['', 'agent', 'data', 'reddit', 'research', 'seat', 'skills', 'limits', 'spend']
};

export interface Route {
  section: Section;
  /** The second segment, or '' for the section root. */
  sub: string;
  /** The third segment of a deep link -- `#/ledger/run/:id` -- or null. */
  id: string | null;
  /** The normalised path, `/ledger/run/abc`. Stable enough to key effects on. */
  path: string;
}

const DEFAULT: Route = { section: 'loop', sub: '', id: null, path: '/loop' };

/**
 * The four-view hash this replaces, so a bookmark or a link a teammate was
 * sent in the last release still lands somewhere true.
 */
const LEGACY_VIEWS: Record<string, string> = {
  approvals: '/money',
  activity: '/ledger',
  linkedin: '/outreach',
  integrations: '/setup',
  setup: '/setup'
};

/** And the seven LinkedIn tabs, two of which moved out of Outreach entirely. */
const LEGACY_TABS: Record<string, string> = {
  safety: '/outreach',
  campaigns: '/outreach/campaigns',
  plan: '/outreach/plan',
  queue: '/outreach/queue',
  analytics: '/outreach/campaigns',
  setup: '/setup/seat',
  exclusions: '/setup/limits'
};

function build(section: Section, sub: string, id: string | null): Route {
  const path = `/${section}${sub ? `/${sub}` : ''}${id ? `/${id}` : ''}`;
  return { section, sub, id, path };
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  if (!raw) return DEFAULT;

  if (!raw.startsWith('/')) {
    // A parameter-list hash from the previous shell. Read it once, on the way
    // in; nothing writes this shape any more.
    if (raw.includes('=')) {
      const params = new URLSearchParams(raw);
      const tab = params.get('li');
      const view = params.get('view');
      const mapped = (view === 'linkedin' && tab && LEGACY_TABS[tab]) || (view && LEGACY_VIEWS[view]);
      if (mapped) return parseRoute(mapped);
    }
    // `#get-started`, `#main`, an anchor from somewhere else. Not a route.
    return DEFAULT;
  }

  const [head, sub = '', ...rest] = raw.slice(1).split('/').map((part) => decodeURIComponent(part));
  const section = (SECTIONS as readonly string[]).includes(head) ? head as Section : DEFAULT.section;
  if (!SUB_ROUTES[section].includes(sub)) return build(section, '', null);
  const id = rest.length > 0 && rest[0] ? rest.join('/') : null;
  // `#/ledger/run` with no id names no run. Send it to the list it came from.
  if (sub === 'run' && !id) return build(section, '', null);
  return build(section, sub, id);
}

/**
 * Where you are, and one function that moves you.
 *
 * Assigning `location.hash` pushes a real history entry, so Back returns to
 * the previous screen rather than leaving the app -- the same reason
 * `useHashView` assigns rather than replaces.
 */
export function useHashRoute(): [Route, (path: string) => void] {
  const read = useCallback(() => parseRoute(window.location.hash), []);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const sync = () => {
      const next = read();
      setRoute(next);
      // A parameter-list hash is read once and then REWRITTEN, so the address
      // bar names the screen you are actually on and a copied link carries the
      // shape this shell writes. `replaceState`, not an assignment: the old URL
      // is not a place to go Back to.
      const raw = window.location.hash.replace(/^#/, '');
      if (raw && !raw.startsWith('/') && raw.includes('=')) {
        window.history.replaceState(null, '', `#${next.path}`);
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [read]);

  const go = useCallback((path: string) => {
    const next = path.startsWith('/') ? path : `/${path}`;
    // The whole hash, every time. There is no second key to leave behind.
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setRoute(parseRoute(`#${next}`));
  }, []);

  return [route, go];
}
