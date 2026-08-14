import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  FileDown,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Workflow
} from 'lucide-react';
import type { AgentRunSummary, PlaybookRun } from '../../shared/types';
import {
  LEDGER_EXPORT_SECTIONS,
  createLedgerExport,
  decidePlaybookStep,
  getAgentRuns,
  getLedgerExports,
  getPlaybookRuns,
  ledgerExportDownloadPath,
  type LedgerExportRecord,
  type LedgerExportSection
} from '../api';
import {
  FieldList,
  RunInspector,
  firstLine,
  formatMoment,
  humanizeId,
  runStatusLabel,
  type InspectorTarget
} from './inspector';

/* --------------------------------------------------------------------------
 * `/ledger` -- the thing the landing page sells.
 *
 * "Complete run ledger" and "Exportable ledger and evidence" are two of the
 * headline claims on the marketing site, and until now the app had no screen
 * by that name: the run list lived at the bottom of a screen called Activity,
 * under a marketing sentence about autopilot, behind a playbook launcher that
 * `docs/app-spec.md` §4 had already ruled was not the front door.
 *
 * The launcher moved to `/setup/skills` under "Run one by hand". The hero
 * went. What is left is the list, its inspector, and the control that earns
 * the export claim.
 * -------------------------------------------------------------------------- */

type ActivityRow =
  | { key: string; at: string; kind: 'playbook'; run: PlaybookRun }
  | { key: string; at: string; kind: 'agent'; run: AgentRunSummary };

type ActorFilter = 'all' | 'jobs' | 'agent';
type StatusFilter = 'all' | 'running' | 'waiting_approval' | 'completed' | 'failed';

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'Any status' },
  { id: 'running', label: 'Running' },
  { id: 'waiting_approval', label: 'Waiting on you' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' }
];

const ACTOR_FILTERS: Array<{ id: ActorFilter; label: string }> = [
  { id: 'all', label: 'Anyone' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'agent', label: 'Trevra’s agent' }
];

const DAY_FILTERS = [7, 30, 90, 365] as const;

/** A failed status by any of the three vocabularies the three ledgers use. */
const isFailed = (status: string) => status === 'failed' || status === 'error' || status === 'cancelled';

