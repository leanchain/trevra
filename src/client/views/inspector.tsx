import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  ListTree,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Workflow,
  X
} from 'lucide-react';
import type {
  AgentRun,
  AgentRunStep,
  PlaybookRun,
  PlaybookStepRun,
  SkillRun
} from '../../shared/types';
import { getAgentRun, getPlaybookRun, getSkillRun } from '../api';
import { useDialog } from '../ui/dialog';
import { formatDuration } from '../ui/duration';

/* --------------------------------------------------------------------------
 * The run inspector, and the vocabulary the rest of the shell shows a
 * contract in.
 *
 * A job IS a workflow: a line of steps, each one with what went in, what came
 * out, the proof behind it, and why Trevra was allowed to do it at all. Three
 * shapes land on this screen -- a job run (work / approval / action steps), a
 * run by Trevra's own agent (model / tool steps), and a single step on its own
 * -- so they are normalised into ONE timeline here instead of growing three
 * near-identical renderers that drift apart.
 *
 * Everything here is read-only evidence, which is why a node may end with a
 * raw record. It is collapsed, it is last, and it is never what a founder has
 * to read. Nothing on this screen is an input: docs/app-spec.md section 7 rule
 * 1 still holds.
 *
 * It lives in its own file because `RunSection` and `FactGrid` are now how the
 * skills screen shows a skill's contract too. One way of showing a contract,
 * in one place.
 * -------------------------------------------------------------------------- */

/**
 * `contactEmail` -> `Contact email`. Schema and record keys are the only
 * labels we have, both for generated forms and for the run inspector, so the
 * few acronyms that read as typos when lowercased are kept upright.
 */
const KEY_ACRONYMS: Record<string, string> = {
  api: 'API',
  cta: 'CTA',
  crm: 'CRM',
  csv: 'CSV',
  eur: 'EUR',
  gbp: 'GBP',
  html: 'HTML',
  id: 'ID',
  ids: 'IDs',
  roi: 'ROI',
  url: 'URL',
  urls: 'URLs',
  usd: 'USD',
  vat: 'VAT'
};

export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!spaced) return key;
  const words = spaced
    .split(/\s+/)
    .map((word) => KEY_ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const [first, ...rest] = words;
  const head = KEY_ACRONYMS[first.toLowerCase()]
    ? first
    : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(' ');
}

/** `gtm.score-lead` / `draft_email` -> `Score lead` / `Draft email`. */
export function humanizeId(value: string): string {
  const tail = value.split(/[./:]/).filter(Boolean).pop() ?? value;
  return humanizeKey(tail);
}

/* --------------------------------------------------------------------------
 * The normalised run.
 * -------------------------------------------------------------------------- */

/**
 * `auto` is for a deep link.
 *
 * `/ledger/run/:id` names a run and not which of the three ledgers it is in,
 * and it has to work before the list behind it has loaded -- a job started by
 * hand navigates straight to its own URL. So `auto` asks the ledgers in turn
 * rather than making the URL carry a fact the person typing it does not have.
 */
export type InspectorTarget = { kind: 'playbook' | 'agent' | 'skill' | 'auto'; id: string };
export type RunFact = { label: string; value: string };

export interface InspectorNode {
  key: string;
  title: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  durationMs: number | null;
  timing: RunFact[];
  input: unknown;
  inputLabel: string;
  output: unknown;
  outputLabel: string;
  evidence: unknown[];
  error: string | null;
  attempt: number | null;
  policyDecision: unknown;
  approvalPayloadHash: string | null;
  skillRunId: string | null;
  facts: RunFact[];
  raw: unknown;
}

export interface InspectorRun {
  id: string;
  kindLabel: string;
  title: string;
  subtitle: string;
  status: string;
  statusLabel: string;
  durationMs: number | null;
  timing: RunFact[];
  error: string | null;
  note: string | null;
  input: unknown;
  inputLabel: string;
  output: unknown;
  outputLabel: string;
  facts: RunFact[];
  nodes: InspectorNode[];
  emptyNodes: string;
  /**
   * Only the hosted agent's runs can be asked to stop, and only while they are
   * still going. Absent means there is nothing to offer here; a timestamp means
   * somebody already asked and the run has not reached its next step yet.
   */
  stopRequestedAt?: string | null;
}

const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled']);

export function runStatusLabel(status: string): string {
  if (status === 'ok') return 'completed';
  if (status === 'error') return 'failed';
  return status.replace(/_/g, ' ');
}

