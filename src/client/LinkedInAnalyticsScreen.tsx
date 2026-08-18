import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, TrendingUp } from 'lucide-react';
import { NOT_ENOUGH_DATA, RATE_MIN_SAMPLE, ratePercent } from './analytics';
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
 * shell renders `LinkedInFunnel` on `/loop`; the per-campaign table is a
 * campaign question, so `LinkedInCampaignBreakdown` renders under
 * `/outreach/campaigns`; the chart stayed where it was.
 *
 * THE WINDOW IS A CONTROL NOW, AND THE COPY IS THE SERVER'S ANSWER.
 * Both panels used to send a hardcoded 7 and then print "every action ever
 * filed -- not a window" over the result, while `linkedinAnalytics` windowed
 * all three of its queries, totals and per-campaign breakdown included. So the
 * heading said all time, the route was asked for a week, and the number
 * between them was neither. There is a real 7/30/90/all picker below, "all"
 * is a window the route honours rather than a word on a heading, and every
 * sentence describing the period is generated from `analytics.windowDays` --
 * what came back -- instead of from what this file believes it asked for.
 */

/**
 * The windows these panels offer. 0 is all time, and the route reads it as all
 * time rather than as a clamp.
 *
 * Not `SERIES_RANGES` from LinkedInViz: that list is what the daily CHART can
 * be cut into, and an unbounded chart is not a thing. These are totals, and a
 * lifetime total is exactly the figure somebody opens this panel for -- "All
 * time" quietly meaning 365 would be a fourth wrong number rather than the one
 * the button promises.
 */
const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: 0 }
] as const;

const DEFAULT_WINDOW_DAYS = 30;

/**
 * The period the numbers on screen were counted over, in words.
 *
 * Reads what the response says (`null` = all time), not what was requested, so
 * the sentence cannot drift from the query the way the old fixed copy did.
 */
function windowSentence(windowDays: number | null): string {
  return windowDays === null
    ? 'Every LinkedIn action this workspace has ever filed — all of it, from the first slot planned to the last reply recorded.'
    : `Every LinkedIn action filed in the last ${windowDays} days — a window, not all time. Widen it to count further back.`;
}

interface AnalyticsRead {
  analytics: LinkedInAnalytics | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  days: number;
  setDays: (days: number) => void;
}

