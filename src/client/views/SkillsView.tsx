import { useEffect, useId, useRef, useState } from 'react';
import {
  Boxes,
  ChevronRight,
  CircleAlert,
  ListTree,
  LoaderCircle,
  Play,
  ShieldCheck,
  Trash2,
  Workflow,
  X
} from 'lucide-react';
import { createPortal } from 'react-dom';
import type { InstalledCommunityModule, PlaybookManifest, PublicRegistryModule, SkillRun } from '../../shared/types';
import {
  getInstalledRegistryModules,
  getPlaybooks,
  getPublicRegistryModules,
  getSkillRuns,
  installRegistryModule,
  startPlaybook,
  uninstallRegistryModule
} from '../api';
import { ConfirmDrawer, useDialog } from '../ui/dialog';

import {
  FactGrid,
  RunSection,
  SchemaForm,
  buildSchemaValue,
  defaultsFor,
  formatMoment,
  humanizeId,
  runStatusLabel,
  type SchemaNode
} from './inspector';

/* --------------------------------------------------------------------------
 * `/setup/skills` -- what your agent can do.
 *
 * The old screen was a wall of read-only cards with a run counter. Its one
 * button rendered only when `module.sourceType === 'community'`, and every
 * entry in `public/catalog/modules.json` is `builtin` -- so on the shipping
 * catalogue NOT ONE CARD HAD A BUTTON. A grid of twenty cards where nothing is
 * pressable teaches a person that this screen is decoration.
 *
 * Three changes, all of them small:
 *
 * 1. The missing button is replaced by the FACT it was hiding: a built-in
 *    skill is always available. There is nothing to install and saying so is
 *    more useful than saying nothing.
 * 2. Every card can be INSPECTED, in the same vocabulary a run is inspected in
 *    -- `RunSection` and `FactGrid`, no second way of showing a contract --
 *    including its last ten runs from `GET /api/skill-runs?skillId=`, a route
 *    that has existed all along and that no client had ever called.
 * 3. Uninstalling a thinking-only scorer and revoking a thing that can send
 *    mail are not the same act, so they no longer read the same.
 *
 * There is no private-skills group. `sourceType: 'workspace'` does not exist,
 * `SkillManifest` has no scope field and the catalogue has no visibility
 * field, so a "Your skills" heading over an empty box would be a promise the
 * build cannot keep. One group until there are two.
 * -------------------------------------------------------------------------- */

/** The three side effects, in the plain words this codebase already wrote for them. */
const SIDE_EFFECT_COPY: Record<string, string> = {
  'external-write': 'Sends or changes something outside your business',
  'network-read': 'Reads something from outside',
  none: 'Thinks only, nothing leaves Trevra'
};

const sideEffectOf = (module: PublicRegistryModule): string => module.sideEffect;

