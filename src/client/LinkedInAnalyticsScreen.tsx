import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, TrendingUp } from 'lucide-react';
import { getLinkedInAnalytics, type LinkedInAnalytics } from './api';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import { FunnelBars, LiStat } from './LinkedInViz';

/**
 * What became of every LinkedIn action, in two pieces that no longer share a
 * screen.
 *
 * There was an Analytics tab, and it was three things stapled together: the
 * funnel, a per-campaign table, and a daily volume chart that the Seat screen
 * already drew from the same route. It is gone as a destination. The funnel is
 * a loop-level question -- how far does what goes out actually get -- so the
 * shell renders `LinkedInFunnel` on `#/loop`; the per-campaign table is a
 * campaign question, so `LinkedInCampaignBreakdown` renders under
 * `#/outreach/campaigns`; the chart stayed where it was.
 *
 * THE TWO WINDOWS PROBLEM IS SOLVED BY THE SPLIT, NOT HIDDEN BY IT.
 * `linkedinAnalytics` computes `total` and `byCampaign` over every action the
 * workspace has ever filed, while `series` is bucketed over the requested
 * window only. Putting them on one screen under one window picker meant one of
 * the two was always answering a question nobody asked. Neither component here
 * reads `series`, so neither offers a window, and both say in words that they
 * are counting everything.
 */

/**
 * The window is required by the route and irrelevant to both components below.
 * The smallest one is asked for so the series that comes back regardless is
 * the smallest it can be.
 */
const UNUSED_WINDOW = 7;

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;

