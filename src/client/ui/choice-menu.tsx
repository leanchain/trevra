import { useEffect, useRef, useState } from 'react';
import { Check, Pencil } from 'lucide-react';

export interface ChoiceMenuItem {
  id: string;
  label: string;
  description?: string;
}

export function ChoiceMenu({
  label,
  title,
  items,
  selectedId,
  disabled = false,
  onChoose
}: {
  label: string;
  title: string;
  items: readonly ChoiceMenuItem[];
  selectedId?: string | null;
  disabled?: boolean;
  onChoose: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const buttons =
        popoverRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) return;
      const selected = popoverRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-checked="true"]'
      );
      (selected ?? buttons[0]).focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="li-choice-menu" ref={rootRef}>
      <button
        className="li-edit-icon"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Pencil size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="li-choice-menu-popover"
          role="menu"
          aria-label={title}
          ref={popoverRef}
          onKeyDown={(event) => {
            const buttons = [
              ...(popoverRef.current?.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)'
              ) ?? [])
            ];
            if (!buttons.length) return;
            const at = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              buttons[(at + delta + buttons.length) % buttons.length]?.focus();
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
            }
          }}
        >
          <div className="li-choice-menu-title">{title}</div>
          <div className="li-choice-menu-items">
            {items.map((item) => {
              const selected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={selected ? 'is-selected' : undefined}
                  onClick={() => {
                    setOpen(false);
                    void onChoose(item.id);
                  }}
                >
                  <span className="li-choice-menu-copy">
                    <strong>{item.label}</strong>
                    {item.description && <small>{item.description}</small>}
                  </span>
                  {selected && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
