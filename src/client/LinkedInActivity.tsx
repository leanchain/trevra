import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Clock3, History, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  getLinkedInActivity,
  type LinkedInActivityResponse,
  type LinkedInBackgroundRunHistoryItem
} from './api';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { MAINTENANCE_TASK_LABELS, formatVisitWindow, queueWaitCopy } from './LinkedInTiming';

function taskLabel(task: string): string {
  return MAINTENANCE_TASK_LABELS[task as keyof typeof MAINTENANCE_TASK_LABELS]
    ?? task.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function runSummary(run: LinkedInBackgroundRunHistoryItem): string {
  if (run.kind === 'actions') {
    if (run.status === 'running') return 'Outbound sitting is running now.';
    if (run.executedCount > 0) return `${run.executedCount} LinkedIn action${run.executedCount === 1 ? '' : 's'} completed.`;
    return run.reason ?? 'No outbound action was completed in this sitting.';
  }
  if (run.tasks.length === 0) return run.reason ?? 'Background visit completed.';
  return run.tasks.map(taskLabel).join(' · ');
}

function runTone(run: LinkedInBackgroundRunHistoryItem): 'good' | 'warn' | 'muted' {
  if (run.status === 'completed') return 'good';
  if (run.status === 'running') return 'muted';
  return 'warn';
}

function RunRow({ run }: { run: LinkedInBackgroundRunHistoryItem }) {
  const tone = runTone(run);
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;
  const started = new Date(run.startedAt);
  const duration = finished && Number.isFinite(started.getTime()) && Number.isFinite(finished.getTime())
    ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 60_000))
    : null;
  return <div className="li-activity-run">
    <div className={`li-activity-run-icon is-${tone}`} aria-hidden="true">
      {tone === 'good' ? <CheckCircle2 size={17} /> : tone === 'warn' ? <CircleAlert size={17} /> : <Clock3 size={17} />}
    </div>
    <div className="li-activity-run-main">
      <div className="li-activity-run-head">
        <strong>{run.kind === 'actions' ? 'Outreach sitting' : 'Background check'}</strong>
        <span>{run.seatLabel}</span>
      </div>
      <p>{runSummary(run)}</p>
      {run.reason && run.kind !== 'actions' && <small>{run.reason}</small>}
    </div>
    <div className="li-activity-run-time">
      <strong>{relativeTime(run.startedAt)}</strong>
      <small>{new Date(run.startedAt).toLocaleString()}</small>
      {duration !== null && <small>{duration < 1 ? '<1 min' : `${duration} min`}</small>}
    </div>
  </div>;
}

export function OutreachActivity() {
  const [data, setData] = useState<LinkedInActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await getLinkedInActivity(100);
      setData(next);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not load LinkedIn activity.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useOutreachRefresh(() => load(true));

  if (loading && !data) return <div className="center-state"><LoaderCircle className="spin" size={22} /><p>Loading LinkedIn activity…</p></div>;

  const next = data?.nextRun ?? null;
  const nextWindow = next && next.source !== 'catchup' ? formatVisitWindow(next.startAt, next.endAt, next.timezone) : null;
  const blocker = next ? queueWaitCopy(next.waitingFor) : null;
  const readyNow = Boolean(next?.source === 'catchup' && !blocker);

  return <div className="page-stack li-activity-page">
    <section className="page-panel li-activity-next">
      <div className="section-heading">
        <div>
          <h2><Clock3 size={18} /> Next LinkedIn background run</h2>
          <p>The next real browser sitting Trevra expects to use for this workspace.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {next ? <div className="li-activity-next-value">
        <strong>{blocker ?? (readyNow ? 'Ready now · catch-up' : nextWindow ?? 'Scheduled')}</strong>
        <span>{next.seatLabel} · {next.source === 'actions' ? 'scheduled outreach' : next.source === 'catchup' ? 'availability catch-up' : 'background checks'}</span>
        {blocker && next.source === 'catchup' && <small>The catch-up will run as soon as this prerequisite is back.</small>}
        {blocker && nextWindow && <small>Next normal window: {nextWindow}</small>}
      </div> : <div className="empty-state compact">
        <Clock3 size={20} />
        <p>No LinkedIn background run is scheduled in the current planning horizon.</p>
      </div>}
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h2><History size={18} /> Run history</h2>
          <p>Actual LinkedIn browser sittings. No page content, cookies, passwords or message bodies are stored here.</p>
        </div>
      </div>
      {data?.runs.length ? <div className="li-activity-runs">
        {data.runs.map((run) => <RunRow run={run} key={`${run.kind}:${run.id}`} />)}
      </div> : <div className="empty-state compact">
        <History size={20} />
        <p>No background run has been recorded yet.</p>
      </div>}
    </section>
  </div>;
}
