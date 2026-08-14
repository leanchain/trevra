import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, X } from 'lucide-react';

/* --------------------------------------------------------------------------
 * The behaviour `aria-modal="true"` promises.
 *
 * The attribute is a claim, not an implementation: it tells assistive tech
 * that everything behind this element is unreachable. Nothing in the DOM makes
 * that true on its own. `useDialog` is the part that makes it true -- focus
 * enters, focus stays, Escape leaves, focus goes back where it came from, and
 * the background leaves both the tab order and the accessibility tree.
 * -------------------------------------------------------------------------- */

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"])'
].join(',');

/** Tab stops that are actually on screen. A hidden control is not a stop. */
function tabStops(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((node) => node.getClientRects().length > 0);
}

/**
 * Make a dialog behave like one.
 *
 * Pass the ref of the element carrying `role="dialog"`. On mount it focuses the
 * dialog's own heading -- so the first thing announced is what this dialog is,
 * not whichever control happens to sit first -- traps Tab inside it, closes on
 * Escape, and on unmount hands focus back to whatever opened it.
 *
 * The background is switched off with `inert`, which removes it from the tab
 * order AND the accessibility tree in one attribute. A dialog rendered outside
 * `.app-shell` (via a portal, which is what `ConfirmDrawer` does) inerts the
 * shell itself; one still rendered inside it inerts every branch of the shell
 * except its own, because inerting an ancestor would inert the dialog too.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Headings are not focusable, so this one is made focusable programmatically
    // only -- `-1` keeps it out of the tab order it is about to trap.
    const heading = container.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? container;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });

    const shell = document.querySelector<HTMLElement>('.app-shell');
    const inerted: HTMLElement[] = [];
    const switchOff = (node: Element) => {
      if (!(node instanceof HTMLElement) || node.hasAttribute('inert') || node.contains(container)) return;
      node.setAttribute('inert', '');
      inerted.push(node);
    };
    if (shell) {
      if (shell.contains(container)) for (const child of Array.from(shell.children)) switchOff(child);
      else switchOff(shell);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const stops = tabStops(container);
      if (stops.length === 0) { event.preventDefault(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === heading) { event.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture, so Escape works while focus sits on the heading and cannot be
    // swallowed by anything inside the dialog.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      for (const node of inerted) node.removeAttribute('inert');
      // Back where they were: closing a dialog must never dump the caret at the
      // top of the document.
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [ref]);
}

/**
 * The red confirm button.
 *
 * `.primary-button` is green -- the colour of "go" -- and there is no
 * `.primary-button.danger` in styles.css. This is the one existing rule that
 * paints a filled destructive button. If a red primary variant lands, this is
 * the single line to change.
 */
const DANGER_BUTTON = 'li-danger-button';

export interface ConfirmDrawerProps {
  /** Names the thing about to happen, as a question. Never "Are you sure?". */
  title: string;
  /** What it costs and what cannot be got back. String or your own nodes. */
  body: ReactNode;
  /** Names the consequence: "Delete this policy". Never "Confirm" or "OK". */
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  /**
   * `danger` is red and means immediate and destructive. `caution` is the
   * agent's amber: a run doing what it was asked to do must not be dressed as
   * a failure, and asking it to stop is cooperative, not a break.
   */
  tone?: 'danger' | 'caution' | 'default';
  /** Adds a required textarea; its trimmed value is passed to `onConfirm`. */
  requireReason?: boolean;
  reasonLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** A failure from the confirmed call, shown without closing the drawer. */
  error?: string | null;
}

/**
 * Stop before the consequential thing -- applied to the human, not only to the
 * agent.
 *
 * Reuses the drawer chrome the product already has, so a confirmation is
 * visibly the same kind of moment as reviewing prepared work. It is a modal on
 * purpose and only for this purpose: an unrecoverable deletion is exactly the
 * case that earns interrupted, protected focus. Anything recoverable should
 * not be routed through here.
 */
export function ConfirmDrawer({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = 'default',
  requireReason = false,
  reasonLabel = 'Why?',
  cancelLabel = 'Cancel',
  busy = false,
  error = null
}: ConfirmDrawerProps) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState('');

  // A confirmation that vanishes mid-write would leave the operator unable to
  // tell whether it went through, so escape routes are shut while it runs.
  const cancel = () => { if (!busy) onCancel(); };
  useDialog(dialog, cancel);

  const missingReason = requireReason && reason.trim() === '';

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={cancel}>
      <section
        ref={dialog}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div><h3 id={titleId}>{title}</h3></div>
          <button className="icon-button" aria-label="Close without changing anything" disabled={busy} onClick={cancel}>
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          {typeof body === 'string' ? <p>{body}</p> : body}
          {requireReason && <label>
            {reasonLabel}
            <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="A line is enough." />
          </label>}
          {error && <div className="error-banner">{error}</div>}
        </div>
        <footer>
          <button className="secondary-button" disabled={busy} onClick={cancel}>{cancelLabel}</button>
          <button
            className={tone === 'danger' ? DANGER_BUTTON : tone === 'caution' ? 'ghost-button danger' : 'primary-button'}
            disabled={busy || missingReason}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy && <LoaderCircle className="spin" size={16} />}{confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
