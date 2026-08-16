import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Users, Workflow as WorkflowIcon } from 'lucide-react';
import {
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows
} from './api';
import { LinkedInManagerCampaignConfig, takeStagedCampaignPrefill } from './LinkedInManagerCampaignConfig';
import { LinkedInManagerLeadConfig } from './LinkedInManagerLeadConfig';
import { LinkedInManagerWorkflowConfig } from './LinkedInManagerWorkflowConfig';
import { errorMessage } from './LinkedInSafety';

interface Readiness {
  seats: number;
  lists: number;
  workflows: number;
}

const EMPTY: Readiness = { seats: 0, lists: 0, workflows: 0 };

/**
 * `/outreach/manager/new` — construction only.
 *
 * The operating Campaigns screen used to contain campaign cards, analytics,
 * manual tasks, account limits, CSV import, workflow editing and the campaign
 * form in one long document. That is two different jobs. This route keeps the
 * build job together and progressive: account -> lead list -> workflow ->
 * campaign. Only the first missing prerequisite is opened as work; once all
 * three exist, the campaign form becomes the primary thing on the page.
 */
export function OutreachManagerBuilder({ setToast, onNavigate }: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [readiness, setReadiness] = useState<Readiness>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefill] = useState(() => takeStagedCampaignPrefill());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [seats, lists, workflows] = await Promise.all([
        getLinkedInManagerSeats(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagerWorkflows()
      ]);
      setReadiness({ seats: seats.length, lists: lists.length, workflows: workflows.length });
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the campaign building blocks. Nothing was changed.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const steps = [
    {
      done: readiness.seats > 0,
      title: 'Choose a LinkedIn account',
      detail: 'The real account this campaign sends from, with its own hours and limits.',
      kind: 'account' as const
    },
    {
      done: readiness.lists > 0,
      title: 'Build a lead list',
      detail: 'The people this campaign is allowed to contact.',
      kind: 'leads' as const
    },
    {
      done: readiness.workflows > 0,
      title: 'Build a workflow',
      detail: 'The actions and waits each person moves through.',
      kind: 'workflow' as const
    }
  ];
  const next = steps.find((step) => !step.done) ?? null;
  const ready = next === null;

  const openEditor = (id: string) => {
    const element = document.getElementById(id);
    if (element instanceof HTMLDetailsElement) element.open = true;
    requestAnimationFrame(() => element?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return <div className="page-stack">
    <div className="builder-back">
      <button className="ghost-button" type="button" onClick={() => onNavigate('/outreach/manager')}>
        <ChevronLeft size={14} /> Back to campaigns
      </button>
    </div>

    {error && <div className="error-banner">{error}</div>}

    {!loading && !ready && <section className="onboarding-card mgr-first-campaign">
      <div className="onboarding-head">
        <div>
          <h2>Three building blocks, in this order</h2>
          <p>Finish the first missing one and the next opens. Saving any of these sends nothing.</p>
        </div>
        <span className="status-pill">{steps.filter((step) => step.done).length} of 3 ready</span>
      </div>
      <ol className="onboarding-steps">
        {steps.map((step) => {
          const isNext = next?.kind === step.kind;
          return <li key={step.kind} className={`${step.done ? 'is-done' : ''}${isNext ? ' is-next' : ''}`.trim()}>
            {step.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
            <div><strong>{step.title}</strong><small>{step.detail}</small></div>
            {isNext && step.kind === 'account' && <button className="primary-button" type="button" onClick={() => onNavigate('/outreach')}>
              Add account <ChevronRight size={14} />
            </button>}
          </li>;
        })}
      </ol>
    </section>}

    {loading && <section className="page-panel"><p className="empty-copy">Reading your campaign building blocks…</p></section>}

    {!loading && next?.kind === 'leads' && <div id="builder-leads"><LinkedInManagerLeadConfig onChanged={refresh} setToast={setToast} /></div>}
    {!loading && next?.kind === 'workflow' && <div id="builder-workflows"><LinkedInManagerWorkflowConfig onChanged={refresh} setToast={setToast} /></div>}

    {!loading && ready && <>
      <LinkedInManagerCampaignConfig
        key={`${readiness.seats}:${readiness.lists}:${readiness.workflows}`}
        onChanged={refresh}
        setToast={setToast}
        onNeedLeads={() => openEditor('builder-leads-library')}
        onNeedWorkflows={() => openEditor('builder-workflows-library')}
        onStarted={() => onNavigate('/outreach/manager')}
        prefill={prefill}
      />

      <section className="page-panel builder-library-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Need to change the building blocks?</h3>
            <p>Your saved lead lists and workflows are reusable. Edit them here without mixing those forms into the daily campaign dashboard.</p>
          </div>
        </div>

        <details className="builder-library" id="builder-leads-library">
          <summary><Users size={16} /> Lead lists <span>{readiness.lists} saved</span></summary>
          <LinkedInManagerLeadConfig onChanged={refresh} setToast={setToast} />
        </details>
        <details className="builder-library" id="builder-workflows-library">
          <summary><WorkflowIcon size={16} /> Workflows <span>{readiness.workflows} saved</span></summary>
          <LinkedInManagerWorkflowConfig onChanged={refresh} setToast={setToast} />
        </details>
      </section>
    </>}
  </div>;
}