export function SkillsView({ setToast, onNavigate }: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [modules, setModules] = useState<PublicRegistryModule[]>([]);
  const [installed, setInstalled] = useState<InstalledCommunityModule[]>([]);
  const [busy, setBusy] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<PublicRegistryModule | null>(null);
  const [inspecting, setInspecting] = useState<PublicRegistryModule | null>(null);

  const loadRegistry = async () => {
    const [publicModules, installations] = await Promise.all([
      getPublicRegistryModules(), getInstalledRegistryModules()
    ]);
    setModules(publicModules);
    setInstalled(installations);
  };

  useEffect(() => {
    void loadRegistry().catch((error) => setToast(error instanceof Error ? error.message : 'Unable to load what your agent can do'));
  }, []);

  const installedIds = new Set(installed.map((module) => module.id));

  const changeInstall = async (module: PublicRegistryModule, direction: 'install' | 'uninstall') => {
    if (!module.version || module.sourceType === 'builtin') return;
    setBusy(module.id);
    try {
      if (direction === 'uninstall') await uninstallRegistryModule(module.id);
      else await installRegistryModule(module.id, module.version);
      await loadRegistry();
      setToast(direction === 'uninstall'
        ? `${module.name} revoked. Your agent can no longer run it.`
        : `${module.name} installed`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not change that installation. Nothing changed — try again in a moment.');
    } finally { setBusy(''); setConfirmRemove(null); }
  };

  const writes = confirmRemove ? sideEffectOf(confirmRemove) === 'external-write' : false;

  return <div className="page-stack">
    <section className="page-panel registry-summary" id="setup-skills">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}><Boxes size={18} /> Shared skills</h3>
          <p>Each one is a job Trevra knows how to do, published for every workspace. Anything marked “needs your approval” never acts on its own.</p>
        </div>
        <span className="status-pill">{modules.length} available</span>
      </div>
      <div className="registry-grid">
        {modules.map((module) => {
          const isInstalled = installedIds.has(module.id);
          const sideEffect = sideEffectOf(module);
          return <article className="registry-card" key={module.id}>
            <div className="registry-card-head"><code>{module.id}</code><span>#{module.popularity.rank || '—'}</span></div>
            <h3>{module.name}</h3><p>{module.description}</p>
            <div className="registry-stats"><span><strong>{module.popularity.totalRuns.toLocaleString('en-US')}</strong>runs</span><span><strong>{module.popularity.successRate === null ? '—' : `${Math.round(module.popularity.successRate * 100)}%`}</strong>success</span><span><strong>{module.popularity.activeInstallations.toLocaleString('en-US')}</strong>installs</span></div>
            {/* "Signed · No SBOM" told a founder nothing. What they need to know
                is who wrote it and whether it can act without them. */}
            <div className="registry-trust">
              <span><ShieldCheck size={14} /> {module.sourceType === 'community' ? (module.publisher.verified ? `${module.publisher.name} · verified` : module.publisher.name) : 'Built by Trevra'}</span>
              <span>{module.requiresApproval ? 'Needs your approval' : 'Runs on its own'}</span>
              {sideEffect && SIDE_EFFECT_COPY[sideEffect] && <span>{SIDE_EFFECT_COPY[sideEffect]}</span>}
            </div>
            <div className="li-row-actions">
              <button className="secondary-button" onClick={() => setInspecting(module)}>Inspect <ChevronRight size={15} /></button>
              {module.sourceType === 'builtin'
                // The button that was never there. A built-in skill has nothing
                // to install, and the fact is more use than the silence was.
                ? <span className="li-chip">Always available</span>
                : <button className="secondary-button" disabled={busy === module.id || !module.version} onClick={() => {
                    if (isInstalled) setConfirmRemove(module);
                    else void changeInstall(module, 'install');
                  }}>
                    {busy === module.id ? <LoaderCircle className="spin" size={15} /> : isInstalled ? <Trash2 size={15} /> : <Boxes size={15} />}
                    {isInstalled
                      ? (sideEffect === 'external-write' ? 'Revoke access' : 'Uninstall')
                      : `Install v${module.version}`}
                  </button>}
            </div>
          </article>;
        })}
        {modules.length === 0 && <div className="empty-state"><Boxes size={28} /><h4 aria-level={3}>Nothing here yet</h4><p>Connect your agent in <strong>Setup → Agent access</strong> and the jobs it can run show up here.</p><button className="secondary-button" onClick={() => onNavigate('/setup/agent')}>Connect an agent <ChevronRight size={15} /></button></div>}
      </div>
      <p className="panel-note">Writing your own? Publishing needs a signing key on your machine, so it lives in the terminal: <code>npm run module -- help</code>.</p>
    </section>

    <RunOneByHand setToast={setToast} onNavigate={onNavigate} />

    {inspecting && <SkillInspector module={inspecting} onClose={() => setInspecting(null)} />}

    {confirmRemove && <ConfirmDrawer
      title={writes ? `Revoke ${confirmRemove.name}?` : `Uninstall ${confirmRemove.name}?`}
      tone="danger"
      body={<>
        {writes && <p><strong>This one can send or change something outside your business.</strong> Revoking it takes that reach away from your agent immediately — which is the point, and it is not the same act as removing a scorer that only thinks.</p>}
        <p>Your agent loses this job. Any standing schedule or playbook step that calls <code>{confirmRemove.id}</code> fails at its next run until you install it again.</p>
        <p>Everything it already did stays in the run ledger — this removes the capability, not the record.</p>
      </>}
      confirmLabel={writes ? 'Revoke access' : `Uninstall ${confirmRemove.name}`}
      busy={busy === confirmRemove.id}
      onCancel={() => setConfirmRemove(null)}
      onConfirm={() => void changeInstall(confirmRemove, 'uninstall')}
    />}
  </div>;
}

