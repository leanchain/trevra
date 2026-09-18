import { useEffect, useState } from 'react';
import { BadgeDollarSign, Boxes, Gauge, ReceiptText } from 'lucide-react';
import { getBillingSnapshot, type BillingSnapshot } from './api';
import { EmptyState, PageGrid, Panel } from './ui/layout';

function credits(value: string | number): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(parsed);
}

function statusLabel(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function BillingSettings() {
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getBillingSnapshot()
      .then((next) => {
        if (!live) return;
        setSnapshot(next);
        setError('');
      })
      .catch((caught) => {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : 'Unable to read billing state.');
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <PageGrid columns={1}>
        <Panel
          title="Billing"
          description="Commercial state for this workspace is owned by the shared Olaryn Billing service."
          icon={<BadgeDollarSign size={18} />}
        >
          <EmptyState title="Billing unavailable" description={error} />
        </Panel>
      </PageGrid>
    );
  }

  if (!snapshot) {
    return (
      <PageGrid columns={1}>
        <Panel
          title="Billing"
          description="Commercial state for this workspace is owned by the shared Olaryn Billing service."
          icon={<BadgeDollarSign size={18} />}
        >
          <p className="empty-copy">Reading workspace billing…</p>
        </Panel>
      </PageGrid>
    );
  }

  if (!snapshot.enabled) {
    return (
      <PageGrid columns={1}>
        <Panel
          title="Billing"
          description="Commercial state for this workspace is owned by the shared Olaryn Billing service."
          icon={<BadgeDollarSign size={18} />}
        >
          <EmptyState
            title="Billing is not configured"
            description="This deployment is running without the shared Billing service. That is supported for local and self-hosted development; hosted Trevra requires Billing."
          />
        </Panel>
      </PageGrid>
    );
  }

  const featureCount = Object.keys(snapshot.entitlements.features).length;
  const plan = snapshot.subscription.plan_code ?? snapshot.customer.plan_code;
  const subscriptionStatus = snapshot.subscription.status || 'inactive';

  return (
    <PageGrid columns={1}>
      <Panel
        title="Billing"
        description="Stripe money state and OpenMeter access state are presented through one workspace-scoped Billing API."
        icon={<BadgeDollarSign size={18} />}
        actions={<span className="status-pill">{statusLabel(subscriptionStatus)}</span>}
      >
        <div className="metrics-grid metrics-grid-four">
          <div className="metric-card">
            <span className="metric-icon">
              <ReceiptText />
            </span>
            <div>
              <p>Plan</p>
              <strong>{plan ?? 'Not configured'}</strong>
              <span>{snapshot.customer.currency}</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <Gauge />
            </span>
            <div>
              <p>Available credits</p>
              <strong>{credits(snapshot.credits.available)}</strong>
              <span>{credits(snapshot.credits.usage)} used</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <Boxes />
            </span>
            <div>
              <p>Entitlements</p>
              <strong>{featureCount}</strong>
              <span>{featureCount === 1 ? 'feature' : 'features'}</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <BadgeDollarSign />
            </span>
            <div>
              <p>Stripe customer</p>
              <strong>{snapshot.customer.stripe_customer_id ? 'Created' : 'Not needed yet'}</strong>
              <span>Created lazily at paid checkout</span>
            </div>
          </div>
        </div>

        {plan ? (
          <p className="panel-note">
            Billing is scoped to this workspace. Plan changes, credit purchases, and
            payment-provider actions remain disabled in Trevra until its commercial catalog is
            finalized.
          </p>
        ) : (
          <p className="panel-note">
            Trevra has no published commercial plan yet. The workspace is provisioned in Billing so
            pricing can be enabled later without changing identity or tenant boundaries.
          </p>
        )}
      </Panel>
    </PageGrid>
  );
}
