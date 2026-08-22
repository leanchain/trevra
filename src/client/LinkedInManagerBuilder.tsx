import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Upload,
  Users,
  Workflow as WorkflowIcon
} from 'lucide-react';
import {
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  prepareOutreach
} from './api';
import {
  LinkedInManagerCampaignConfig,
  takeStagedCampaignPrefill
} from './LinkedInManagerCampaignConfig';
import { LinkedInManagerLeadConfig } from './LinkedInManagerLeadConfig';
import { LinkedInManagerWorkflowConfig } from './LinkedInManagerWorkflowConfig';
import { errorMessage } from './LinkedInSafety';
import { Select } from './ui/primitives';
interface Readiness {
  seats: number;
  lists: number;
  workflows: number;
}

const EMPTY: Readiness = { seats: 0, lists: 0, workflows: 0 };

type Seats = Awaited<ReturnType<typeof getLinkedInManagerSeats>>;

function newPreparationKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * `/outreach/new` defaults to the founder job, not the implementation objects.
 *
 * The ordinary path is people.csv -> safe Trevra defaults -> DRAFT campaign.
 * Existing list/workflow construction remains available below under Advanced;
 * simplification hides machinery, it never deletes the precise state model.
 */
export function OutreachManagerBuilder({
  setToast,
  onNavigate
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [readiness, setReadiness] = useState<Readiness>(EMPTY);
  const [seats, setSeats] = useState<Seats>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefill] = useState(() => takeStagedCampaignPrefill());
  const [manageOpen, setManageOpen] = useState<'leads' | 'workflows' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSeats, lists, workflows] = await Promise.all([
        getLinkedInManagerSeats(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagerWorkflows()
      ]);
      setSeats(nextSeats);
      setReadiness({ seats: nextSeats.length, lists: lists.length, workflows: workflows.length });
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
          <p className="empty-copy">Reading your outreach setup…</p>
        </section>
      )}

      {!loading && !hasAccount && (
        <section className="onboarding-card mgr-first-campaign">
          <div className="onboarding-head">
            <div>
              <h2>One thing is missing</h2>
              <p>Connect the LinkedIn account you want Trevra to use.</p>
            </div>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => onNavigate('/outreach/settings')}
          >
            Connect account <ChevronRight size={14} />
          </button>
        </section>
      )}

      {!loading && hasAccount && (
        <>
          <SimplePrepareOutreach
            seats={seats}
            setToast={setToast}
            onPrepared={(href) => onNavigate(href)}
          />

          <details className="page-panel builder-library-panel">
            <summary>
              <strong>Advanced campaign builder</strong>
              <span>Choose saved lead lists, edit workflows, schedules and campaign controls.</span>
            </summary>
            <div className="page-stack">
              <LinkedInManagerCampaignConfig
                onChanged={refresh}
                setToast={setToast}
                onCreated={(campaign) =>
                  onNavigate(`/outreach/campaign/${encodeURIComponent(campaign.id)}`)
                }
                prefill={prefill}
              />

              <section className="page-panel builder-library-panel">
                <div className="section-heading">
                  <div>
                    <h3 aria-level={2}>Saved building blocks</h3>
                    <p>
                      Edit existing people lists or workflow steps when the default is not enough.
                    </p>
                  </div>
                </div>
                <div className="mgr-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      setManageOpen((current) => (current === 'leads' ? null : 'leads'))
                    }
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
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function SimplePrepareOutreach({
  seats,
  setToast,
  onPrepared
}: {
  seats: Seats;
  setToast: (message: string) => void;
  onPrepared: (href: string) => void;
}) {
  const [name, setName] = useState('Prepared outreach');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [senderKey, setSenderKey] = useState(seats.length === 1 ? seats[0]!.seatKey : '');
  const [idempotencyKey, setIdempotencyKey] = useState(newPreparationKey);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (seats.length === 1) setSenderKey(seats[0]!.seatKey);
  }, [seats]);

  const changeIntent = () => setIdempotencyKey(newPreparationKey());

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setCsv(text);
      setFileName(file.name);
      changeIntent();
      setProblem('');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to read this CSV.'));
    }
  };

  const prepare = async () => {
    if (!csv.trim()) {
      setProblem('Add a CSV of people first.');
      return;
    }
    if (seats.length > 1 && !senderKey) {
      setProblem('Choose which LinkedIn account should send this outreach.');
      return;
    }
    setBusy(true);
    try {
      const result = await prepareOutreach({
        idempotencyKey,
        name: name.trim() || 'Prepared outreach',
        senderKey: senderKey || undefined,
        uploadedPeopleCsv: csv
      });
      setProblem('');
      setToast(
        `Campaign ready: ${result.campaign.enrolled} ${result.campaign.enrolled === 1 ? 'person' : 'people'}. Nothing has been sent.`
      );
      onPrepared(result.next.href);
    } catch (error) {
      // Keep the same idempotency key on failure. If the server prepared the
      // campaign but the response was lost, Retry must recover it, not duplicate it.
      setProblem(errorMessage(error, 'Unable to prepare this outreach. Nothing was sent.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="onboarding-card mgr-first-campaign">
      <div className="onboarding-head">
        <div>
          <h2>Prepare outreach</h2>
          <p>
            Give Trevra the people. It will prepare a safe default LinkedIn campaign for review.
          </p>
        </div>
      </div>

      <div className="form-grid">
        <label>
          Campaign name
          <input
            value={name}
            maxLength={160}
            onChange={(event) => {
              setName(event.target.value);
              changeIntent();
            }}
          />
        </label>

        {seats.length > 1 && (
          <label>
            LinkedIn account
            <Select
              value={senderKey}
              onChange={(event) => {
                setSenderKey(event.target.value);
                changeIntent();
              }}
            >
              <option value="">Choose account</option>
              {seats.map((seat) => (
                <option key={seat.seatKey} value={seat.seatKey}>
                  {seat.label}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      <label className="import-dropzone">
        <Upload size={18} />
        <span>{fileName || 'Drop or choose a people CSV'}</span>
        <small>Use the same people CSV Trevra already accepts in lead lists.</small>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </label>

      {problem && <div className="error-banner">{problem}</div>}

      <div className="mgr-actions">
        <button
          className="primary-button"
          type="button"
          disabled={busy || !csv.trim()}
          onClick={() => void prepare()}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : null}
          Prepare campaign <ChevronRight size={15} />
        </button>
      </div>

      <p className="empty-copy">
        Trevra uses your configured account limits and a versioned safe default sequence. Nothing is
        sent until you review and start the draft campaign.
      </p>
    </section>
  );
}
