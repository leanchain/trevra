import type { ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export type FormGridLayout = 'single' | 'split' | 'wide-narrow' | 'triple';

export function FormSection({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classes('ui-form-section', className)}>
      {(title || description || actions) && (
        <header className="ui-form-section-head">
          <div>
            {title ? <h4>{title}</h4> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="ui-form-section-actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

export function FormGrid({
  layout = 'single',
  children,
  className
}: {
  layout?: FormGridLayout;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('ui-form-grid', className)} data-layout={layout}>
      {children}
    </div>
  );
}

export function ActionRow({
  children,
  note,
  className
}: {
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('ui-action-row', className)}>
      {note ? <div className="ui-action-note">{note}</div> : <span />}
      <div className="ui-action-buttons">{children}</div>
    </div>
  );
}
