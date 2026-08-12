import { useRef } from 'react';
import {
  CalendarClock,
  Check,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileWarning,
  Inbox,
  LoaderCircle,
  Sparkles
} from 'lucide-react';
import type { Recommendation, RecommendationType } from '../../shared/types';
import { useListKeys } from '../ui/keys';
import { money, moneyProse } from './format';

/**
 * The paid end of the loop, as the enum has always named it.
 *
 * No string here changes and no member is renamed. `stale_proposal`,
 * `scope_creep`, `unbilled_milestone` and `overdue_invoice` are stages 5 and 6
 * of one loop, not a second product's vocabulary. Only their GROUPING on
 * screen changed.
 */
export const recommendationLabels: Record<RecommendationType, string> = {
  stale_proposal: 'Proposal follow-up',
  scope_creep: 'Scope protection',
  unbilled_milestone: 'Ready to invoice',
  overdue_invoice: 'Payment collection'
};

export function iconFor(type: RecommendationType) {
  if (type === 'scope_creep') return <FileWarning />;
  if (type === 'overdue_invoice') return <Clock3 />;
  if (type === 'unbilled_milestone') return <CircleDollarSign />;
  return <Inbox />;
}

export function automationDescription(type: RecommendationType) {
  if (type === 'stale_proposal') return 'Follow up when a proposal goes quiet.';
  if (type === 'scope_creep') return 'Detect and price requests outside the agreement.';
  if (type === 'unbilled_milestone') return 'Prepare invoices when delivery is proven.';
  return 'Follow up when an invoice passes its due date.';
}

export function RecommendationCard({ item, busy, onPrepare, onSnooze, onDismiss }: {
  item: Recommendation; busy: boolean; onPrepare: () => void; onSnooze: () => void; onDismiss: () => void;
}) {
  const proofItems = item.proofPack?.items ?? item.evidence;
  return <article className="recommendation-card">
    <div className={`recommendation-icon type-${item.type}`}>{iconFor(item.type)}</div>
    <div className="recommendation-body">
      <div className="recommendation-meta"><span>{recommendationLabels[item.type]}</span><i>•</i><span>{Math.round(item.confidence * 100)}% confidence</span>{item.preparedAction && <span className="prepared-badge"><Sparkles size={11} /> Prepared</span>}</div>
      {/* h3, not h4. The panel heading above this is h2 and the page title is
          h1, so this is the third level and says so. */}
      <h3>{moneyProse(item.title)}</h3>
      {/* Every figure on this card in one notation. The engine writes prose by
          concatenating `EUR` and an amount; the chip below renders the same
          money as `€1,850`, and two notations on one card is a reader having
          to work out whether they are the same number. */}
      <p>{moneyProse(item.summary)}</p>
      <details className="proof-pack">
        <summary><FileCheck2 size={14} /> Open Revenue Proof Pack</summary>
        <p className="proof-summary">{item.proofPack?.summary ? moneyProse(item.proofPack.summary) : null}</p>
        <div className="proof-items">{proofItems.map((evidence) => <div className={`proof-item proof-${evidence.category}`} key={evidence.id}><span>{evidence.label}</span><blockquote>{moneyProse(evidence.excerpt)}</blockquote></div>)}</div>
      </details>
      <div className="recommendation-action"><strong>{moneyProse(item.recommendedAction)}</strong><span>{money(item.estimatedAmount, item.currency)}</span></div>
      <div className="recommendation-buttons">
        <button className="primary-button" onClick={onPrepare} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : item.preparedAction ? <FileCheck2 size={16} /> : <Sparkles size={16} />} {item.preparedAction ? 'Review prepared action' : 'Prepare action'}</button>
        <button className="secondary-button" onClick={onSnooze} disabled={busy}><CalendarClock size={16} /> Snooze</button>
        <button className="ghost-button" onClick={onDismiss} disabled={busy}>Dismiss</button>
      </div>
    </div>
  </article>;
}

export interface RecommendationActions {
  busyId: string | null;
  onPrepare: (item: Recommendation) => Promise<void>;
  onSnooze: (id: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * The list, with `j` and `k` on it.
 *
 * The keys move real focus onto a card rather than painting a private
 * highlight, so what the eye follows and what a screen reader follows are the
 * same thing, and Tab carries on from wherever `j` left off.
 */
export function RecommendationList({ items, actions, empty }: {
  items: Recommendation[];
  actions: RecommendationActions;
  empty: React.ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  useListKeys(list, '.recommendation-card', items.length > 1);

  return <div className="recommendation-list" ref={list}>
    {items.map((item) => <RecommendationCard
      key={item.id}
      item={item}
      busy={actions.busyId === item.id}
      onPrepare={() => void actions.onPrepare(item)}
      onSnooze={() => actions.onSnooze(item.id)}
      onDismiss={() => actions.onDismiss(item.id)}
    />)}
    {items.length === 0 && empty}
  </div>;
}

export function EmptyRecommendations({ isNew }: { isNew: boolean }) {
  return isNew
    ? <div className="empty-state"><Inbox size={28} /><h4>Nothing here yet</h4><p>Connect a tool in Setup and Trevra will start finding work for you.</p></div>
    : <div className="empty-state"><Check size={28} /><h4>You’re all clear</h4><p>Nothing needs you right now. Trevra will speak up when it does.</p></div>;
}
