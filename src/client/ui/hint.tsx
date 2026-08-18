import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * The (i) that carries an explanation off the surface and onto a click, a tap
 * or a keyboard focus -- so a screen can lead with the number and the verdict
 * and keep the reasoning one interaction away instead of always in the way.
 *
 * NEVER FOR A CONFIDENCE TAG OR A NEW TERM. `ConfidenceTag` and `Define` in
 * LinkedInViz.tsx exist because a REPORTED number or a word like "band
 * ceiling" is exactly the kind of thing that file argues must not be hidden
 * behind a hover: an operator betting a real LinkedIn account on it needs it
 * rendered, not hovered. What belongs behind this trigger is the rationale
 * underneath a fact that is already on screen -- why a number is what it is --
 * never the fact, the tag, or the term itself.
 *
 * Opens on hover, on keyboard focus, and on click or tap -- so it works for a
 * mouse, a keyboard and a touch screen alike -- and closes on Escape or a
 * click outside. The content stays in the DOM at all times, only visually
 * hidden, so `aria-describedby` still reaches it for a screen reader that
 * never hovers or clicks anything.
 */
export function Hint({ label, trigger, children, align }: {
  /** The trigger's accessible name. Ignored when `trigger` supplies its own visible text. */
  label: string;
  /** Swaps the bare (i) for a labelled trigger -- a standalone "How this works" row, say. */
  trigger?: ReactNode;
  children: ReactNode;
  /** Which edge the popover hangs from. Defaults to the left; use `right` near a panel's right edge. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const popId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <span
    className={`li-hint-wrap${open ? ' is-open' : ''}${align === 'right' ? ' li-hint-right' : ''}`}
    ref={wrapRef}
  >
    <button
      type="button"
      className={`li-hint-btn${trigger ? ' li-hint-btn-labelled' : ''}`}
      aria-label={trigger ? undefined : label}
      aria-expanded={open}
      aria-describedby={popId}
      onClick={() => setOpen((value) => !value)}
    >
      {trigger ?? <Info size={12} aria-hidden="true" />}
    </button>
    <span className="li-hint-pop" role="note" id={popId}>{children}</span>
  </span>;
}
