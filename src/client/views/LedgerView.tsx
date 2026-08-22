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
  Workflow,
  X
} from 'lucide-react';
import type { AgentRunSummary, PlaybookRun, PlaybookStepRun } from '../../shared/types';
import {
  LEDGER_EXPORT_SECTIONS,
  createLedgerExport,
  decidePlaybookStep,
  getAgentRuns,
  getLedgerExports,
  getPlaybookRuns,
  ledgerExportDownloadPath,
  updatePlaybookApprovalBody,
  type LedgerExportRecord,
  type LedgerExportSection
} from '../api';
import { useDialog } from '../ui/dialog';
import { FilterGroup, FilterToolbar } from '../ui/filters';
import { EmptyState, Panel } from '../ui/layout';
import { Button, Select } from '../ui/primitives';
import {
  ApprovalDecisionProof,
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
  { id: 'all', label: 'All runs' },
  { id: 'running', label: 'Running now' },
  { id: 'waiting_approval', label: 'Waiting on you' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' }
];

const ACTOR_FILTERS: Array<{ id: ActorFilter; label: string }> = [
  { id: 'all', label: 'All work' },
  { id: 'jobs', label: 'Jobs & workflows' },
  { id: 'agent', label: 'Trevra agent' }
];

const DAY_FILTERS = [7, 30, 90, 365] as const;

const dayFilterLabel = (days: number) => (days === 365 ? 'Last year' : `Last ${days} days`);

/** A failed status by any of the three vocabularies the three ledgers use. */
const isFailed = (status: string) =>
  status === 'failed' || status === 'error' || status === 'cancelled';

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function StepHoverCard({ step, steps }: { step: PlaybookStepRun; steps: PlaybookStepRun[] }) {
  const anchor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const open = () => {
    cancelClose();
    const next = anchor.current?.getBoundingClientRect();
    if (next) setRect(next);
  };
  const close = () => {
    cancelClose();
    setRect(null);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setRect(null), 180);
  };

  useEffect(() => {
    if (!rect) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchor.current?.contains(target) || card.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [rect]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const output = recordOf(step.output);
  const input = recordOf(step.input);

  let content: React.ReactNode;
  if (step.stepId === 'guard') {
    const checks = listOf(output?.checks);
    const passed = checks.filter((entry) => recordOf(entry)?.passed === true).length;
    content = (
      <>
        <div className="step-hover-summary">
          <strong>
            {output?.allowed === false ? 'Blocked by safety guard' : 'Safety guard passed'}
          </strong>
          <span>
            {checks.length ? `${passed}/${checks.length} checks passed` : 'Safety checks completed'}
          </span>
        </div>
        {checks.length > 0 && (
          <div className="step-hover-checks">
            {checks.map((entry, index) => {
              const check = recordOf(entry);
              if (!check) return null;
              const ok = check.passed === true;
              return (
                <div key={index} className={ok ? 'is-passed' : 'is-failed'}>
                  <span>{ok ? '✓' : '×'}</span>
                  <div>
                    <strong>{humanizeId(textOf(check.check) || `Check ${index + 1}`)}</strong>
                    <small>{textOf(check.detail)}</small>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {textOf(output?.reason) && <p className="step-hover-note">{textOf(output?.reason)}</p>}
        {textOf(output?.automationReason) && (
          <p className="step-hover-note">
            <strong>
              {textOf(output?.automationMode) === 'prepare-only' ? 'Delivery:' : 'Platform:'}
            </strong>{' '}
            {textOf(output?.automationReason)}
          </p>
        )}
      </>
    );
  } else if (step.stepId === 'draft') {
    const critique = recordOf(output?.critique);
    const findings = listOf(critique?.findings);
    const firstFinding = recordOf(findings[0]);
    const body = textOf(output?.body);
    const angle = textOf(output?.angle);
    const angleLabel =
      angle === 'technical_deepdive'
        ? 'Technical deep dive'
        : angle === 'cost_comparison'
          ? 'Cost comparison'
          : angle === 'alternative_suggestion'
            ? 'Alternative suggestion'
            : angle === 'minimal_mention'
              ? 'Minimal mention'
              : angle
                ? humanizeId(angle)
                : 'Reply draft';
    content = (
      <>
        <div className="step-hover-summary">
          <strong>Drafted the reply</strong>
          <span>
            {angleLabel}
            {critique?.passed === true
              ? ' · critique passed'
              : critique?.passed === false
                ? ' · needs review'
                : ''}
          </span>
        </div>
        {body && (
          <p className="step-hover-preview">
            {body.length > 280 ? `${body.slice(0, 280)}…` : body}
          </p>
        )}
        {firstFinding && (
          <p className="step-hover-note">
            <strong>
              {findings.length === 1 ? 'Copy note:' : `${findings.length} copy notes:`}
            </strong>{' '}
            {textOf(firstFinding.detail) || textOf(firstFinding.check)}
          </p>
        )}
      </>
    );
  } else if (step.stepType === 'approval') {
    content = (
      <div className="step-hover-summary">
        <strong>
          {step.status === 'waiting_approval'
            ? 'Waiting for your decision'
            : runStatusLabel(step.status)}
        </strong>
        <span>You can edit the prepared reply below before approving it.</span>
      </div>
    );
  } else if (step.stepId === 'post-reply') {
    const deliveryUrl =
      textOf(output?.url) || textOf(output?.externalUrl) || textOf(output?.permalink);
    const guardOutput = recordOf(steps.find((candidate) => candidate.stepId === 'guard')?.output);
    const mode = textOf(guardOutput?.automationMode);
    const modeReason = textOf(guardOutput?.automationReason);
    const manual = mode === 'prepare-only' || mode === 'disabled' || mode === 'unknown';
    content = (
      <>
        <div className="step-hover-summary">
          <strong>
            {step.status === 'pending'
              ? manual
                ? 'Will prepare after approval'
                : 'Will post after approval'
              : step.status === 'completed'
                ? manual
                  ? 'Reply prepared'
                  : 'Reply posted'
                : runStatusLabel(step.status)}
          </strong>
          <span>
            {manual
              ? 'This platform requires a human to submit the approved reply.'
              : 'This step publishes the exact reply you approved.'}
          </span>
        </div>
        {modeReason && <p className="step-hover-note">{modeReason}</p>}
        {deliveryUrl && <p className="step-hover-note">{deliveryUrl}</p>}
        {step.error && <p className="step-hover-note is-error">{firstLine(step.error)}</p>}
      </>
    );
  } else if (step.stepId === 'scout') {
    const threads = listOf(output?.threads);
    content = (
      <div className="step-hover-summary">
        <strong>Scouted community threads</strong>
        <span>
          {threads.length ? `${threads.length} threads found` : runStatusLabel(step.status)}
        </span>
      </div>
    );
  } else if (step.stepId === 'score') {
    const repliable = listOf(output?.repliable);
    const top = recordOf(repliable[0]);
    content = (
      <div className="step-hover-summary">
        <strong>Scored and ranked threads</strong>
        <span>
          {repliable.length ? `${repliable.length} qualified` : runStatusLabel(step.status)}
          {typeof top?.score === 'number' ? ` · top score ${top.score}/10` : ''}
        </span>
      </div>
    );
  } else {
    content = (
      <div className="step-hover-summary">
        <strong>{step.skillId ? humanizeId(step.skillId) : humanizeId(step.stepId)}</strong>
        <span>{runStatusLabel(step.status)}</span>
        {step.error && <small>{firstLine(step.error)}</small>}
        {!step.error && input && Object.keys(input).length > 0 && (
          <small>Step input recorded.</small>
        )}
      </div>
    );
  }

  const left = rect ? Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 432)) : 12;
  const maxCardHeight =
    typeof window === 'undefined' ? 430 : Math.min(430, window.innerHeight - 24);
  const top = rect
    ? rect.bottom + 8 + maxCardHeight <= window.innerHeight
      ? rect.bottom + 8
      : Math.max(12, rect.top - maxCardHeight - 8)
    : 12;
  const popover = rect
    ? createPortal(
        <div
          ref={card}
          className="step-hover-card"
          role="dialog"
          aria-label={`${humanizeId(step.stepId)} details`}
          style={{ left, top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={scheduleClose}
        >
          <div className="step-hover-card-head">
            <strong>{humanizeId(step.stepId)}</strong>
            <span className={`run-status run-${step.status}`}>{runStatusLabel(step.status)}</span>
          </div>
          {content}
        </div>,
        document.body
      )
    : null;

  return (
    <div
      ref={anchor}
      className={`playbook-step-node step-${step.status}`}
      tabIndex={0}
      role="button"
      aria-haspopup="dialog"
      aria-expanded={Boolean(rect)}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onFocus={open}
      onBlur={scheduleClose}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      aria-label={`${humanizeId(step.stepId)}: ${runStatusLabel(step.status)}. Open for details.`}
    >
      <i />
      <span>{humanizeId(step.stepId)}</span>
      <small>{runStatusLabel(step.status)}</small>
      {popover}
    </div>
  );
}

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
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, string>>({});
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

  const decide = async (
    run: PlaybookRun,
    step: PlaybookStepRun,
    decision: 'approve' | 'reject',
    replyDraft?: string,
    originalReply?: string
  ) => {
    setBusy(`${run.id}:${step.stepId}`);
    try {
      if (decision === 'approve' && replyDraft !== undefined && replyDraft !== originalReply) {
        await updatePlaybookApprovalBody(run.id, step.stepId, replyDraft);
      }
      const updated = await decidePlaybookStep(run.id, step.stepId, decision);
      setApprovalDrafts((current) => {
        const next = { ...current };
        delete next[step.id];
        return next;
      });
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
      <section className="ledger-history-bar" aria-label="Run history controls">
        <FilterToolbar
          density="compact"
          className="ledger-filter-toolbar"
          leading={
            <div className="ledger-history-title">
              <strong>Run history</strong>
              <span>
                · {shown.length.toLocaleString('en-US')} {shown.length === 1 ? 'run' : 'runs'}
              </span>
            </div>
          }
          actions={
            <>
              {status !== 'all' || actor !== 'all' || days !== 30 ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStatus('all');
                    setActor('all');
                    setDays(30);
                  }}
                >
                  Clear
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void reload()}>
                <RefreshCw size={14} /> Refresh
              </Button>
              <Button variant="ghost" onClick={() => setExportOpen(true)}>
                <FileDown size={14} /> Export
              </Button>
            </>
          }
        >
          <FilterGroup label="Status">
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
            >
              {STATUS_FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </FilterGroup>
          <FilterGroup label="Run by">
            <Select value={actor} onChange={(event) => setActor(event.target.value as ActorFilter)}>
              {ACTOR_FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </FilterGroup>
          <FilterGroup label="When">
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {DAY_FILTERS.map((entry) => (
                <option key={entry} value={entry}>
                  {dayFilterLabel(entry)}
                </option>
              ))}
            </Select>
          </FilterGroup>
        </FilterToolbar>
      </section>
      {exportOpen && (
        <LedgerExportModal
          counts={{ jobs: runs.length, agent: agentRuns.length }}
          setToast={setToast}
          onClose={() => setExportOpen(false)}
        />
      )}

      <Panel
        className="ledger-results-panel"
        title="Runs"
        description="Open any run to inspect every step, approval decision, and piece of evidence."
      >
        <div className="playbook-run-list ledger-run-list">
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
            const approvalInput =
              approval?.input &&
              typeof approval.input === 'object' &&
              !Array.isArray(approval.input)
                ? (approval.input as Record<string, unknown>)
                : null;
            const originalReply =
              approvalInput && typeof approvalInput.body === 'string'
                ? approvalInput.body
                : undefined;
            const replyDraft = approval
              ? (approvalDrafts[approval.id] ?? originalReply)
              : undefined;
            return (
              <article key={row.key} className={`playbook-run status-${run.status}`}>
                <header>
                  <div>
                    <span className={`run-status run-${run.status}`}>
                      {runStatusLabel(run.status)}
                    </span>
                    <h3>{humanizeId(run.playbookId)}</h3>
                    <code>
                      Job · v{run.playbookVersion}
                      {formatMoment(run.startedAt ?? run.createdAt)
                        ? ` · ${formatMoment(run.startedAt ?? run.createdAt)}`
                        : ''}
                    </code>
                  </div>
                  <strong>
                    {completed}/{run.steps.length}
                  </strong>
                </header>
                <div className="playbook-step-track">
                  {run.steps.map((step) => (
                    <StepHoverCard key={step.id} step={step} steps={run.steps} />
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
                    <ApprovalDecisionProof
                      step={approval}
                      replyValue={replyDraft}
                      replyDisabled={busy === run.id + ':' + approval.stepId}
                      onReplyChange={
                        originalReply !== undefined
                          ? (value) =>
                              setApprovalDrafts((current) => ({ ...current, [approval.id]: value }))
                          : undefined
                      }
                    />
                    <div className="approval-proof-actions">
                      <button
                        className="secondary-button"
                        disabled={busy === run.id + ':' + approval.stepId}
                        onClick={() => void decide(run, approval, 'reject')}
                      >
                        Reject
                      </button>
                      <button
                        className="primary-button"
                        disabled={
                          busy === run.id + ':' + approval.stepId ||
                          !approval.approvalPayloadHash ||
                          (replyDraft !== undefined && !replyDraft.trim())
                        }
                        onClick={() =>
                          void decide(run, approval, 'approve', replyDraft, originalReply)
                        }
                      >
                        {busy === run.id + ':' + approval.stepId ? (
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
            <EmptyState
              icon={<LoaderCircle className="spin" size={22} />}
              title="Loading run history"
              description="Reading jobs, Agent runs, approvals, and evidence."
            />
          )}
          {loaded && activity.length === 0 && (
            <EmptyState
              icon={<Workflow size={22} />}
              title="No runs yet"
              description="Jobs and Agent runs will appear here as soon as Trevra starts doing work."
            />
          )}
          {loaded && activity.length > 0 && shown.length === 0 && (
            <EmptyState
              icon={<Workflow size={22} />}
              title="No runs match these filters"
              description="Broaden the status, runner, or time window to see more history."
              action={
                <Button
                  onClick={() => {
                    setStatus('all');
                    setActor('all');
                    setDays(30);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )}
        </div>
      </Panel>

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