export function LedgerView({ runId, setToast, onNavigate }: {
  /** From `/ledger/run/:id`. The inspector opens on it and Close returns to the list. */
  runId: string | null;
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [actor, setActor] = useState<ActorFilter>('all');
  const [days, setDays] = useState<number>(30);

  const reload = async () => {
    // Trevra's own agent is optional: a deployment without it has no such
    // ledger, and that must not take the rest of this screen down with it.
    const [nextRuns, nextAgentRuns] = await Promise.all([
      getPlaybookRuns({ limit: 50 }),
      getAgentRuns(50).catch(() => [] as AgentRunSummary[])
    ]);
    setRuns(nextRuns);
    setAgentRuns(nextAgentRuns);
    setLoaded(true);
  };

  useEffect(() => {
    void reload().catch((error) => {
      setLoaded(true);
      setToast(error instanceof Error ? error.message : 'Unable to load the ledger');
    });
  }, []);

  const decide = async (run: PlaybookRun, stepId: string, decision: 'approve' | 'reject') => {
    setBusy(`${run.id}:${stepId}`);
    try {
      const updated = await decidePlaybookStep(run.id, stepId, decision);
      await reload();
      setToast(decision === 'approve' ? `Approved — the job is ${updated.status.replace('_', ' ')}` : 'Rejected. Nothing was sent.');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to record decision');
    } finally { setBusy(''); }
  };

  // One list, newest first. A job Trevra ran and a run by Trevra's own agent
  // are the same thing to the person reading it: work that happened.
  const activity = useMemo<ActivityRow[]>(() => [
    ...runs.map((run): ActivityRow => ({ key: `job:${run.id}`, at: run.startedAt ?? run.createdAt, kind: 'playbook', run })),
    ...agentRuns.map((run): ActivityRow => ({ key: `agent:${run.id}`, at: run.startedAt, kind: 'agent', run }))
  ].sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0)), [runs, agentRuns]);

  const shown = useMemo(() => {
    const floor = Date.now() - days * 86_400_000;
    return activity.filter((row) => {
      if ((Date.parse(row.at) || 0) < floor) return false;
      if (actor === 'jobs' && row.kind !== 'playbook') return false;
      if (actor === 'agent' && row.kind !== 'agent') return false;
      if (status === 'all') return true;
      if (status === 'failed') return isFailed(row.run.status);
      return row.run.status === status;
    });
  }, [activity, status, actor, days]);

  // A deep link may name a run that has not reached the list yet -- one just
  // started from Setup, for instance -- so the inspector fetches by id, and
  // works out which ledger it is in for itself rather than being told by a URL
  // whose author had no way of knowing.
  const target: InspectorTarget | null = runId ? { kind: 'auto', id: runId } : null;

  return <div className="page-stack">
    <LedgerExportPanel counts={{ jobs: runs.length, agent: agentRuns.length }} setToast={setToast} />

    <section className="page-panel">
      <div className="section-heading">
        <div><h3 aria-level={2}>Every run</h3><p>Newest first. Open one to see every step, what went in, what came out, and the proof behind it.</p></div>
        <button className="secondary-button" onClick={() => void reload()}><RefreshCw size={15} /> Refresh</button>
      </div>

      <div className="li-filter-row" role="group" aria-label="Which runs to show">
        <span className="li-filter-label">Status</span>
        {STATUS_FILTERS.map((entry) => <button
          key={entry.id}
          type="button"
          className={`li-range ${status === entry.id ? 'is-active' : ''}`}
          aria-pressed={status === entry.id}
          onClick={() => setStatus(entry.id)}
        >{entry.label}</button>)}
      </div>
      <div className="li-filter-row" role="group" aria-label="Who ran it">
        <span className="li-filter-label">Who</span>
        {ACTOR_FILTERS.map((entry) => <button
          key={entry.id}
          type="button"
          className={`li-range ${actor === entry.id ? 'is-active' : ''}`}
          aria-pressed={actor === entry.id}
          onClick={() => setActor(entry.id)}
        >{entry.label}</button>)}
      </div>
      <div className="li-filter-row" role="group" aria-label="How far back">
        <span className="li-filter-label">Since</span>
        {DAY_FILTERS.map((entry) => <button
          key={entry}
          type="button"
          className={`li-range ${days === entry ? 'is-active' : ''}`}
          aria-pressed={days === entry}
          onClick={() => setDays(entry)}
        >{entry} days</button>)}
      </div>

      <div className="playbook-run-list">
        {shown.map((row) => {
          if (row.kind === 'agent') {
            const run = row.run;
            return <article key={row.key} className={`playbook-run status-${run.status}`}>
              <header><div><span className={`run-status run-${run.status}`}>{runStatusLabel(run.status)}</span><h3>{run.goal || 'Agent run'}</h3><code>{run.trigger === 'schedule' ? 'Ran on its own schedule' : 'You started this one'}{formatMoment(run.startedAt) ? ` · ${formatMoment(run.startedAt)}` : ''}</code></div><strong>{run.stepCount}/{run.maxSteps}</strong></header>
              {run.summary && <p className="run-note">{run.summary}</p>}
              {run.error && <div className="error-banner">{run.error}</div>}
              {/* Stopping a run lives in the shell now, on every route. */}
              <button className="secondary-button run-open" onClick={() => onNavigate(`/ledger/run/${run.id}`)}>See every step <ChevronRight size={15} /></button>
            </article>;
          }
          const run = row.run;
          const approval = run.steps.find((step) => step.status === 'waiting_approval');
          const failed = run.steps.find((step) => step.status === 'failed');
          const completed = run.steps.filter((step) => step.status === 'completed').length;
          return <article key={row.key} className={`playbook-run status-${run.status}`}>
            <header><div><span className={`run-status run-${run.status}`}>{runStatusLabel(run.status)}</span><h3>{humanizeId(run.playbookId)}</h3><code>{run.playbookId} · v{run.playbookVersion}</code></div><strong>{completed}/{run.steps.length}</strong></header>
            <div className="playbook-step-track">{run.steps.map((step) => <div key={step.id} className={`step-${step.status}`}><i /><span>{humanizeId(step.stepId)}</span><small>{runStatusLabel(step.status)}</small></div>)}</div>
            {run.error && <div className="error-banner">{run.error}</div>}
            {!run.error && failed && <div className="error-banner"><strong>{humanizeId(failed.stepId)}</strong> failed{failed.error ? ` — ${firstLine(failed.error)}` : '.'}</div>}
            {approval && <div className="workflow-approval">
              <div className="approval-banner"><ShieldCheck size={19} /><p><strong>Your decision.</strong> Trevra runs exactly what you see below. If a single character changes after you approve, it is rejected instead of sent.</p></div>
              <FieldList value={approval.input} />
              <div><button className="secondary-button" disabled={busy === `${run.id}:${approval.stepId}`} onClick={() => void decide(run, approval.stepId, 'reject')}>Reject</button><button className="primary-button" disabled={busy === `${run.id}:${approval.stepId}`} onClick={() => void decide(run, approval.stepId, 'approve')}>{busy === `${run.id}:${approval.stepId}` ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Approve and run</button></div>
            </div>}
            <button className="secondary-button run-open" onClick={() => onNavigate(`/ledger/run/${run.id}`)}>See every step <ChevronRight size={15} /></button>
          </article>;
        })}
        {!loaded && <div className="empty-state"><LoaderCircle className="spin" size={28} /><h4 aria-level={3}>Loading your runs…</h4><p>One moment.</p></div>}
        {loaded && activity.length === 0 && <div className="empty-state"><Workflow size={28} /><h4 aria-level={3}>No runs yet</h4><p>Your agent has not done anything here. Start a job by hand in <strong>Setup → Skills</strong>, or give the agent a standing job in <strong>Setup → Agent access</strong>.</p><button className="secondary-button" onClick={() => onNavigate('/setup/skills')}>Run one by hand <ChevronRight size={15} /></button></div>}
        {loaded && activity.length > 0 && shown.length === 0 && <div className="empty-state"><Workflow size={28} /><h4 aria-level={3}>No run matches these filters</h4><p>{activity.length} {activity.length === 1 ? 'run is' : 'runs are'} on file. Widen the window or clear a filter.</p><button className="secondary-button" onClick={() => { setStatus('all'); setActor('all'); setDays(365); }}>Show everything</button></div>}
      </div>
    </section>

    {target && <RunInspector target={target} onClose={() => onNavigate('/ledger')} />}
  </div>;
}

