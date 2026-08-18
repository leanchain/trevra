import { useEffect, useRef, type RefObject } from 'react';

/* --------------------------------------------------------------------------
 * Keyboard shortcuts.
 *
 * Two rules, and everything here follows from them.
 *
 * 1. NO SHORTCUT STEALS A KEY A TEXT FIELD NEEDS. A bare letter is a
 *    character somewhere -- the campaign name, the standing job, the reason
 *    you are stopping a seat -- so every unmodified binding is dropped while
 *    focus is in a field. Modified bindings (Cmd/Ctrl) are not: they are not
 *    characters anywhere.
 * 2. EVERY SHORTCUT IS DISCOVERABLE FROM THE SHEET. `?` opens the list, the
 *    list is the only place bindings are written down, and a binding that is
 *    not on it does not exist.
 * -------------------------------------------------------------------------- */

/**
 * With the caret outside every list, the first list on the page is the one
 * `j` starts in.
 *
 * Peers are the lists that ACTUALLY BOUND THE KEY, marked as they arm. Matching
 * on the container's class name instead handed the key to whichever list came
 * first in the DOM even when that list was too short to bind it, which is how
 * `j` came to do nothing at all on a screen holding three lists.
 */
function ownsTheKey(root: HTMLElement): boolean {
  const peers = Array.from(document.querySelectorAll<HTMLElement>('[data-list-keys="on"]'));
  if (peers.length <= 1) return true;
  const owner = peers.find(
    (peer) => document.activeElement instanceof Node && peer.contains(document.activeElement)
  );
  return owner ? owner === root : peers[0] === root;
}

/** Is the caret somewhere a letter means a letter? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface ShortcutHandlers {
  /** Cmd/Ctrl+K -- jump to a screen. */
  onJump: () => void;
  /** `?` -- the sheet listing every one of these. */
  onSheet: () => void;
  /** True while a dialog owns the keyboard; every binding stands down. */
  suspended: boolean;
}

export function useShortcuts({ onJump, onSheet, suspended }: ShortcutHandlers): void {
  // Held in a ref so a caller may pass fresh closures every render -- which is
  // what an arrow function in JSX is -- without re-arming the listener.
  const handlers = useRef({ onJump, onSheet });
  handlers.current = { onJump, onSheet };

  useEffect(() => {
    if (suspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        handlers.current.onJump();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        handlers.current.onSheet();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [suspended]);
}

/**
 * `j` and `k` down and up a list.
 *
 * They move real focus onto the row rather than painting a private highlight,
 * so the caret a screen reader follows and the caret the eye follows are the
 * same one, and Tab carries on from wherever j left off.
 *
 * ONE LIST ACTS PER KEYPRESS. If several lists are mounted, whichever already
 * holds the caret owns the key; if none does, the first one in the document does.
 */
export function useListKeys(
  container: RefObject<HTMLElement | null>,
  selector: string,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) return;
    const armed = container.current;
    // Declares this list as one of the peers `ownsTheKey` chooses between.
    if (armed) armed.dataset.listKeys = 'on';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      if (isTypingTarget(event.target)) return;
      const root = container.current;
      if (!root) return;
      const rows = Array.from(root.querySelectorAll<HTMLElement>(selector));
      if (rows.length === 0) return;
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (!inside && !ownsTheKey(root)) return;
      event.preventDefault();
      const current = rows.findIndex(
        (row) => row === active || (active instanceof Node && row.contains(active))
      );
      const step = event.key === 'j' ? 1 : -1;
      const next =
        current === -1
          ? step === 1
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, current + step));
      const row = rows[next];
      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
      row.focus({ preventScroll: false });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (armed) delete armed.dataset.listKeys;
    };
  }, [container, selector, enabled]);
}
