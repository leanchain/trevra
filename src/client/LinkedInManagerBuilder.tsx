import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Users, Workflow as WorkflowIcon } from 'lucide-react';
import {
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows
} from './api';
import {
  LinkedInManagerCampaignConfig,
  takeStagedCampaignPrefill
} from './LinkedInManagerCampaignConfig';
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
 * `/outreach/new` — construction only.
 *
 * This used to gate lead-list and workflow creation behind a three-step
 * checklist, one step visible at a time -- and the moment a step was done,
 * its editor unmounted with no way back short of finishing every other step
 * too. "I made a list, now I can't pick a different one" was a direct,
 * repeated report, not a hypothetical: the campaign form now handles leads
 * and workflows itself (a card picker plus inline upload / inline starter
 * templates), so there is nothing left to gate here except the one real,
 * rarely-repeated prerequisite -- a LinkedIn account exists at all.
 *
 * Full editing (the contacts table, the step-by-step workflow builder, the
 * ceiling detail) still exists. It's the "Manage" links below, loaded only
 * when clicked -- not auto-mounted, and in particular never auto-opening a
 * list's contacts the way the old checklist step did.
 */
export function OutreachManagerBuilder({
  setToast,
  onNavigate
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [readiness, setReadiness] = useState<Readiness>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefill] = useState(() => takeStagedCampaignPrefill());
  const [manageOpen, setManageOpen] = useState<'leads' | 'workflows' | null>(null);

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
      setError(
        errorMessage(err, 'Unable to read the campaign building blocks. Nothing was changed.')
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasAccount = readiness.seats > 0;

  return (
    <div className="page-stack">
      <div className="builder-back">
        <button className="ghost-button" type="button" onClick={() => onNavigate('/outreach')}>
          <ChevronLeft size={14} /> Back to campaigns
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && (
        <section className="page-panel">
          <p className="empty-copy">Reading your campaign building blocks…</p>
        </section>
      )}

      {!loading && !hasAccount && (
        <section className="onboarding-card mgr-first-campaign">
          <div className="onboarding-head">
            <div>
              <h2>Add a LinkedIn account first</h2>
              <p>A campaign sends from a real account, with its own hours and limits.</p>
            </div>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => onNavigate('/outreach/settings')}
          >
            Add account <ChevronRight size={14} />
          </button>
        </section>
      )}

      {!loading && hasAccount && (
        <>
          <LinkedInManagerCampaignConfig
            onChanged={refresh}
            setToast={setToast}
            onStarted={() => onNavigate('/outreach')}
            prefill={prefill}
          />

          <section className="page-panel builder-library-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>Need more control?</h3>
                <p>
                  Edit the leads or steps in an existing list or workflow, or manage everything
                  you've saved.
                </p>
              </div>
            </div>
            <div className="mgr-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setManageOpen((current) => (current === 'leads' ? null : 'leads'))}
              >
                <Users size={14} /> Manage lead lists ({readiness.lists})
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  setManageOpen((current) => (current === 'workflows' ? null : 'workflows'))
                }
              >
                <WorkflowIcon size={14} /> Manage workflows ({readiness.workflows})
              </button>
            </div>
            {manageOpen === 'leads' && (
              <LinkedInManagerLeadConfig onChanged={refresh} setToast={setToast} />
            )}
            {manageOpen === 'workflows' && (
              <LinkedInManagerWorkflowConfig onChanged={refresh} setToast={setToast} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
