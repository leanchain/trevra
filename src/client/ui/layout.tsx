import type { HTMLAttributes, ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function PageGrid({
  children,
  className,
  columns = 2
}: {
  children: ReactNode;
  className?: string;
  columns?: 1 | 2;
}) {
  return (
    <div className={classes('ui-page-grid', className)} data-columns={columns}>
      {children}
    </div>
  );
}

export function GridSpan({
  children,
  className,
  full = false
}: {
  children: ReactNode;
  className?: string;
  full?: boolean;
}) {
  return <div className={classes('ui-grid-span', full && 'is-full', className)}>{children}</div>;
}

export function Panel({
  title,
  description,
  icon,
  actions,
  children,
  className,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={classes('ui-panel', className)} {...props}>
      <PanelHeader title={title} description={description} icon={icon} actions={actions} />
      {children ? <div className="ui-panel-body">{children}</div> : null}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  icon,
  actions
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-panel-header">
      <div className="ui-panel-heading">
        {icon ? <span className="ui-panel-icon">{icon}</span> : null}
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="ui-panel-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className
}: {
  title?: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('ui-empty-state', className)}>
      {icon ? <span className="ui-empty-icon">{icon}</span> : null}
      <div className="ui-empty-copy">
        {title ? <strong>{title}</strong> : null}
        <p>{description}</p>
      </div>
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}

export function InlineActions({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={classes('ui-inline-actions', className)}>{children}</div>;
}
