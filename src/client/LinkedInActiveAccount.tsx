import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getLinkedInManagerSeats, type LinkedInSeat } from './api';
import { useOutreachRefresh } from './LinkedInSafety';

/**
 * The account key every workspace already has, and what an absent `seatKey`
 * means on every route in `api.ts`.
 *
 * Restated rather than imported: `OWNER_SEAT_KEY` lives in
 * `server/linkedin/seats.ts`, and importing a value from there would pull the
 * module -- and what it imports -- into the browser bundle for the sake of one
 * five-letter string.
 */
export const OWNER_ACCOUNT_KEY = 'owner';

const ACTIVE_ACCOUNT_STORAGE_KEY = 'trevra.linkedin.active-account';

/** Fired inside this browser tab whenever the user changes the active account. */
const ACTIVE_ACCOUNT_EVENT = 'trevra:linkedin-active-account';

/**
 * A name, mechanically reduced to a legal short key.
 *
 * Not a suggestion box's slugify -- it produces exactly what
 * `ACCOUNT_KEY_PATTERN` accepts, so the field it fills in never opens on a
 * value it would itself reject. Accents fold to plain letters first, because
 * "Priya" and "Priyá" naming the same person should not turn into two
 * different keys by accident of a keyboard.
 */
export function slugifyAccountKey(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function readActiveAccountKey(): string {
  try {
    return window.localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) || OWNER_ACCOUNT_KEY;
  } catch {
    // Storage refused (private mode, blocked cookies). The default is still an
    // answer, and it is the account every workspace has.
    return OWNER_ACCOUNT_KEY;
  }
}

/**
 * THE ACTIVE ACCOUNT ITSELF, held once for the whole tab.
 *
 * A module variable rather than a `useState` per caller, because a copy per
 * caller is not a source of truth: every screen reading this hook has to see
 * the same key at the same moment, and one value behind `useSyncExternalStore`
 * is React's own answer to exactly that -- it also rules out the torn render a
 * pile of independent `useState`s allows under concurrent rendering.
 *
 * `localStorage` is where the choice is REMEMBERED, not where each subscriber
 * reads it from on every wake-up. See `ACTIVE_ACCOUNT_EVENT` for why the
 * difference decides what happens when storage refuses the write.
 *
 * Null until first read, so importing this module touches no browser API.
 */
let activeAccountKey: string | null = null;

/** Every mounted `useActiveSeatKey`, notified in one pass on every change. */
const activeAccountSubscribers = new Set<() => void>();

/**
 * The snapshot `useSyncExternalStore` compares between renders, so it has to be
 * the SAME string until something actually changes it -- never a fresh read of
 * storage, which would make every render a new snapshot and loop forever.
 */
function activeAccountSnapshot(): string {
  if (activeAccountKey === null) activeAccountKey = readActiveAccountKey();
  return activeAccountKey;
}

/** Update the one active account value shared by every Outreach screen in this tab. */
function adoptActiveAccountKey(next: string): void {
  if (!next || activeAccountKey === next) return;
  activeAccountKey = next;
  for (const notify of [...activeAccountSubscribers]) notify();
}

const followActiveAccountEvent = (event: Event) => {
  const detail = (event as CustomEvent<string>).detail;
  if (typeof detail === 'string') adoptActiveAccountKey(detail);
};

/**
 * Components in this tab subscribe to one in-memory value. We intentionally do
 * not listen to the browser `storage` event: another open tab must not be able
 * to change the account underneath the tab the user is actively working in.
 */
function subscribeToActiveAccount(notify: () => void): () => void {
  if (activeAccountSubscribers.size === 0) {
    window.addEventListener(ACTIVE_ACCOUNT_EVENT, followActiveAccountEvent);
  }
  activeAccountSubscribers.add(notify);
  return () => {
    activeAccountSubscribers.delete(notify);
    if (activeAccountSubscribers.size === 0) {
      window.removeEventListener(ACTIVE_ACCOUNT_EVENT, followActiveAccountEvent);
    }
  };
}

/** Switch every Outreach screen in this tab to the account the user chose. */
export function setActiveSeatKey(next: string): void {
  try {
    window.localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, next);
  } catch {
    /* Not remembered across reloads. The choice still holds for every screen in this tab, which is what the line below guarantees. */
  }
  adoptActiveAccountKey(next);
  window.dispatchEvent(new CustomEvent<string>(ACTIVE_ACCOUNT_EVENT, { detail: next }));
}

/**
 * The account every Outreach screen in this browser tab should read.
 * `localStorage` remembers it across reloads; the in-memory store keeps mounted
 * components in this tab in sync. Other browser tabs deliberately do not drive it.
 */
export function useActiveSeatKey(): [string, (key: string) => void] {
  const key = useSyncExternalStore(
    subscribeToActiveAccount,
    activeAccountSnapshot,
    activeAccountSnapshot
  );
  return [key, setActiveSeatKey];
}

/** Compact read-only account context for the app header. Selection still lives in Setup → Workspace. */
export function ActiveLinkedInAccountName() {
  const [seatKey] = useActiveSeatKey();
  const [accounts, setAccounts] = useState<LinkedInSeat[] | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await getLinkedInManagerSeats());
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOutreachRefresh(load);

  const active = accounts?.find((account) => account.seatKey === seatKey) ?? null;
  const label =
    active?.label ??
    (accounts === null ? 'Loading…' : accounts.length === 0 ? 'No LinkedIn account' : seatKey);
  return <span>{label}</span>;
}