/* --------------------------------------------------------------------------
 * Inspect.
 *
 * Same drawer chrome, same section vocabulary, same field renderer as a run.
 * A contract and a run are two views of one thing and the shell should have
 * one way of showing either.
 * -------------------------------------------------------------------------- */

function SkillInspector({ module, onClose }: { module: PublicRegistryModule; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const [runs, setRuns] = useState<SkillRun[] | null>(null);
  const [problem, setProblem] = useState('');
  useDialog(dialog, onClose);

  useEffect(() => {
    let cancelled = false;
    void getSkillRuns({ skillId: module.id, limit: 10 })
      .then((next) => { if (!cancelled) setRuns(next); })
      .catch((error) => { if (!cancelled) setProblem(error instanceof Error ? error.message : 'Could not read this skill’s runs.'); });
    return () => { cancelled = true; };
  }, [module.id]);

  const sideEffect = sideEffectOf(module);
  const schemas = module as unknown as { inputSchema?: SchemaNode; outputSchema?: SchemaNode };

  return createPortal(<div className="drawer-backdrop" role="presentation" onClick={onClose}>
    <section ref={dialog} className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
      <header>
        <div className="inspector-head">
          <span className="drawer-kicker"><Boxes size={14} /> Skill</span>
          <h3 id={titleId}>{module.name}</h3>
          <div className="inspector-meta"><code>{module.id}{module.version ? `@${module.version}` : ''}</code></div>
        </div>
        <div className="inspector-actions">
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      <div className="drawer-body">
        <p className="run-note">{module.description}</p>

        <FactGrid facts={[
          { label: 'What it can do', value: SIDE_EFFECT_COPY[sideEffect] ?? 'Not declared' },
          { label: 'Before it acts', value: module.requiresApproval ? 'Needs your approval' : 'Runs on its own' },
          { label: 'Who wrote it', value: module.sourceType === 'community' ? module.publisher.name : 'Trevra' },
          { label: 'Runs recorded', value: module.popularity.totalRuns.toLocaleString('en-US') }
        ]} />

        <RunSection title="What it takes in, and what it gives back">
          {schemas.inputSchema
            ? <SchemaForm
                schema={schemas.inputSchema}
                values={{}}
                readOnly
                emptyCopy="It takes nothing in."
                onChange={() => undefined}
              />
            // The catalogue route does not publish schemas today. Saying so
            // beats rendering an empty box that reads as "no inputs".
            : <p className="empty-copy">The catalogue does not publish this skill’s schema, so there is nothing here to show you. A run of it does: open one below and the exact fields it took and returned are on the step.</p>}
          {schemas.outputSchema && <SchemaForm
            schema={schemas.outputSchema}
            values={{}}
            readOnly
            emptyCopy="It gives nothing back."
            onChange={() => undefined}
          />}
        </RunSection>

        <RunSection title="Its last ten runs">
          {problem && <div className="error-banner">
            <strong>{problem}</strong> Everything above is still true — only the run history could not be read. Close this and open it again.
          </div>}
          {!problem && runs === null && <div className="empty-state"><LoaderCircle className="spin" size={26} /><h4>Reading its ledger…</h4><p>One moment.</p></div>}
          {runs !== null && runs.length === 0 && <div className="empty-state"><ListTree size={26} /><h4>It has not run in this workspace</h4><p>The run counter on the card is every workspace. This list is only yours.</p></div>}
          {runs !== null && runs.length > 0 && <dl className="field-list">
            {runs.map((run) => <div className="field-row" key={run.id}>
              <dt><span className={`run-status run-${run.status}`}>{runStatusLabel(run.status)}</span></dt>
              <dd>
                {formatMoment(run.startedAt) ?? run.startedAt}
                {run.error ? <> — {run.error}</> : null}
              </dd>
            </div>)}
          </dl>}
        </RunSection>
      </div>
    </section>
  </div>, document.body);
}

/* --------------------------------------------------------------------------
 * Run one by hand.
 *
 * `docs/app-spec.md` §4 already ruled on where this belongs: "The agent starts
 * jobs. A human doing it by hand is the exception, not the front door." So it
 * is here, under Setup, and it is folded shut.
 * -------------------------------------------------------------------------- */

function RunOneByHand({ setToast, onNavigate }: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [playbooks, setPlaybooks] = useState<PlaybookManifest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPlaybooks()
      .then((next) => {
        setPlaybooks(next);
        if (next[0]) {
          setSelectedId(next[0].id);
          setValues(defaultsFor(next[0].inputSchema as SchemaNode));
        }
      })
      .catch((error) => setToast(error instanceof Error ? error.message : 'Unable to load what Trevra can run'))
      .finally(() => setLoaded(true));
  }, []);

  const selected = playbooks.find((playbook) => playbook.id === selectedId);

  const launch = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const payload = buildSchemaValue(selected.inputSchema as SchemaNode, values);
      const run = await startPlaybook(selected.id, payload, selected.version);
      setToast(run.status === 'waiting_approval'
        ? 'Started — it is waiting on your approval. Opening it now.'
        : `Started — the job is ${run.status.replace('_', ' ')}. Opening it now.`);
      // The evidence, not the screen you happened to be on when you pressed it.
      onNavigate(`/ledger/run/${run.id}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to start this job');
    } finally { setBusy(false); }
  };

  return <section className="page-panel" id="setup-run-by-hand">
    <details>
      <summary className="panel-disclosure">
        <h3 aria-level={2} style={{ display: 'inline' }}><Workflow size={18} /> Run one by hand</h3>
      </summary>
      <div className="section-heading">
        <div><p>The agent starts jobs. Doing it yourself is the exception — useful when you are testing a change or want one thing done now.</p></div>
        <span className="status-pill">{playbooks.length} available</span>
      </div>
      <div className="playbook-launch-grid">
        <div className="playbook-catalog">
          {playbooks.map((playbook) => <button key={`${playbook.id}@${playbook.version}`} className={selectedId === playbook.id ? 'is-selected' : undefined} onClick={() => { setSelectedId(playbook.id); setValues(defaultsFor(playbook.inputSchema as SchemaNode)); }}>
            <span><Workflow size={17} /><strong>{playbook.name}</strong></span>
            <p>{playbook.description}</p>
            <code>{playbook.id}@{playbook.version}</code>
          </button>)}
          {!loaded && <div className="empty-state"><LoaderCircle className="spin" size={28} /><h4 aria-level={3}>Loading what Trevra can run…</h4><p>One moment.</p></div>}
          {loaded && playbooks.length === 0 && <div className="empty-state"><Workflow size={28} /><h4 aria-level={3}>No jobs available yet</h4><p>Connect your agent in <strong>Setup → Agent access</strong> and the jobs it can run appear here.</p><button className="secondary-button" onClick={() => onNavigate('/setup/agent')}>Connect an agent <ChevronRight size={15} /></button></div>}
        </div>
        <div className="playbook-input">
          <div className="playbook-input-head">
            <div><strong>{selected?.name ?? 'Pick a job'}</strong><span>{selected ? 'Fill this in and Trevra takes it from there.' : 'Choose one on the left to get started.'}</span></div>
          </div>
          {selected
            ? <SchemaForm schema={selected.inputSchema as SchemaNode} values={values} onChange={(path, value) => setValues((current) => ({ ...current, [path]: value }))} />
            : <p className="schema-empty">Nothing selected yet.</p>}
          <div className="panel-footer">
            <span>{selected ? 'It stops at the first thing that needs your decision.' : 'Pick a job on the left first.'}</span>
            <button className="secondary-button" disabled={!selected || busy} onClick={() => void launch()}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Start run
            </button>
          </div>
        </div>
      </div>
      <p className="panel-note"><CircleAlert size={15} /> Every run started here lands in the run ledger with its evidence, exactly like one the agent started.</p>
    </details>
  </section>;
}
