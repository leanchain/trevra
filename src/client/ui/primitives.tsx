import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ChangeEventHandler,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className, type = 'button', ...props },
  ref
) {
  const variantClass =
    variant === 'primary'
      ? 'primary-button'
      : variant === 'ghost'
        ? 'ghost-button'
        : variant === 'danger'
          ? 'secondary-button is-danger'
          : 'secondary-button';

  return (
    <button
      ref={ref}
      type={type}
      className={classes('ui-button', variantClass, className)}
      {...props}
    />
  );
});

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, className, children }: FieldProps) {
  return (
    <label className={classes('ui-field', className)}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint ? <small className="ui-field-hint">{hint}</small> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={classes('ui-control', className)} {...props} />;
  }
);

type OptionElementProps = {
  value?: string | number | readonly string[];
  disabled?: boolean;
  children?: ReactNode;
  label?: string;
};

type OptGroupElementProps = {
  label?: string;
  disabled?: boolean;
  children?: ReactNode;
};

type SelectOption = {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
  group?: string;
};

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  return Children.toArray(node).map(nodeText).join(' ').replace(/\s+/g, ' ').trim();
}

function optionList(children: ReactNode, group?: string, groupDisabled = false): SelectOption[] {
  const options: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === 'option') {
      const props = (child as ReactElement<OptionElementProps>).props;
      const text = props.label || nodeText(props.children);
      const raw = Array.isArray(props.value) ? props.value[0] : props.value;
      options.push({
        value: raw === undefined ? text : String(raw),
        label: props.children ?? props.label ?? '',
        text,
        disabled: groupDisabled || props.disabled === true,
        group
      });
      return;
    }
    if (child.type === 'optgroup') {
      const props = (child as ReactElement<OptGroupElementProps>).props;
      options.push(
        ...optionList(props.children, props.label, groupDisabled || props.disabled === true)
      );
    }
  });
  return options;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'children' | 'defaultValue' | 'onChange' | 'size' | 'value'
> {
  children?: ReactNode;
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  onChange?: ChangeEventHandler<HTMLSelectElement>;
}

type SelectPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

function selectValues(value: string | number | readonly string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined) return [];
  return [String(value)];
}