interface AnalyticsRead {
  analytics: LinkedInAnalytics | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/** `GET /api/linkedin/analytics`, read by whichever of the two is mounted. */
function useOutreachAnalytics(): AnalyticsRead {
  const [analytics, setAnalytics] = useState<LinkedInAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAnalytics(await getLinkedInAnalytics(UNUSED_WINDOW));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the outreach ledger. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useOutreachRefresh(reload);

  return { analytics, loading, error, reload };
}

function ReadFailure({ message, loading, onRetry }: { message: string; loading: boolean; onRetry: () => void }) {
  return <div className="error-banner">
    <strong>{message}</strong> Nothing below is a partial count — there is simply no count until this read works.{' '}
    <button className="secondary-button" type="button" disabled={loading} onClick={onRetry}>
      {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read it again
    </button>
  </div>;
}

/**
 * planned → exported → sent → accepted → replied, for the whole workspace.
 *
 * Rendered by the shell on `#/loop`, where it answers the second stage of the
 * loop -- what goes out, and how far does it get -- for somebody who has not
 * opened Outreach and may not know the word “funnel” applies to a LinkedIn
 * seat. It is therefore self-contained: it reads its own numbers, names its
 * own window in words, and links to the screen that can change them.
 *
 * `setToast` is taken because the shell hands it to every outreach screen.
 * This one reads and never writes, so it never fires one.
 */
export function LinkedInFunnel() {
  const { analytics, loading, error, reload } = useOutreachAnalytics();
  const total = analytics?.total;
  const decidedInvites = total ? total.accepted + total.declined : 0;
  const anything = total ? total.planned + total.exported + total.sent + total.skipped > 0 : false;

  return <section className="page-panel li-viz">
    <div className="section-heading">
      <div>
        <h3>Outreach, end to end</h3>
        <p>
          Every LinkedIn action this workspace has ever filed — not a window, not the last 30 days. All of it, from the
          first slot planned to the last reply recorded.
        </p>
      </div>
      <TrendingUp size={20} className="li-heading-icon" />
    </div>

    {error && <ReadFailure message={error} loading={loading} onRetry={() => void reload()} />}

    {!total
      ? <p className="empty-copy">{loading ? 'Reading the outreach ledger…' : error ? 'No count to show.' : 'No analytics yet.'}</p>
      : !anything
        ? <div className="empty-state">
          <TrendingUp size={26} />
          <h4>Nothing has gone out yet</h4>
          <p>A slot enters this ledger when an approved plan is exported. Build a campaign and the funnel fills itself in.</p>
          <a className="primary-button" href="#/outreach/campaigns" style={{ textDecoration: 'none' }}>Build a campaign</a>
        </div>
        : <>
          <FunnelBars stages={[
            { label: 'Planned', value: total.planned, hint: 'scheduled, not yet in a file' },
            { label: 'Exported', value: total.exported, hint: 'handed to your tool' },
            { label: 'Sent', value: total.sent, hint: 'reported as sent' },
            { label: 'Accepted', value: total.accepted, hint: 'includes replies' },
            { label: 'Replied', value: total.replied }
          ]} />
          <div className="li-stat-row">
            <LiStat label="Acceptance (all time)" value={percent(decidedInvites === 0 ? null : total.accepted / decidedInvites)}
              detail={`${total.accepted} accepted of ${decidedInvites} decided`} />
            <LiStat label="Reply rate of accepted" value={percent(total.accepted === 0 ? null : total.replied / total.accepted)}
              detail={`${total.replied} replies`} />
            <LiStat label="Declined" value={String(total.declined)} tone={total.declined > 0 ? 'warn' : undefined} detail="an explicit no" />
            <LiStat label="Skipped" value={String(total.skipped)} tone="mute" detail="dropped before sending" />
          </div>
          {/* The honesty rule the Seat screen states at the top of itself, said
              once here too, because this panel is read on a screen that has no
              honesty banner over it. Planned and exported are facts about
              Trevra's own ledger. The three that matter most are not. */}
          <p className="panel-note">
            <b>Planned</b> and <b>exported</b> are facts: Trevra wrote those rows. <b>Sent</b>, <b>accepted</b> and{' '}
            <b>replied</b> are reported — you mark them on the queue, or the local worker files them after it acted.
            Trevra never reads LinkedIn to confirm one, so an outcome nobody reported is missing here rather than wrong.{' '}
            <a className="li-link" href="#/outreach/queue">Mark outcomes on the queue</a>
          </p>
        </>}
  </section>;
}

/**
 * The same funnel, split by campaign.
 *
 * Under Campaigns rather than on a screen of its own: “which of my campaigns is
 * working” is a question asked with the campaign list already on screen, and
 * it was two clicks and a different window away.
 */
export function LinkedInCampaignBreakdown() {
  const { analytics, loading, error, reload } = useOutreachAnalytics();

  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3>By campaign</h3>
        <p>Every action ever filed, per campaign. Acceptance counts decided invites only — an unanswered invite is not a refusal.</p>
      </div>
    </div>

    {error && <ReadFailure message={error} loading={loading} onRetry={() => void reload()} />}

    {!analytics || analytics.byCampaign.length === 0
      ? <p className="empty-copy">{loading ? 'Reading the outreach ledger…' : error ? 'No count to show.' : 'No campaign has filed an action yet.'}</p>
      : <div className="li-table-scroll">
        <table className="li-table">
          <thead><tr>
            <th>Campaign</th><th>Status</th><th>Planned</th><th>Exported</th><th>Sent</th>
            <th>Accepted</th><th>Replied</th><th>Declined</th><th>Acceptance</th>
          </tr></thead>
          <tbody>{analytics.byCampaign.map((row) => <tr key={row.campaignId}>
            <td>{row.name ?? row.campaignId}</td>
            <td>{row.status ? <span className={`li-chip li-campaign-${row.status}`}>{row.status}</span> : '—'}</td>
            <td className="li-num">{row.planned}</td>
            <td className="li-num">{row.exported}</td>
            <td className="li-num">{row.sent}</td>
            <td className="li-num">{row.accepted}</td>
            <td className="li-num">{row.replied}</td>
            <td className="li-num">{row.declined}</td>
            <td className="li-num">{percent(row.acceptanceRate)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}
