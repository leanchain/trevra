import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  Workflow,
  X
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
import { useDialog } from '../ui/dialog';
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
 * "Complete run ledger" and "Exportable ledger and evidence" are headline claims
 * on the marketing site.
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
const isFailed = (status: string) =>
  status === 'failed' || status === 'error' || status === 'cancelled';

export function LedgerView({
  runId,
  setToast,
  onNavigate
}: {
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
  const [exportOpen, setExportOpen] = useState(false);

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
      setToast(
        decision === 'approve' ? `Approved · ${updated.status.replace('_', ' ')}` : 'Rejected.'
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to record decision');
    } finally {
      setBusy('');
    }
  };

  // One list, newest first. A job Trevra ran and a run by Trevra's own agent
  // are the same thing to the person reading it: work that happened.
  const activity = useMemo<ActivityRow[]>(
    () =>
      [
        ...runs.map((run): ActivityRow => ({
          key: `job:${run.id}`,
          at: run.startedAt ?? run.createdAt,
          kind: 'playbook',
          run
        })),
        ...agentRuns.map((run): ActivityRow => ({
          key: `agent:${run.id}`,
          at: run.startedAt,
          kind: 'agent',
          run
        }))
      ].sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0)),
    [runs, agentRuns]
  );

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

  return (
    <div className="page-stack">
      {/* Control bar: Title, filter dropdowns, Refresh, and Export modal trigger */}
      <section className="page-panel ledger-bar">
        <div className="ledger-title-group">
          <h3 aria-level={2}>Every run</h3>
          <span className="ledger-count-pill">{shown.length} shown</span>
        </div>
        <div className="ledger-filters">
          <label className="ledger-select">
            <span className="li-filter-label">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS_FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ledger-select">
            <span className="li-filter-label">Who</span>
            <select value={actor} onChange={(e) => setActor(e.target.value as ActorFilter)}>
              {ACTOR_FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ledger-select">
            <span className="li-filter-label">Since</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_FILTERS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry} days
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ledger-actions">
          <button className="secondary-button ledger-refresh" onClick={() => void reload()}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            className="secondary-button ledger-export-trigger"
            onClick={() => setExportOpen(true)}
          >
            <FileDown size={14} /> Export ledger
          </button>
        </div>
      </section>

      {exportOpen && (
        <LedgerExportModal
          counts={{ jobs: runs.length, agent: agentRuns.length }}
          setToast={setToast}
          onClose={() => setExportOpen(false)}
        />
      )}

      <section className="page-panel">
        <div className="playbook-run-list">
          {shown.map((row) => {
            if (row.kind === 'agent') {
              const run = row.run;
              return (
                <article key={row.key} className={`playbook-run status-${run.status}`}>
                  <header>
                    <div>
                      <span className={`run-status run-${run.status}`}>
                        {runStatusLabel(run.status)}
                      </span>
                      <h3>{run.goal || 'Agent run'}</h3>
                      <code>
                        {run.trigger === 'schedule'
                          ? 'Ran on its own schedule'
                          : 'You started this one'}
                        {formatMoment(run.startedAt) ? ` · ${formatMoment(run.startedAt)}` : ''}
                      </code>
                    </div>
                    <strong>
                      {run.stepCount}/{run.maxSteps}
                    </strong>
                  </header>
                  {run.summary && <p className="run-note">{run.summary}</p>}
                  {run.error && <div className="error-banner">{run.error}</div>}
                  {/* Stopping a run lives in the shell now, on every route. */}
                  <button
                    className="secondary-button run-open"
                    onClick={() => onNavigate(`/ledger/run/${run.id}`)}
                  >
                    See every step <ChevronRight size={15} />
                  </button>
                </article>
              );
            }
            const run = row.run;
            const approval = run.steps.find((step) => step.status === 'waiting_approval');
            const failed = run.steps.find((step) => step.status === 'failed');
            const completed = run.steps.filter((step) => step.status === 'completed').length;
            return (
              <article key={row.key} className={`playbook-run status-${run.status}`}>
                <header>
                  <div>
                    <span className={`run-status run-${run.status}`}>
                      {runStatusLabel(run.status)}
                    </span>
                    <h3>{humanizeId(run.playbookId)}</h3>
                    <code>
                      {run.playbookId} · v{run.playbookVersion}
                    </code>
                  </div>
                  <strong>
                    {completed}/{run.steps.length}
                  </strong>
                </header>
                <div className="playbook-step-track">
                  {run.steps.map((step) => (
                    <div key={step.id} className={`step-${step.status}`}>
                      <i />
                      <span>{humanizeId(step.stepId)}</span>
                      <small>{runStatusLabel(step.status)}</small>
                    </div>
                  ))}
                </div>
                {run.error && <div className="error-banner">{run.error}</div>}
                {!run.error && failed && (
                  <div className="error-banner">
                    <strong>{humanizeId(failed.stepId)}</strong> failed
                    {failed.error ? ` — ${firstLine(failed.error)}` : '.'}
                  </div>
                )}
                {approval && (
                  <div className="workflow-approval">
                    <div className="approval-banner">
                      <ShieldCheck size={19} />
                      <p>
                        <strong>Approval required.</strong> Changes after approval are rejected.
                      </p>
                    </div>
                    <FieldList value={approval.input} />
                    <div>
                      <button
                        className="secondary-button"
                        disabled={busy === `${run.id}:${approval.stepId}`}
                        onClick={() => void decide(run, approval.stepId, 'reject')}
                      >
                        Reject
                      </button>
                      <button
                        className="primary-button"
                        disabled={busy === `${run.id}:${approval.stepId}`}
                        onClick={() => void decide(run, approval.stepId, 'approve')}
                      >
                        {busy === `${run.id}:${approval.stepId}` ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Check size={16} />
                        )}{' '}
                        Approve and run
                      </button>
                    </div>
                  </div>
                )}
                <button
                  className="secondary-button run-open"
                  onClick={() => onNavigate(`/ledger/run/${run.id}`)}
                >
                  See every step <ChevronRight size={15} />
                </button>
              </article>
            );
          })}
          {!loaded && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={28} />
              <h4 aria-level={3}>Loading your runs…</h4>
              <p>One moment.</p>
            </div>
          )}
          {loaded && activity.length === 0 && (
            <div className="empty-state">
              <Workflow size={28} />
              <h4 aria-level={3}>No runs yet</h4>
            </div>
          )}
          {loaded && activity.length > 0 && shown.length === 0 && (
            <div className="empty-state">
              <Workflow size={28} />
              <h4 aria-level={3}>No matching runs</h4>
              <p>Change or clear the filters.</p>
              <button
                className="secondary-button"
                onClick={() => {
                  setStatus('all');
                  setActor('all');
                  setDays(365);
                }}
              >
                Show everything
              </button>
            </div>
          )}
        </div>
      </section>

      {target && <RunInspector target={target} onClose={() => onNavigate('/ledger')} />}
    </div>
  );
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

