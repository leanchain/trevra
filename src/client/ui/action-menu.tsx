import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';

export interface ActionMenuItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void | Promise<void>;
}

export function ActionMenu({
  label,
  items,
  compact = false
}: {
  label: string;
  items: readonly ActionMenuItem[];
  compact?: boolean;
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
    <div className={`li-action-menu${compact ? ' is-compact' : ''}`} ref={rootRef}>
      <button
        className="li-action-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreVertical size={compact ? 16 : 18} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="li-action-menu-popover"
          role="menu"
          aria-label={label}
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
          {items.map((item) => (
            <button
              key={item.label}
              className={item.danger ? 'is-danger' : undefined}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                void item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