/* --------------------------------------------------------------------------
 * "Exportable ledger and evidence" -- the headline self-hosting benefit on the
 * landing page, and until the routes behind this panel landed there was
 * exactly one export in the whole server and it was for LinkedIn campaigns.
 *
 * The archive is NDJSON per table plus a `manifest.json` carrying the sha256
 * of every file, zipped. Not CSV: the ledger is nested -- steps, evidence,
 * the policy decision, the approval hash -- and flattening it discards the
 * evidence, which is the thing being claimed. The per-file hash is the same
 * promise `SignedNote` already makes about an approval, so it is SHOWN rather
 * than merely computed.
 * -------------------------------------------------------------------------- */

const SECTION_COPY: Record<LedgerExportSection, string> = {
  runs: 'Every run: what it was asked to do, what it did, when, and how it ended.',
  steps: 'Every step inside those runs, with what went in and what came out.',
  evidence: 'The sources each step read to reach its conclusion.',
  approvals: 'What you approved, and the fingerprint each approval was pinned to.',
  actions: 'Outreach actions: what was planned, what went out, what came back.'
};

function LedgerExportPanel({ counts, setToast }: {
  counts: { jobs: number; agent: number };
  setToast: (message: string) => void;
}) {
  const [include, setInclude] = useState<LedgerExportSection[]>([...LEDGER_EXPORT_SECTIONS]);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [history, setHistory] = useState<LedgerExportRecord[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const download = useRef<HTMLAnchorElement>(null);

  useEffect(() => { void getLedgerExports().then(setHistory).catch(() => undefined); }, []);
  // `history` is in the dependency list because the link is gated on BOTH: the
  // id arrives first and the row that carries the anchor only lands with the
  // reload after it. Keyed on the id alone, this fired at a link that was not
  // mounted yet and focus stayed on the body.
  useEffect(() => { if (fresh) download.current?.focus(); }, [fresh, history]);

  const toggle = (section: LedgerExportSection) => setInclude((current) => current.includes(section)
    ? current.filter((entry) => entry !== section)
    : [...current, section]);

  const render = async () => {
    setBusy(true);
    setProblem('');
    try {
      const created = await createLedgerExport({ window: days, include });
      setFresh(created.id);
      setHistory(await getLedgerExports().catch(() => history));
      const rows = Object.values(created.counts).reduce((sum, count) => sum + count, 0);
      setToast(`Your ledger is ready: ${rows.toLocaleString('en-US')} rows across ${Object.keys(created.counts).length} tables. The download is on the panel.`);
      // The caret lands on the thing that appeared (see the effect on `fresh`),
      // not back at the button that made it appear.
    } catch (error) {
      setProblem(error instanceof Error
        ? `${error.message} Nothing was written and nothing left your workspace — try again, or narrow the window.`
        : 'Could not render the export. Nothing was written — try again, or narrow the window.');
    } finally { setBusy(false); }
  };

  const latest = fresh ? history.find((entry) => entry.id === fresh) ?? null : null;

  return <section className="page-panel ledger-export">
    <div className="section-heading">
      <div>
        <h3 aria-level={2}><FileDown size={18} /> Take your ledger with you</h3>
        <p>One archive: NDJSON per table plus a <code>manifest.json</code> with the sha256 of every file in it. Not a spreadsheet — the ledger is nested, and flattening it would throw away the evidence, which is the part worth having.</p>
      </div>
      <span className="status-pill">{(counts.jobs + counts.agent).toLocaleString('en-US')} runs loaded</span>
    </div>

    <div className="li-filter-row" role="group" aria-label="How far back the export goes">
      <span className="li-filter-label">Window</span>
      {DAY_FILTERS.map((entry) => <button
        key={entry}
        type="button"
        className={`li-range ${days === entry ? 'is-active' : ''}`}
        aria-pressed={days === entry}
        onClick={() => setDays(entry)}
      >{entry} days</button>)}
    </div>

    <fieldset className="condition-group">
      <legend>What goes in the file</legend>
      {LEDGER_EXPORT_SECTIONS.map((section) => <label key={section}>
        <input type="checkbox" checked={include.includes(section)} onChange={() => toggle(section)} />
        <span>{section.charAt(0).toUpperCase()}{section.slice(1)} — {SECTION_COPY[section]}</span>
      </label>)}
    </fieldset>

    {problem && <div className="error-banner">{problem}</div>}

    <div className="panel-footer">
      <span>{include.length === 0
        ? 'Pick at least one thing to put in the file.'
        : `${include.length} of ${LEDGER_EXPORT_SECTIONS.length} included, ${days} days. Rendered once and stored, so the hashes keep describing the same bytes.`}</span>
      <button className="primary-button" disabled={busy || include.length === 0} onClick={() => void render()}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />} Render the export
      </button>
    </div>

    {latest && <div className="signed-note">
      <div>
        <strong><CheckCircle2 size={15} /> {latest.filename}</strong>
        <a ref={download} className="li-link" href={ledgerExportDownloadPath(latest.id)}>
          <Download size={14} /> Download
        </a>
      </div>
      <small>
        {Object.entries(latest.counts).map(([table, rows]) => `${rows.toLocaleString('en-US')} × ${table}`).join(' · ')}
        {' — '}{Math.max(1, Math.round(latest.size / 1024)).toLocaleString('en-US')} KB.
      </small>
      <dl className="field-list">
        {Object.entries(latest.sha256).map(([file, digest]) => <div className="field-row" key={file}>
          <dt>{file}</dt>
          <dd><code>{digest.slice(0, 16)}…</code></dd>
        </div>)}
      </dl>
      <small>These are the hashes inside <code>manifest.json</code>. Re-hash a file after you download it and it must match, or the file is not the one Trevra rendered.</small>
    </div>}

    {history.length > 0 && <details className="run-raw">
      <summary>Earlier exports ({history.length})</summary>
      <dl className="field-list">
        {history.map((entry) => <div className="field-row" key={entry.id}>
          <dt>{formatMoment(entry.createdAt) ?? entry.createdAt}</dt>
          <dd>
            {entry.windowDays} days · {entry.include.join(', ')}{' · '}
            <a className="li-link" href={ledgerExportDownloadPath(entry.id)}>{entry.filename}</a>
          </dd>
        </div>)}
      </dl>
    </details>}

    {history.length === 0 && !latest && <p className="panel-note">
      <CircleAlert size={15} /> Nothing exported from this workspace yet. The file is yours: Trevra keeps a copy so the hashes stay meaningful, and downloads it with <code>Cache-Control: no-store</code> so no proxy keeps one.
    </p>}
  </section>;
}
