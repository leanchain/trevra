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
type LeadLists = Awaited<ReturnType<typeof getLinkedInManagerLeadLists>>;

function newPreparationKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * `/outreach/new` defaults to the founder job, not the implementation objects.
 *
 * The ordinary path is a saved people list (or an uploaded people.csv) -> safe
 * Trevra defaults -> DRAFT campaign.
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
              <p>Connect the LinkedIn account you want Trevra to use, in Setup · Workspace.</p>
            </div>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => onNavigate('/setup/workspace')}
          >
            Connect account in Setup <ChevronRight size={14} />
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
  /*
    THE PEOPLE THIS WORKSPACE ALREADY HAS.

    `/api/outreach/prepare` has always taken either an uploaded CSV or an
    `existingLeadListId`, and validates that exactly one is given. Only the CSV
    half was ever on screen, so a workspace with lead lists full of people had
    to re-export and re-upload them to start a campaign here. Lists are
    seat-scoped, hence the refetch when the sending account changes: offering a
    list the chosen sender cannot use would just be a 400 with extra steps.
  */
  const [leadLists, setLeadLists] = useState<LeadLists>([]);
  const [source, setSource] = useState<'list' | 'csv'>('list');
  const [leadListId, setLeadListId] = useState('');

  useEffect(() => {
    if (seats.length === 1) setSenderKey(seats[0]!.seatKey);
  }, [seats]);

  useEffect(() => {
    let live = true;
    if (!senderKey) {
      setLeadLists([]);
      return () => {
        live = false;
      };
    }
    void getLinkedInManagerLeadLists(senderKey)
      .then((lists) => {
        if (!live) return;
        setLeadLists(lists);
        setLeadListId((current) =>
          lists.some((list) => list.id === current) ? current : (lists[0]?.id ?? '')
        );
        setSource(lists.length > 0 ? 'list' : 'csv');
      })
      .catch(() => {
        if (live) setLeadLists([]);
      });
    return () => {
      live = false;
    };
  }, [senderKey]);

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

  const usingList = source === 'list';
  const ready = usingList ? Boolean(leadListId) : Boolean(csv.trim());

  const prepare = async () => {
    if (!ready) {
      setProblem(
        usingList ? 'Choose which saved list of people to reach.' : 'Add a CSV of people first.'
      );
      return;
    }
    if (seats.length > 1 && !senderKey) {
      setProblem('Choose which LinkedIn account should send this outreach.');
      return;
    }
    setBusy(true);
    try {
      // Exactly one source, because the server accepts exactly one.
      const result = await prepareOutreach({
        idempotencyKey,
        name: name.trim() || 'Prepared outreach',
        senderKey: senderKey || undefined,
        ...(usingList ? { existingLeadListId: leadListId } : { uploadedPeopleCsv: csv })
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

      {leadLists.length > 0 && (
        <div
          className="outreach-message-switch"
          role="group"
          aria-label="Where the people come from"
        >
          <button
            type="button"
            className={`li-range${usingList ? ' is-active' : ''}`}
            aria-pressed={usingList}
            onClick={() => {
              setSource('list');
              setProblem('');
              changeIntent();
            }}
          >
            Saved list
          </button>
          <button
            type="button"
            className={`li-range${usingList ? '' : ' is-active'}`}
            aria-pressed={!usingList}
            onClick={() => {
              setSource('csv');
              setProblem('');
              changeIntent();
            }}
          >
            Upload a CSV
          </button>
        </div>
      )}

      {usingList ? (
        <label className="li-block-label">
          People
          <Select
            value={leadListId}
            onChange={(event) => {
              setLeadListId(event.target.value);
              changeIntent();
            }}
          >
            <option value="">Choose a saved list</option>
            {leadLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} — {list.leadCount} {list.leadCount === 1 ? 'person' : 'people'}
              </option>
            ))}
          </Select>
          <small className="li-hint">
            {senderKey
              ? 'Lists belong to the sending account chosen above.'
              : 'Choose a LinkedIn account to see its saved lists.'}
          </small>
        </label>
      ) : (
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
      )}

      {problem && <div className="error-banner">{problem}</div>}

      <div className="mgr-actions">
        <button
          className="primary-button"
          type="button"
          disabled={busy || !ready}
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