/**
 * Trevra's dropdown/listbox.
 *
 * Call sites keep native-select ergonomics (`value`, `onChange`, `<option>`,
 * and `multiple`) while the visible interaction is Trevra-owned rather than
 * OS/browser chrome.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    className,
    children,
    value,
    defaultValue,
    onChange,
    multiple = false,
    disabled = false,
    id,
    name,
    title,
    autoFocus,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid
  },
  forwardedRef
) {
  const options = useMemo(() => optionList(children), [children]);
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState<string | string[]>(() =>
    multiple
      ? selectValues(defaultValue)
      : String(
          (Array.isArray(defaultValue) ? defaultValue[0] : defaultValue) ?? options[0]?.value ?? ''
        )
  );
  const currentValues = multiple
    ? selectValues(controlled ? value : (internalValue as string[]))
    : [
        controlled
          ? String(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''))
          : String(internalValue ?? '')
      ];
  const selectedSet = new Set(currentValues);
  const selected = options.find((option) => selectedSet.has(option.value)) ?? options[0] ?? null;
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const triggerLabel = multiple
    ? selectedOptions.length === 0
      ? 'None selected'
      : selectedOptions.length === 1
        ? selectedOptions[0]?.label
        : `${selectedOptions.length} selected`
    : (selected?.label ?? 'Select…');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<SelectPosition | null>(null);

  const setTriggerRef = (node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };

  const placeMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const edge = 10;
    const width = Math.min(Math.max(rect.width, 180), Math.max(180, window.innerWidth - edge * 2));
    const left = Math.min(
      Math.max(edge, rect.left),
      Math.max(edge, window.innerWidth - width - edge)
    );
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
    const above = Math.max(0, rect.top - gap - edge);
    const preferBelow = below >= 220 || below >= above;
    setPosition(
      preferBelow
        ? { left, width, top: rect.bottom + gap, maxHeight: Math.min(320, below) }
        : {
            left,
            width,
            bottom: window.innerHeight - rect.top + gap,
            maxHeight: Math.min(320, above)
          }
    );
  };

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    placeMenu();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    placeMenu();
    requestAnimationFrame(() => {
      const selectedOption = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]:not(:disabled)'
      );
      const first = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="option"]:not(:disabled)'
      );
      (selectedOption ?? first)?.focus();
    });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const closeForViewportChange = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', closeForViewportChange);
    window.addEventListener('scroll', closeForViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeForViewportChange);
      window.removeEventListener('scroll', closeForViewportChange, true);
    };
  }, [open]);

  const emitChange = (nextValues: string[]) => {
    const fakeSelectedOptions = nextValues.map((entry) => ({ value: entry }));
    const target = {
      value: nextValues[0] ?? '',
      name: name ?? '',
      multiple,
      selectedOptions: fakeSelectedOptions
    } as unknown as HTMLSelectElement;
    onChange?.({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
  };

  const choose = (nextValue: string) => {
    const option = options.find((entry) => entry.value === nextValue);
    if (!option || option.disabled) return;

    if (multiple) {
      const next = selectedSet.has(nextValue)
        ? currentValues.filter((entry) => entry !== nextValue)
        : [...currentValues, nextValue];
      if (!controlled) setInternalValue(next);
      emitChange(next);
      return;
    }

    if (!controlled) setInternalValue(nextValue);
    emitChange([nextValue]);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const menu =
    open && position
      ? createPortal(
          <div
            className="ui-select-popover"
            role="listbox"
            aria-multiselectable={multiple || undefined}
            aria-label={ariaLabel || title || 'Choose an option'}
            ref={menuRef}
            style={{
              left: position.left,
              width: position.width,
              top: position.top,
              bottom: position.bottom,
              maxHeight: position.maxHeight
            }}
            onKeyDown={(event) => {
              const buttons = [
                ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="option"]:not(:disabled)'
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
              } else if (event.key === 'Tab') {
                setOpen(false);
              }
            }}
          >
            {options.map((option, index) => {
              const priorGroup = index > 0 ? options[index - 1]?.group : undefined;
              const showGroup = option.group && option.group !== priorGroup;
              const active = selectedSet.has(option.value);
              return (
                <Fragment key={`${option.group ?? ''}:${option.value}:${index}`}>
                  {showGroup ? <div className="ui-select-group-label">{option.group}</div> : null}
                  <button
                    type="button"
                    className="ui-select-option"
                    role="option"
                    aria-selected={active}
                    disabled={option.disabled}
                    onClick={() => choose(option.value)}
                  >
                    <span>{option.label}</span>
                    {active ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                </Fragment>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div className={classes('ui-select-shell', className)} data-open={open || undefined}>
      {name ? (
        multiple ? (
          currentValues.map((entry) => (
            <input key={entry} type="hidden" name={name} value={entry} />
          ))
        ) : (
          <input type="hidden" name={name} value={currentValues[0] ?? ''} />
        )
      ) : null}
      <button
        ref={setTriggerRef}
        type="button"
        id={id}
        className="ui-control ui-select-trigger"
        disabled={disabled}
        title={title}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (
            event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Enter' ||
            event.key === ' '
          ) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="ui-select-trigger-value">{triggerLabel}</span>
        <ChevronDown className="ui-select-chevron" size={16} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={classes('ui-control', 'ui-textarea', className)} {...props} />
  );
});

export interface SwitchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function SwitchField({ label, description, className, ...props }: SwitchFieldProps) {
  return (
    <label className={classes('ui-switch-field', className)}>
      <span className="ui-switch-copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="toggle ui-switch-control">
        <input type="checkbox" {...props} />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}
