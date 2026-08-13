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

const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'manager', 'campaigns', 'inbox', 'leads', 'plan', 'queue'],
  money: [''],
  ledger: ['', 'run'],
  setup: ['', 'agent', 'data', 'reddit', 'research', 'seat', 'skills', 'limits', 'spend']
};

export interface Route {
  section: Section;
  sub: string;
  id: string | null;
  path: string;
}

const DEFAULT: Route = { section: 'loop', sub: '', id: null, path: '/loop' };

const LEGACY_VIEWS: Record<string, string> = {
  approvals: '/money',
  activity: '/ledger',
  linkedin: '/outreach',
  integrations: '/setup',
  setup: '/setup'
};

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
    if (raw.includes('=')) {
      const params = new URLSearchParams(raw);
      const tab = params.get('li');
      const view = params.get('view');
      const mapped = (view === 'linkedin' && tab && LEGACY_TABS[tab]) || (view && LEGACY_VIEWS[view]);
      if (mapped) return parseRoute(mapped);
    }
    return DEFAULT;
  }

  const [head, sub = '', ...rest] = raw.slice(1).split('/').map((part) => decodeURIComponent(part));
  const section = (SECTIONS as readonly string[]).includes(head) ? head as Section : DEFAULT.section;
  if (!SUB_ROUTES[section].includes(sub)) return build(section, '', null);
  const id = rest.length > 0 && rest[0] ? rest.join('/') : null;
  if (sub === 'run' && !id) return build(section, '', null);
  return build(section, sub, id);
}

export function useHashRoute(): [Route, (path: string) => void] {
  const read = useCallback(() => parseRoute(window.location.hash), []);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const sync = () => {
      const next = read();
      setRoute(next);
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
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setRoute(parseRoute(`#${next}`));
  }, []);

  return [route, go];
}
