import { useEffect, useRef } from 'react';

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

/** Is the caret somewhere a letter means a letter? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface ShortcutHandlers {
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
