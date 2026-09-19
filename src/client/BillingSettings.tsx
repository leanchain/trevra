import { useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign, Boxes, Gauge, ReceiptText } from 'lucide-react';
import {
  getBillingPlans,
  getBillingSnapshot,
  startBillingCheckout,
  type BillingPlan,
  type BillingSnapshot
} from './api';
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

function money(plan: BillingPlan): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: plan.currency,
    maximumFractionDigits: 0
  }).format(Number(plan.amount));
}

function tierRank(tier: string): number {
  return ['starter', 'growth', 'scale'].indexOf(tier);
}

export function BillingSettings() {
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [error, setError] = useState('');
  const [busyPlan, setBusyPlan] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([getBillingSnapshot(), getBillingPlans()])
      .then(([nextSnapshot, nextPlans]) => {
        if (!live) return;
        setSnapshot(nextSnapshot);
        setPlans(nextPlans.plans);
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

  const planRows = useMemo(() => {
    const monthly = plans
      .filter((plan) => plan.interval === 'monthly')
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    return monthly.map((plan) => ({
      monthly: plan,
      yearly: plans.find(
        (candidate) => candidate.tier === plan.tier && candidate.interval === 'yearly'
      )
    }));
  }, [plans]);

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
            description="This deployment is running without the shared Billing service. Billing remains optional until the hosted commercial stack is enabled."
          />
        </Panel>
      </PageGrid>
    );
  }

  const featureCount = Object.keys(snapshot.entitlements.features).length;
  const currentPlan = snapshot.subscription.plan_code ?? snapshot.customer.plan_code;
  const subscriptionStatus = snapshot.subscription.status || 'inactive';
  const query = new URLSearchParams(window.location.search);
  const checkoutState = query.get('checkout');
  const requestedPlan = query.get('plan');

  const choosePlan = async (plan: BillingPlan) => {
    setBusyPlan(plan.plan_code);
    setError('');
    try {
      const checkout = await startBillingCheckout(plan.plan_code);
      if (checkout.url) {
        window.location.assign(checkout.url);
        return;
      }
      setError(checkout.message || 'Billing did not return a checkout URL.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start checkout.');
    } finally {
      setBusyPlan('');
    }
  };

  return (
    <PageGrid columns={1}>
      <Panel
        title="Billing"
        description="Stripe money state and OpenMeter access state are presented through one workspace-scoped Billing API."
        icon={<BadgeDollarSign size={18} />}
        actions={<span className="status-pill">{statusLabel(subscriptionStatus)}</span>}
      >
        {checkoutState === 'success' && (
          <p className="panel-note">
            Checkout completed. Stripe confirmation can take a moment to update the subscription and
            credit balance.
          </p>
        )}
        {checkoutState === 'cancelled' && (
          <p className="panel-note">Checkout was cancelled. Nothing changed.</p>
        )}

        <div className="metrics-grid metrics-grid-four">
          <div className="metric-card">
            <span className="metric-icon">
              <ReceiptText />
            </span>
            <div>
              <p>Plan</p>
              <strong>{currentPlan ? statusLabel(currentPlan) : 'No plan'}</strong>
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
      </Panel>

      <Panel
        title="Preview pricing"
        description="Temporary Trevra pricing to exercise the complete catalog, checkout, subscription, credit, and entitlement loop."
        icon={<ReceiptText size={18} />}
        actions={<span className="status-pill">Preview</span>}
      >
        {planRows.length === 0 ? (
          <EmptyState
            title="No plans published"
            description="The shared Billing service did not return a Trevra catalog."
          />
        ) : (
          <div className="billing-plan-grid">
            {planRows.map(({ monthly, yearly }) => {
              const isCurrent =
                currentPlan === monthly.plan_code || currentPlan === yearly?.plan_code;
              const isRequested =
                requestedPlan === monthly.plan_code || requestedPlan === yearly?.plan_code;
              return (
                <article
                  className={`billing-plan-card${isRequested ? ' billing-plan-card-selected' : ''}`}
                  key={monthly.tier}
                >
                  <div>
                    <p className="eyebrow">{monthly.name}</p>
                    <strong className="billing-plan-price">
                      {money(monthly)}
                      <span>/month</span>
                    </strong>
                    {isRequested && <p className="billing-plan-requested">Selected from pricing</p>}
                    {yearly && (
                      <p className="billing-plan-annual">
                        {money(yearly)}/year · save{' '}
                        {Math.round(
                          100 - (Number(yearly.amount) / (Number(monthly.amount) * 12)) * 100
                        )}
                        %
                      </p>
                    )}
                  </div>
                  <p>{credits(monthly.monthly_credits)} credits per month</p>
                  <div className="billing-plan-actions">
                    <button
                      className={monthly.tier === 'growth' ? 'primary-button' : 'secondary-button'}
                      disabled={Boolean(currentPlan) || busyPlan !== ''}
                      onClick={() => void choosePlan(monthly)}
                    >
                      {isCurrent
                        ? 'Current plan'
                        : currentPlan
                          ? 'Plan changes coming soon'
                          : busyPlan === monthly.plan_code
                            ? 'Opening checkout…'
                            : 'Choose monthly'}
                    </button>
                    {yearly && !currentPlan && (
                      <button
                        className="ghost-button"
                        disabled={busyPlan !== ''}
                        onClick={() => void choosePlan(yearly)}
                      >
                        {busyPlan === yearly.plan_code ? 'Opening checkout…' : 'Choose yearly'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <p className="panel-note">
          These prices are deliberately provisional. The checkout path is real; the commercial
          numbers are placeholders until Trevra pricing is finalized.
        </p>
      </Panel>
    </PageGrid>
  );
}
