import type { ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function FilterToolbar({
  children,
  leading,
  summary,
  actions,
  className,
  density = 'default'
}: {
  children: ReactNode;
  leading?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
  density?: 'default' | 'compact';
}) {
  return (
    <div
      className={classes('ui-filter-toolbar', className)}
      data-density={density}
      data-has-leading={leading ? 'true' : undefined}
    >
      {leading ? <div className="ui-filter-leading">{leading}</div> : null}
      <div className="ui-filter-groups">{children}</div>
      {(summary || actions) && (
        <div className="ui-filter-meta">
          {summary ? <span className="ui-filter-summary">{summary}</span> : null}
          {actions ? <div className="ui-filter-actions">{actions}</div> : null}
        </div>
      )}
    </div>
  );
}

export function FilterGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="ui-filter-group">
      <span className="ui-filter-label">{label}</span>
      {children}
    </label>
  );
}