/** `GET /api/linkedin/analytics`, over the window the reader picked. */
function useOutreachAnalytics(): AnalyticsRead {
  const [days, setDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const [analytics, setAnalytics] = useState<LinkedInAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAnalytics(await getLinkedInAnalytics(days));
      setError('');
    } catch (err) {
      setError(
        errorMessage(err, 'Unable to read the outreach ledger. Nothing was changed — try again.')
      );
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useOutreachRefresh(reload);

  return { analytics, loading, error, reload, days, setDays };
}

/** The picker itself, in the same clothes as every other window control in the product. */
function WindowChoice({
  days,
  onChange,
  loading
}: {
  days: number;
  onChange: (days: number) => void;
  loading: boolean;
}) {
  return (
    <div className="li-filter-row" role="group" aria-label="How far back to count">
      <span className="li-filter-label">Counting</span>
      {WINDOWS.map((window) => (
        <button
          key={window.label}
          type="button"
          className={`li-range ${days === window.days ? 'is-active' : ''}`}
          aria-pressed={days === window.days}
          onClick={() => onChange(window.days)}
        >
          {window.label}
        </button>
      ))}
      {loading && <LoaderCircle className="spin" size={14} aria-label="Recounting" />}
    </div>
  );
}

function ReadFailure({
  message,
  loading,
  onRetry
}: {
  message: string;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="error-banner">
      <strong>{message}</strong> Nothing below is a partial count — there is simply no count until
      this read works.{' '}
      <button className="secondary-button" type="button" disabled={loading} onClick={onRetry}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read it
        again
      </button>
    </div>
  );
}

/**
 * planned → exported → sent → accepted → replied, for the whole workspace.
 *
 * Rendered by the shell on `/loop`, where it answers the second stage of the
 * loop -- what goes out, and how far does it get -- for somebody who has not
 * opened Outreach and may not know the word “funnel” applies to a LinkedIn
 * seat. It is therefore self-contained: it reads its own numbers, names its
 * own window in words, and links to the screen that can change them.
 */
export function LinkedInFunnel() {
  const { analytics, loading, error, reload, days, setDays } = useOutreachAnalytics();
  const total = analytics?.total;
  const invites = analytics?.invites;
  const anything = total ? total.planned + total.exported + total.sent + total.skipped > 0 : false;

  return (
    <section className="page-panel li-viz">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Outreach, end to end</h3>
          <p>{analytics ? windowSentence(analytics.windowDays) : 'Reading the outreach ledger…'}</p>
        </div>
        <TrendingUp size={20} className="li-heading-icon" />
      </div>

      <WindowChoice days={days} onChange={setDays} loading={loading} />

      {error && <ReadFailure message={error} loading={loading} onRetry={() => void reload()} />}

      {!total || !invites ? (
        <p className="empty-copy">
          {loading
            ? 'Reading the outreach ledger…'
            : error
              ? 'No count to show.'
              : 'No analytics yet.'}
        </p>
      ) : !anything ? (
        <div className="empty-state">
          <TrendingUp size={26} />
          <h4 aria-level={3}>Nothing has gone out in this window</h4>
          <p>
            A slot enters this ledger when an approved plan is exported. Widen the window, or build
            a campaign and the funnel fills itself in.
          </p>
          <a
            className="primary-button"
            href="/outreach/campaigns"
            style={{ textDecoration: 'none' }}
          >
            Build a campaign
          </a>
        </div>
      ) : (
        <>
          <FunnelBars
            stages={[
              { label: 'Planned', value: total.planned, hint: 'scheduled, not yet in a file' },
              { label: 'Exported', value: total.exported, hint: 'handed to your tool' },
              { label: 'Sent', value: total.sent, hint: 'reported as sent' },
              { label: 'Accepted', value: total.accepted, hint: 'includes replies' },
              { label: 'Replied', value: total.replied }
            ]}
          />
          <div className="li-stat-row">
            {/* ACCEPTED OUT OF INVITES SENT, and out of invites specifically.
                This tile used to divide `total.accepted` by
                `total.accepted + total.declined` -- every kind, profile views
                and follows included -- and call the result acceptance. The
                server now counts the invite population itself so the two
                screens that show an acceptance rate show the same one. */}
            <LiStat
              label="Invite acceptance"
              value={ratePercent(invites.invitesAccepted, invites.invitesSent)}
              detail={`${invites.invitesAccepted} accepted of ${invites.invitesSent} invites sent`}
            />
            <LiStat
              label="Replies from accepted"
              value={ratePercent(total.replied, total.accepted)}
              detail={`${total.replied} replies of ${total.accepted} accepted`}
            />
            <LiStat
              label="Declined"
              value={String(total.declined)}
              tone={total.declined > 0 ? 'warn' : undefined}
              detail="an explicit no"
            />
            <LiStat
              label="Skipped"
              value={String(total.skipped)}
              tone="mute"
              detail="dropped before sending"
            />
          </div>
          {/* The honesty rule the Seat screen states at the top of itself, said
              once here too, because this panel is read on a screen that has no
          <p className="panel-note">
            <b>Planned</b> and <b>exported</b> are facts from Trevra’s ledger. <b>Sent</b>, <b>accepted</b> and{' '}
            <b>replied</b> are reported outcomes; the local worker records them after it acts. An outcome nobody reported
            stays missing rather than being guessed.
          </p>
          {/* WHICH ACCEPTANCE RATE THIS IS, because there is a second one a
              click away and they do not agree by design. Here and on
              Campaigns: accepted out of invites sent. On Account safety:
              accepted out of invites ANSWERED, because that is the signal the
              throttle reasons on and an unanswered invite is not a refusal. */}
          <p className="panel-note">
            <b>Invite acceptance</b> is accepted out of invites sent — the same figure the Campaigns
            screen shows. The acceptance meter on{' '}
            <a className="li-link" href="/outreach/safety">
              account safety
            </a>{' '}
            is a different number on purpose: it counts only invites that were answered, because
            that is what Trevra throttles on. A rate is shown as “{NOT_ENOUGH_DATA}” until there are{' '}
            {RATE_MIN_SAMPLE} in the denominator.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The same funnel, split by campaign.
 *
 * Under Campaigns rather than on a screen of its own: “which of my campaigns is
 * working” is a question asked with the campaign list already on screen, and
 * it was two clicks and a different window away.
 */
export function LinkedInCampaignBreakdown() {
  const { analytics, loading, error, reload, days, setDays } = useOutreachAnalytics();

  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>By campaign</h3>
          <p>
            {analytics ? windowSentence(analytics.windowDays) : 'Reading the outreach ledger…'}{' '}
            Acceptance is accepted out of invites sent, so a campaign whose invites are still
            unanswered reads low rather than blank.
          </p>
        </div>
      </div>

      <WindowChoice days={days} onChange={setDays} loading={loading} />

      {error && <ReadFailure message={error} loading={loading} onRetry={() => void reload()} />}

      {!analytics || analytics.byCampaign.length === 0 ? (
        <p className="empty-copy">
          {loading
            ? 'Reading the outreach ledger…'
            : error
              ? 'No count to show.'
              : 'No campaign has filed an action in this window.'}
        </p>
      ) : (
        <div className="li-table-scroll">
          <table className="li-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Planned</th>
                <th>Exported</th>
                <th>Sent</th>
                <th>Accepted</th>
                <th>Replied</th>
                <th>Declined</th>
                <th>Acceptance</th>
              </tr>
            </thead>
            <tbody>
              {analytics.byCampaign.map((row) => (
                <tr key={row.campaignId}>
                  <td>{row.name ?? row.campaignId}</td>
                  <td>
                    {row.status ? (
                      <span className={`li-chip li-campaign-${row.status}`}>{row.status}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="li-num">{row.planned}</td>
                  <td className="li-num">{row.exported}</td>
                  <td className="li-num">{row.sent}</td>
                  <td className="li-num">{row.accepted}</td>
                  <td className="li-num">{row.replied}</td>
                  <td className="li-num">{row.declined}</td>
                  <td
                    className="li-num"
                    title={`${row.invitesAccepted} accepted of ${row.invitesSent} invites sent`}
                  >
                    {ratePercent(row.invitesAccepted, row.invitesSent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