function LedgerExportModal({
  counts,
  setToast,
  onClose
}: {
  counts: { jobs: number; agent: number };
  setToast: (message: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialog(dialog, onClose);

  return createPortal(
    <div className="ledger-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialog}
        className="ledger-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ledger-modal-header">
          <div>
            <h3 id={titleId}>
              <FileDown size={18} /> Export ledger
            </h3>
            <span className="status-pill">
              {(counts.jobs + counts.agent).toLocaleString('en-US')} runs available
            </span>
          </div>
          <button className="icon-button" aria-label="Close export dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="ledger-modal-body">
          <LedgerExportPanel counts={counts} setToast={setToast} />
        </div>
        <footer className="ledger-modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

const SECTION_COPY: Record<LedgerExportSection, string> = {
  runs: 'Run status, timing, and result.',
  steps: 'Inputs and outputs for each step.',
  evidence: 'Sources used by each step.',
  approvals: 'Approved payloads and fingerprints.',
  actions: 'Planned, sent, and returned outreach actions.'
};

function LedgerExportPanel({
  counts,
  setToast
}: {
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

  useEffect(() => {
    void getLedgerExports()
      .then(setHistory)
      .catch(() => undefined);
  }, []);
  // `history` is in the dependency list because the link is gated on BOTH: the
  // id arrives first and the row that carries the anchor only lands with the
  // reload after it. Keyed on the id alone, this fired at a link that was not
  // mounted yet and focus stayed on the body.
  useEffect(() => {
    if (fresh) download.current?.focus();
  }, [fresh, history]);

  const toggle = (section: LedgerExportSection) =>
    setInclude((current) =>
      current.includes(section)
        ? current.filter((entry) => entry !== section)
        : [...current, section]
    );

  const render = async () => {
    setBusy(true);
    setProblem('');
    try {
      const created = await createLedgerExport({ window: days, include });
      setFresh(created.id);
      setHistory(await getLedgerExports().catch(() => history));
      const rows = Object.values(created.counts).reduce((sum, count) => sum + count, 0);
      setToast(`Ledger export ready · ${rows.toLocaleString('en-US')} rows.`);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'Could not create the export. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const latest = fresh ? (history.find((entry) => entry.id === fresh) ?? null) : null;

  return (
    <div className="ledger-export">
      <p className="panel-lead">
        Downloads an NDJSON archive with a signed <code>manifest.json</code>.
      </p>

      <div className="li-filter-row" role="group" aria-label="How far back the export goes">
        <span className="li-filter-label">Window</span>
        {DAY_FILTERS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={`li-range ${days === entry ? 'is-active' : ''}`}
            aria-pressed={days === entry}
            onClick={() => setDays(entry)}
          >
            {entry} days
          </button>
        ))}
      </div>

      <fieldset className="condition-group">
        <legend>What goes in the file</legend>
        {LEDGER_EXPORT_SECTIONS.map((section) => (
          <label key={section}>
            <input
              type="checkbox"
              checked={include.includes(section)}
              onChange={() => toggle(section)}
            />
            <span>
              {section.charAt(0).toUpperCase()}
              {section.slice(1)} — {SECTION_COPY[section]}
            </span>
          </label>
        ))}
      </fieldset>

      {problem && <div className="error-banner">{problem}</div>}

      <div className="panel-footer">
        <span>
          {include.length === 0
            ? 'Pick at least one thing to put in the file.'
            : `${include.length} of ${LEDGER_EXPORT_SECTIONS.length} included · ${days} days`}
        </span>
        <button
          className="primary-button"
          disabled={busy || include.length === 0}
          onClick={() => void render()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />} Render the
          export
        </button>
      </div>

      {latest && (
        <div className="signed-note">
          <div>
            <strong>
              <CheckCircle2 size={15} /> {latest.filename}
            </strong>
            <a ref={download} className="li-link" href={ledgerExportDownloadPath(latest.id)}>
              <Download size={14} /> Download
            </a>
          </div>
          <small>
            {Object.entries(latest.counts)
              .map(([table, rows]) => `${rows.toLocaleString('en-US')} × ${table}`)
              .join(' · ')}
            {' — '}
            {Math.max(1, Math.round(latest.size / 1024)).toLocaleString('en-US')} KB.
          </small>
          <dl className="field-list">
            {Object.entries(latest.sha256).map(([file, digest]) => (
              <div className="field-row" key={file}>
                <dt>{file}</dt>
                <dd>
                  <code>{digest.slice(0, 16)}…</code>
                </dd>
              </div>
            ))}
          </dl>
          <small>
            Hashes from <code>manifest.json</code>.
          </small>
        </div>
      )}

      {history.length > 0 && (
        <details className="run-raw">
          <summary>Earlier exports ({history.length})</summary>
          <dl className="field-list">
            {history.map((entry) => (
              <div className="field-row" key={entry.id}>
                <dt>{formatMoment(entry.createdAt) ?? entry.createdAt}</dt>
                <dd>
                  {entry.windowDays} days · {entry.include.join(', ')}
                  {' · '}
                  <a className="li-link" href={ledgerExportDownloadPath(entry.id)}>
                    {entry.filename}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {history.length === 0 && !latest && (
        <p className="panel-note">
          <CircleAlert size={15} /> No exports yet.
        </p>
      )}
    </div>
  );
}