export function durationBetween(
  startedAt: string | null,
  finishedAt: string | null
): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

export function formatMoment(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CH', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

export function firstLine(value: string): string {
  const line = value.split('\n')[0].trim();
  return line.length > 150 ? `${line.slice(0, 150)}…` : line;
}

/** Never invents a duration it cannot prove: a step that has not finished says so. */
function spanTiming(startedAt: string | null, finishedAt: string | null): RunFact[] {
  if (!startedAt) return [{ label: 'Timing', value: 'Has not started yet' }];
  const rows: RunFact[] = [{ label: 'Started', value: formatMoment(startedAt) ?? startedAt }];
  if (!finishedAt) {
    rows.push({ label: 'Finished', value: 'Still running' });
    return rows;
  }
  rows.push({ label: 'Finished', value: formatMoment(finishedAt) ?? finishedAt });
  const took = formatDuration(durationBetween(startedAt, finishedAt));
  if (took) rows.push({ label: 'Took', value: took });
  return rows;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function playbookNode(step: PlaybookStepRun): InspectorNode {
  const isApproval = step.stepType === 'approval';
  const facts: RunFact[] = [];
  if (step.skillId)
    facts.push({
      label: 'What ran',
      value: `${step.skillId}${step.skillVersion ? ` v${step.skillVersion}` : ''}`
    });
  if (step.attempt > 1) facts.push({ label: 'Attempts', value: `${step.attempt} tries` });
  return {
    key: step.id,
    title: humanizeId(step.stepId),
    kindLabel: isApproval
      ? 'Your decision'
      : step.stepType === 'action'
        ? 'Does something outside Trevra'
        : 'Work step',
    status: step.status,
    statusLabel: runStatusLabel(step.status),
    durationMs: durationBetween(step.startedAt, step.finishedAt),
    timing: spanTiming(step.startedAt, step.finishedAt),
    input: step.input,
    inputLabel: isApproval ? 'What you were asked to approve' : 'What went in',
    output: step.output,
    outputLabel: isApproval ? 'What you decided' : 'What came out',
    evidence: Array.isArray(step.evidence) ? step.evidence : [],
    error: step.error,
    attempt: step.attempt,
    policyDecision: step.policyDecision,
    approvalPayloadHash: step.approvalPayloadHash,
    skillRunId: step.skillRunId,
    facts,
    raw: step
  };
}

export function inspectorFromPlaybookRun(run: PlaybookRun): InspectorRun {
  const done = run.steps.filter((step) => step.status === 'completed').length;
  return {
    id: run.id,
    kindLabel: 'Job',
    title: humanizeId(run.playbookId),
    subtitle: `${run.playbookId} · v${run.playbookVersion}`,
    status: run.status,
    statusLabel: runStatusLabel(run.status),
    durationMs: durationBetween(run.startedAt, run.finishedAt),
    timing: spanTiming(run.startedAt ?? run.createdAt, run.finishedAt),
    error: run.error,
    note: null,
    input: run.input,
    inputLabel: 'What this job was given',
    output: run.output,
    outputLabel: 'What the job produced',
    facts: [
      {
        label: 'Started by',
        value:
          run.actorType === 'agent'
            ? 'Your agent'
            : run.actorType === 'user'
              ? 'You'
              : humanizeKey(run.actorType)
      },
      { label: 'Steps', value: `${done} of ${run.steps.length} done` },
      { label: 'Reference', value: run.id }
    ],
    nodes: run.steps.map(playbookNode),
    emptyNodes: 'No steps have been recorded for this job yet. Refresh to check again.'
  };
}

function agentNode(step: AgentRunStep): InspectorNode {
  const isTool = step.kind === 'tool';
  const status = step.error ? 'failed' : 'completed';
  return {
    key: String(step.seq),
    title: isTool ? humanizeId(step.toolName ?? 'tool') : 'Thinking',
    kindLabel: isTool ? 'Used a tool' : 'Asked the model',
    status,
    statusLabel: runStatusLabel(status),
    // The ledger records one timestamp per agent step, so there is no honest
    // duration to show here. It says when, and nothing it cannot prove.
    durationMs: null,
    timing: [{ label: 'Recorded', value: formatMoment(step.createdAt) ?? step.createdAt }],
    input: step.input,
    inputLabel: isTool ? 'What went in' : 'What the model was asked',
    output: step.output,
    outputLabel: isTool ? 'What came back' : 'What the model said',
    evidence: [],
    error: step.error,
    attempt: null,
    policyDecision: null,
    approvalPayloadHash: null,
    skillRunId: null,
    facts: isTool && step.toolName ? [{ label: 'Tool', value: step.toolName }] : [],
    raw: step
  };
}

export function inspectorFromAgentRun(run: AgentRun): InspectorRun {
  return {
    id: run.id,
    kindLabel: 'Run by Trevra’s agent',
    title: run.goal || 'Agent run',
    subtitle: run.trigger === 'schedule' ? 'Ran on its own schedule' : 'You started this one',
    status: run.status,
    statusLabel: runStatusLabel(run.status),
    durationMs: durationBetween(run.startedAt, run.finishedAt),
    timing: spanTiming(run.startedAt, run.finishedAt),
    error: run.error,
    note: run.summary,
    input: run.goal ? { goal: run.goal } : null,
    inputLabel: 'What it was asked to do',
    output: null,
    outputLabel: '',
    facts: [
      { label: 'Steps used', value: `${run.stepCount} of ${run.maxSteps} allowed` },
      { label: 'Reference', value: run.id }
    ],
    nodes: (run.steps ?? []).map(agentNode),
    emptyNodes: 'Nothing recorded for this run yet. Refresh to check again.',
    stopRequestedAt: run.stopRequestedAt ?? null
  };
}

export function inspectorFromSkillRun(run: SkillRun): InspectorRun {
  const durationMs =
    Number.isFinite(run.durationMs) && run.durationMs > 0
      ? run.durationMs
      : durationBetween(run.startedAt, run.finishedAt);
  const timing = spanTiming(run.startedAt, run.finishedAt);
  const node: InspectorNode = {
    key: run.id,
    title: humanizeId(run.skillId),
    kindLabel: 'Work step',
    status: run.status,
    statusLabel: runStatusLabel(run.status),
    durationMs,
    timing,
    input: run.input,
    inputLabel: 'What went in',
    output: run.output,
    outputLabel: 'What came out',
    evidence: Array.isArray(run.evidence) ? run.evidence : [],
    error: run.error,
    attempt: null,
    policyDecision: null,
    approvalPayloadHash: null,
    skillRunId: null,
    facts: [{ label: 'What ran', value: `${run.skillId} v${run.skillVersion}` }],
    raw: run
  };
  return {
    id: run.id,
    kindLabel: 'One step',
    title: humanizeId(run.skillId),
    subtitle: `${run.skillId} · v${run.skillVersion}`,
    status: run.status,
    statusLabel: runStatusLabel(run.status),
    durationMs,
    timing,
    error: run.error,
    note: null,
    input: null,
    inputLabel: '',
    output: null,
    outputLabel: '',
    facts: [{ label: 'Reference', value: run.id }],
    nodes: [node],
    emptyNodes: ''
  };
}

/**
 * The column names of a list that is REALLY A TABLE, or null.
 *
 * Two conditions, and both are strict on purpose. Every entry must be a plain
 * object with the SAME keys in the same order -- a ragged list rendered as a
 * table would silently drop whatever the first row happened not to carry. And
 * every cell must be a scalar, because a nested object inside a cell is how a
 * table becomes less readable than the labelled pairs it replaced.
 *
 * One row stays a labelled list: a header above a single line is a heavier way
 * to say the same thing.
 */
function uniformColumns(value: unknown[]): string[] | null {
  if (value.length < 2) return null;
  const scalar = (entry: unknown) =>
    entry === null ||
    entry === undefined ||
    typeof entry === 'string' ||
    typeof entry === 'number' ||
    typeof entry === 'boolean';
  let columns: string[] | null = null;
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length === 0 || keys.length > 6) return null;
    if (!keys.every((key) => scalar(entry[key]))) return null;
    if (columns === null) columns = keys;
    else if (columns.length !== keys.length || columns.some((key, index) => key !== keys[index])) {
      return null;
    }
  }
  return columns;
}

