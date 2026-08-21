import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';

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

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <select ref={ref} className={classes('ui-control', 'ui-select', className)} {...props} />
    );
  }
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={classes('ui-control', 'ui-textarea', className)} {...props} />
  );
});