/**
 * Records rendered as labelled fields rather than dumped as JSON.
 *
 * The keys a run carries are the only labels there are, so `humanizeKey` does
 * the work here exactly as it does for generated forms. Long strings -- a
 * drafted email, a model prompt -- keep their whitespace in a scrollable
 * block instead of collapsing into one unreadable line.
 */
function FieldValue({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) return <span className="field-muted">Not set</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number')
    return <span>{Number.isInteger(value) ? value.toLocaleString('en-US') : String(value)}</span>;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return <span className="field-muted">Empty</span>;
    if (/^https?:\/\/\S+$/.test(trimmed))
      return (
        <a href={trimmed} target="_blank" rel="noreferrer">
          {trimmed}
        </a>
      );
    if (trimmed.length > 180 || trimmed.includes('\n'))
      return <pre className="field-long">{value}</pre>;
    return <span>{trimmed}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="field-muted">None</span>;
    if (depth >= 3) return <pre className="field-long">{JSON.stringify(value, null, 2)}</pre>;
    // A LIST OF THE SAME RECORD IS A TABLE, and drawing it as one is the
    // difference between reading seven safety checks and scrolling past
    // twenty-one label/value pairs that repeat "Check", "Detail", "Passed".
    const columns = uniformColumns(value);
    if (columns) {
      return (
        <div className="field-table-scroll">
          <table className="field-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col">
                    {humanizeKey(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((entry, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column}>
                      <FieldValue
                        value={(entry as Record<string, unknown>)[column]}
                        depth={depth + 1}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    const flat = value.every((entry) => !isPlainObject(entry) && !Array.isArray(entry));
    return flat ? (
      <ul className="field-bullets">
        {value.map((entry, index) => (
          <li key={index}>
            <FieldValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <ol className="field-entries">
        {value.map((entry, index) => (
          <li key={index}>
            <FieldValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0)
      return <span className="field-muted">Nothing recorded</span>;
    if (depth >= 3) return <pre className="field-long">{JSON.stringify(value, null, 2)}</pre>;
    return <FieldList value={value} depth={depth + 1} />;
  }
  return <span>{String(value)}</span>;
}

export function FieldList({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined)
    return <p className="field-muted field-bare">Nothing recorded.</p>;
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <p className="field-muted field-bare">Nothing recorded.</p>;
    return (
      <dl className={depth > 0 ? 'field-list is-nested' : 'field-list'}>
        {entries.map(([key, entry]) => (
          <div className="field-row" key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd>
              <FieldValue value={entry} depth={depth} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div className="field-bare">
      <FieldValue value={value} depth={depth} />
    </div>
  );
}

/** Evidence travels in a few shapes across skills; read all of them, dump none. */
function readEvidence(
  entry: unknown
): { label: string; detail: string; url: string | null } | null {
  if (!isPlainObject(entry)) return null;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const candidate = entry[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
  };
  const label = pick('label', 'title', 'name', 'sourceType');
  const detail = pick('detail', 'excerpt', 'summary', 'description', 'value');
  const url = pick('sourceUrl', 'externalUrl', 'url', 'link', 'source_url');
  if (!label && !detail && !url) return null;
  return { label: label || 'Evidence', detail, url: url || null };
}

export function EvidenceList({ entries }: { entries: unknown[] }) {
  return (
    <div className="evidence-list">
      {entries.map((entry, index) => {
        const item = readEvidence(entry);
        if (!item)
          return (
            <div className="evidence-item" key={index}>
              <FieldList value={entry} />
            </div>
          );
        return (
          <div className="evidence-item" key={index}>
            <strong>{item.label}</strong>
            {item.detail && <p>{item.detail}</p>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.url} <ExternalLink size={12} />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function readPolicyDecision(
  value: unknown
): { effect: string; name: string; reason: string } | null {
  if (!isPlainObject(value)) return null;
  const effect = typeof value.effect === 'string' ? value.effect : '';
  if (!effect) return null;
  return {
    effect,
    name: typeof value.policyName === 'string' ? value.policyName : '',
    reason: typeof value.reason === 'string' ? value.reason : ''
  };
}

/** The limit that let this step happen, as a sentence rather than a record. */
function PolicyNote({ decision }: { decision: { effect: string; name: string; reason: string } }) {
  const named = decision.name ? <strong>{decision.name}</strong> : null;
  const sentence =
    decision.effect === 'require_approval' ? (
      <>
        Needed your approval before anything could happen
        {named ? <> — that is your {named} limit</> : null}.
      </>
    ) : decision.effect === 'deny' ? (
      <>Blocked{named ? <> by your {named} limit</> : null}. Nothing was sent.</>
    ) : (
      <>Allowed{named ? <> by {named}</> : ' automatically'}.</>
    );
  return (
    <div className="policy-note">
      <p>
        <ShieldCheck size={16} /> <span>{sentence}</span>
      </p>
      {decision.reason && <small>{decision.reason}</small>}
    </div>
  );
}

/**
 * The fingerprint your approval was pinned to.
 *
 * Short prefix, copyable in full, and one line saying what it buys you: the
 * exact wording you signed is the only thing that can go out.
 */
function SignedNote({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="signed-note">
      <div>
        <code>{value.slice(0, 12)}…</code>
        <button className="ghost-button" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check size={14} /> Copied
            </>
          ) : (
            <>
              <Copy size={14} /> Copy
            </>
          )}
        </button>
      </div>
      <small>
        Your approval was pinned to this exact wording. If a single character changes afterwards,
        Trevra rejects it instead of sending it.
      </small>
    </div>
  );
}

export function RunSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="run-section">
      <h5>{title}</h5>
      {children}
    </section>
  );
}

export function FactGrid({ facts }: { facts: RunFact[] }) {
  return (
    <div className="run-facts">
      {facts.map((fact) => (
        <div className="run-fact" key={fact.label}>
          <span>{fact.label}</span>
          <strong>{fact.value}</strong>
        </div>
      ))}
    </div>
  );
}

function TimingRows({ rows }: { rows: RunFact[] }) {
  return (
    <dl className="field-list">
      {rows.map((row) => (
        <div className="field-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One node of the timeline. The header carries everything a founder needs to
 * scan a failed run without opening anything -- name, status, how long it
 * took, and the first line of the failure -- and a failed node opens itself.
 */
function RunNodeCard({
  node,
  index,
  onOpenStep
}: {
  node: InspectorNode;
  index: number;
  onOpenStep: (skillRunId: string) => void;
}) {
  const failed = FAILED_STATUSES.has(node.status);
  const [open, setOpen] = useState(failed);
  const duration = formatDuration(node.durationMs);
  const policy = readPolicyDecision(node.policyDecision);

  return (
    <article className={`run-node${failed ? ' is-failed' : ''}`}>
      <button className="run-node-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="run-node-index">{index + 1}</span>
        <span className="run-node-title">
          <strong>{node.title}</strong>
          <small>{node.kindLabel}</small>
          {failed && node.error && <em>{firstLine(node.error)}</em>}
        </span>
        <span className={`run-status run-${node.status}`}>{node.statusLabel}</span>
        <span className="run-node-duration">{duration ?? ''}</span>
        <ChevronDown size={16} className={`run-node-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="run-node-body">
          {node.error && (
            <div className="error-banner">
              <strong>What went wrong.</strong> {node.error}
              {node.attempt !== null && node.attempt > 1
                ? ` Trevra tried this step ${node.attempt} times.`
                : ''}
            </div>
          )}
          <RunSection title={node.inputLabel}>
            <FieldList value={node.input} />
          </RunSection>
          <RunSection title={node.outputLabel}>
            <FieldList value={node.output} />
          </RunSection>
          {node.evidence.length > 0 && (
            <RunSection title="The proof behind it">
              <EvidenceList entries={node.evidence} />
            </RunSection>
          )}
          {policy && (
            <RunSection title="Why this was allowed">
              <PolicyNote decision={policy} />
            </RunSection>
          )}
          {node.approvalPayloadHash && (
            <RunSection title="What you signed">
              <SignedNote value={node.approvalPayloadHash} />
            </RunSection>
          )}
          {node.facts.length > 0 && (
            <RunSection title="Details">
              <FactGrid facts={node.facts} />
            </RunSection>
          )}
          <RunSection title="Timing">
            <TimingRows rows={node.timing} />
          </RunSection>
          {node.skillRunId && (
            <button
              className="secondary-button run-open"
              onClick={() => onOpenStep(node.skillRunId as string)}
            >
              Open this step on its own <ChevronRight size={15} />
            </button>
          )}
          <details className="run-raw">
            <summary>Raw record</summary>
            <pre>{JSON.stringify(node.raw, null, 2)}</pre>
          </details>
        </div>
      )}
    </article>
  );
}

export function RunInspector({
  target,
  onClose
}: {
  target: InspectorTarget;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<InspectorTarget[]>([target]);
  const [run, setRun] = useState<InspectorRun | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const current = stack[stack.length - 1];
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, onClose);

  const load = async (which: InspectorTarget) => {
    setState('loading');
    try {
      if (which.kind === 'auto') {
        // Jobs first, because a job is the thing a human starts by hand and so
        // the thing a hand-typed URL most often names -- unless the id says
        // otherwise. Probing in ignorance of a prefix the id is carrying spends
        // a 404 and a console error to learn what was already written down.
        const agentFirst = which.id.startsWith('arun_');
        if (!agentFirst) {
          const job = await getPlaybookRun(which.id).catch(() => null);
          if (job) {
            setRun(inspectorFromPlaybookRun(job));
            setState('ready');
            return;
          }
        }
        const agent = await getAgentRun(which.id).catch(() => null);
        if (agent) {
          setRun(inspectorFromAgentRun(agent));
          setState('ready');
          return;
        }
        if (agentFirst) {
          const job = await getPlaybookRun(which.id).catch(() => null);
          if (job) {
            setRun(inspectorFromPlaybookRun(job));
            setState('ready');
            return;
          }
        }
        const step = await getSkillRun(which.id).catch(() => null);
        if (step) {
          setRun(inspectorFromSkillRun(step));
          setState('ready');
          return;
        }
        setRun(null);
        setState('missing');
        return;
      }
      if (which.kind === 'playbook') {
        setRun(inspectorFromPlaybookRun(await getPlaybookRun(which.id)));
      } else if (which.kind === 'agent') {
        const detail = await getAgentRun(which.id);
        if (!detail) {
          setRun(null);
          setState('missing');
          return;
        }
        setRun(inspectorFromAgentRun(detail));
      } else {
        setRun(inspectorFromSkillRun(await getSkillRun(which.id)));
      }
      setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to open this run');
      setState('error');
    }
  };

  useEffect(() => {
    void load(current);
  }, [current.kind, current.id]);

  const runDuration = run ? formatDuration(run.durationMs) : null;

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialog}
        className="drawer drawer-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-inspector-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div className="inspector-head">
            <span className="drawer-kicker">
              <Workflow size={14} /> {run?.kindLabel ?? 'Run'}
            </span>
            <h3 id="run-inspector-title">{run?.title ?? 'Opening…'}</h3>
            {run && (
              <div className="inspector-meta">
                <span className={`run-status run-${run.status}`}>{run.statusLabel}</span>
                {runDuration && <span>Took {runDuration}</span>}
                <code>{run.subtitle}</code>
              </div>
            )}
          </div>
          <div className="inspector-actions">
            {stack.length > 1 && (
              <button
                className="icon-button"
                aria-label="Back"
                onClick={() => setStack((entries) => entries.slice(0, -1))}
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <button className="icon-button" aria-label="Refresh" onClick={() => void load(current)}>
              <RefreshCw size={17} />
            </button>
            <button className="icon-button" aria-label="Close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="drawer-body">
          {state === 'loading' && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={28} />
              <h4>Opening this run…</h4>
              <p>Fetching every step, what went in, and what came out.</p>
            </div>
          )}
          {state === 'missing' && (
            <div className="empty-state">
              <ListTree size={28} />
              <h4>This run isn’t here</h4>
              <p>It may have been cleared. Close this and pick another run from the list.</p>
            </div>
          )}
          {state === 'error' && (
            <div className="empty-state">
              <CircleAlert size={28} />
              <h4>Could not open this run</h4>
              <p>{message}</p>
              <button className="secondary-button" onClick={() => void load(current)}>
                <RefreshCw size={15} /> Try again
              </button>
            </div>
          )}
          {state === 'ready' && run && (
            <>
              {run.error && (
                <div className="error-banner">
                  <strong>This run stopped.</strong> {run.error}
                </div>
              )}
              {run.note && <p className="run-note">{run.note}</p>}
              {/* The stop control is no longer here: there is one, in the shell,
              on every route. See ui/StopBar.tsx. */}
              <FactGrid facts={run.facts} />
              {run.input !== null && run.input !== undefined && (
                <RunSection title={run.inputLabel}>
                  <FieldList value={run.input} />
                </RunSection>
              )}
              <RunSection title="Step by step">
                {run.nodes.length === 0 ? (
                  <div className="empty-state">
                    <ListTree size={26} />
                    <h4>No steps yet</h4>
                    <p>{run.emptyNodes}</p>
                  </div>
                ) : (
                  <div className="run-timeline">
                    {run.nodes.map((node, index) => (
                      <RunNodeCard
                        key={node.key}
                        node={node}
                        index={index}
                        onOpenStep={(skillRunId) =>
                          setStack((entries) => [...entries, { kind: 'skill', id: skillRunId }])
                        }
                      />
                    ))}
                  </div>
                )}
              </RunSection>
              {run.output !== null && run.output !== undefined && (
                <RunSection title={run.outputLabel}>
                  <FieldList value={run.output} />
                </RunSection>
              )}
              <RunSection title="Timing">
                <TimingRows rows={run.timing} />
              </RunSection>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
