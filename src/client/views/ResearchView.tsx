import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, LoaderCircle, MessageSquare, Newspaper, X } from 'lucide-react';
import type { ConnectionSummary, SkillRun } from '../../shared/types';
import {
  getOutreachOfferDefaults,
  getOutreachThreads,
  getSkillRuns,
  startPlaybook,
  type FeedThread,
  type OutreachOffer
} from '../api';
import { ResearchScreen } from '../ResearchScreen';
import { EvidenceList } from './inspector';
import { chipPoints, factsLine, platformLabel, whyChips } from './researchFormat';
import { useDialog } from '../ui/dialog';

/*
 * `/research` -- one feed over three sources that never shared a screen:
 * the outreach_threads table (LinkedIn/Reddit/HN/GitHub/etc, scored,
 * previously had NO reader at all), gtm.research-brief skill-run output
 * (company-level findings, already queryable but never rendered as a feed),
 * and the pre-existing Reddit corpus screen (relocated in unchanged).
 *
 * See docs/superpowers/specs/2026-08-18-research-hub-design.md.
 */

// Filter keys only -- display names come from researchFormat's platformLabel,
// so the platform-name -> label mapping is never declared twice.
const PLATFORM_FILTERS = [
  'all',
  'linkedin',
  'reddit',
  'hackernews',
  'github',
  'devto',
  'lobsters',
  'mastodon',
  'stackoverflow'
];

const EMPTY_OFFER: OutreachOffer = { name: '', url: '', summary: '', mechanism: '', claims: [] };

// Mirrors threadReplyPlaybook's zod schema (registry.ts) so an offer that
// would 400 on submit is caught here instead of round-tripping to the server.
const OFFER_NAME_MAX = 80;
const OFFER_TEXT_MAX = 300;
// Same schema: claims caps at 8 entries, each label/value capped at 80 --
// the same limit as OFFER_NAME_MAX, reused rather than re-declared.
const OFFER_CLAIMS_MAX = 8;

function isValidOfferUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function offerIsSubmittable(offer: OutreachOffer): boolean {
  const name = offer.name.trim();
  const summary = offer.summary.trim();
  const mechanism = offer.mechanism.trim();
  return (
    name !== '' &&
    name.length <= OFFER_NAME_MAX &&
    isValidOfferUrl(offer.url) &&
    summary !== '' &&
    summary.length <= OFFER_TEXT_MAX &&
    mechanism !== '' &&
    mechanism.length <= OFFER_TEXT_MAX &&
    // A prefilled brief can carry more or longer proof entries than the
    // playbook accepts (e.g. 9 claims) -- without this the button enables
    // and submit 400s with no on-screen way to see why.
    offer.claims.length <= OFFER_CLAIMS_MAX &&
    offer.claims.every(
      (claim) =>
        claim.label.trim() !== '' &&
        claim.label.length <= OFFER_NAME_MAX &&
        claim.value.trim() !== '' &&
        claim.value.length <= OFFER_NAME_MAX
    )
  );
}

interface ResearchBriefOutput {
  domain: string | null;
  topFinding: string;
  findingDetail: string;
}

/** `SkillRun.output` is `unknown` -- a research brief is only ever rendered once these fields are confirmed present. */
function asResearchBrief(output: unknown): ResearchBriefOutput | null {
  if (!output || typeof output !== 'object') return null;
  const value = output as Record<string, unknown>;
  if (typeof value.topFinding !== 'string' || typeof value.findingDetail !== 'string') return null;
  return {
    domain: typeof value.domain === 'string' ? value.domain : null,
    topFinding: value.topFinding,
    findingDetail: value.findingDetail
  };
}

/*
 * The draft dialog stops at approval -- it starts `gtm.thread-reply` and
 * hands the run to the founder's queue. Nothing here sends or posts
 * anything; every label says draft, prepare, or approval instead.
 */
function DraftDialog({
  entry,
  offer,
  setOffer,
  starting,
  dialogError,
  onCancel,
  onSubmit
}: {
  entry: FeedThread;
  offer: OutreachOffer;
  setOffer: (offer: OutreachOffer) => void;
  starting: boolean;
  dialogError: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const close = () => {
    if (!starting) onCancel();
  };
  useDialog(dialog, close);

  const canSubmit = !starting && offerIsSubmittable(offer);

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={close}>
      <section
        ref={dialog}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="drawer-kicker">Draft reply</span>
            <h3 id={titleId}>{entry.row.title}</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close without drafting anything"
            disabled={starting}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <label>
            Product name
            <input
              type="text"
              value={offer.name}
              onChange={(event) => setOffer({ ...offer, name: event.target.value })}
            />
          </label>
          <label>
            Product URL
            <input
              type="text"
              value={offer.url}
              onChange={(event) => setOffer({ ...offer, url: event.target.value })}
            />
          </label>
          <label>
            Summary
            <textarea
              rows={2}
              value={offer.summary}
              onChange={(event) => setOffer({ ...offer, summary: event.target.value })}
            />
          </label>
          <label>
            Mechanism
            <textarea
              rows={2}
              value={offer.mechanism}
              onChange={(event) => setOffer({ ...offer, mechanism: event.target.value })}
            />
          </label>
          {offer.claims.length > 0 && (
            <div>
              <span className="li-filter-label">Claims</span>
              {/* Read-only rendering let an over-cap or over-length brief (e.g. 9
                  proof entries) prefill with no way to get back under the
                  playbook's caps -- removal is the minimum edit that always
                  gets an offer back to submittable. */}
              <div className="client-why">
                {offer.claims.map((claim, index) => (
                  <span className="client-status" key={`${claim.label}-${index}`}>
                    {claim.label}: {claim.value}
                    <button
                      type="button"
                      className="claim-remove"
                      aria-label={`Remove claim ${claim.label}`}
                      disabled={starting}
                      onClick={() =>
                        setOffer({
                          ...offer,
                          claims: offer.claims.filter((_, at) => at !== index)
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {dialogError && <div className="error-banner">{dialogError}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={starting} onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={!canSubmit} onClick={onSubmit}>
            {starting && <LoaderCircle className="spin" size={16} />}
            Prepare draft
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

export function ResearchView({
  connections,
  setToast
}: {
  connections: ConnectionSummary[];
  setToast: (message: string) => void;
}) {
  const [platform, setPlatform] = useState('all');
  const [threads, setThreads] = useState<FeedThread[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsError, setThreadsError] = useState(false);
  const [briefs, setBriefs] = useState<SkillRun[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);
  const [briefsError, setBriefsError] = useState(false);

  const now = useMemo(() => new Date(), []);

  const [drafting, setDrafting] = useState<FeedThread | null>(null);
  const [offer, setOffer] = useState<OutreachOffer>(EMPTY_OFFER);
  const [starting, setStarting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThreadsLoaded(false);
    getOutreachThreads(platform === 'all' ? {} : { platform })
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        setThreadsError(false);
        setThreadsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setThreads([]);
        setThreadsError(true);
        setThreadsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    let cancelled = false;
    getSkillRuns({ skillId: 'gtm.research-brief', status: 'ok', limit: 50 })
      .then((runs) => {
        if (cancelled) return;
        setBriefs(runs);
        setBriefsError(false);
        setBriefsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBriefsError(true);
        setBriefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!drafting) return;
    // Cleared before the prefill resolves (and if it never does) so a new
    // thread's dialog never opens holding the previous thread's edits.
    setOffer(EMPTY_OFFER);
    let cancelled = false;
    getOutreachOfferDefaults()
      .then((loaded) => {
        if (!cancelled) setOffer(loaded);
      })
      .catch(() => {
        /* An absent brief is not an error; the dialog stays editable and empty. */
      });
    return () => {
      cancelled = true;
    };
  }, [drafting]);

  async function startDraft(entry: FeedThread): Promise<void> {
    setStarting(true);
    setDialogError(null);
    try {
      const run = await startPlaybook('gtm.thread-reply', {
        thread: {
          platform: entry.row.platform,
          externalId: entry.row.external_id,
          url: entry.row.url,
          title: entry.row.title,
          content: entry.row.content,
          author: entry.row.author,
          community: entry.row.community,
          score: entry.row.score,
          numComments: entry.row.num_comments,
          createdAt: entry.row.thread_created_at,
          metadata: entry.row.metadata_json
        },
        angle: entry.angle,
        relevanceScore: entry.relevance.score,
        product: offer
      });
      setDrafting(null);
      setOffer(EMPTY_OFFER);
      // A 201 only means the run was accepted -- the guard step can still fail
      // synchronously (e.g. a blocked thread's daily cap or cooldown), landing
      // the run at `failed` instead of `waiting_approval`. That is an answer,
      // not a fault: report it as blocked rather than as success (spec §4).
      if (run.status === 'waiting_approval') {
        setToast(`Draft prepared for approval (run ${run.id}).`);
      } else {
        setToast(`Blocked: ${run.error ?? 'The run did not reach approval.'}`);
      }
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Could not start the draft.');
    } finally {
      setStarting(false);
    }
  }

  function closeDraftDialog(): void {
    if (starting) return;
    setDrafting(null);
    setDialogError(null);
  }

  const renderableBriefs = briefs
    .map((run) => ({ run, brief: asResearchBrief(run.output) }))
    .filter(
      (entry): entry is { run: SkillRun; brief: ResearchBriefOutput } => entry.brief !== null
    );

  const showBriefs = platform === 'all' || platform === 'linkedin';
  const showRedditCorpus = platform === 'all' || platform === 'reddit';

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h2>Research</h2>
            <p>
              Everything discovered or drafted from community and company research, across every
              connected platform.
            </p>
          </div>
        </div>
        <div className="li-filter-row" role="group" aria-label="Platform">
          <span className="li-filter-label">Platform</span>
          {PLATFORM_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`li-range ${platform === key ? 'is-active' : ''}`}
              aria-pressed={platform === key}
              onClick={() => setPlatform(key)}
            >
              {key === 'all' ? 'All' : platformLabel(key)}
            </button>
          ))}
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Discovered threads</h3>
            <p>Community threads scouted and scored for reply-worthiness.</p>
          </div>
        </div>
        <div className="client-table">
          {threadsLoaded &&
            !threadsError &&
            threads.map((entry) => (
              <article
                className={`client-card-large ${entry.guard.allowed ? '' : 'is-blocked'}`}
                key={entry.row.id}
              >
                <span className="client-avatar large">{entry.relevance.score.toFixed(1)}</span>
                <div>
                  <h3>
                    <a href={entry.row.url} target="_blank" rel="noreferrer">
                      {entry.row.title}
                    </a>
                  </h3>
                  <p>{factsLine(entry, now)}</p>
                  <p className="client-why">
                    {whyChips(entry).map((chip) => (
                      <span
                        className={`client-status ${chip.tone === 'negative' ? 'is-negative' : ''}`}
                        key={chip.label}
                      >
                        {chip.label} <b>{chipPoints(chip)}</b>
                      </span>
                    ))}
                  </p>
                  <p>
                    angle: {entry.angle}
                    {entry.topics.length > 0 ? ` · topics: ${entry.topics.join(', ')}` : ''}
                  </p>
                  {!entry.guard.allowed && (
                    <p className="client-blocked">Blocked: {entry.guard.reason}</p>
                  )}
                  <button
                    type="button"
                    className="li-range"
                    disabled={!entry.guard.allowed}
                    onClick={() => setDrafting(entry)}
                  >
                    Draft reply
                  </button>
                </div>
              </article>
            ))}
          {!threadsLoaded && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={26} />
              <h4 aria-level={3}>Loading…</h4>
              <p>One moment.</p>
            </div>
          )}
          {threadsLoaded && threadsError && (
            <div className="empty-state">
              <CircleAlert size={26} />
              <h4 aria-level={3}>Couldn't load discovered threads</h4>
              <p>Something went wrong fetching this. Try reloading the page.</p>
            </div>
          )}
          {threadsLoaded && !threadsError && threads.length === 0 && (
            <div className="empty-state">
              <MessageSquare size={26} />
              <h4 aria-level={3}>No threads discovered yet</h4>
              <p>Scouting runs on its own schedule; check back once it has run.</p>
            </div>
          )}
        </div>
      </section>

      {showBriefs && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Company research</h3>
              <p>Findings drawn from company audits and enrichment, used to draft outreach.</p>
            </div>
          </div>
          <div className="client-table">
            {briefsLoaded &&
              !briefsError &&
              renderableBriefs.map(({ run, brief }) => (
                <article className="client-card-large" key={run.id}>
                  <span className="client-avatar large">
                    {(brief.domain ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h3>{brief.domain ?? 'Unknown domain'}</h3>
                    <p>{brief.findingDetail}</p>
                    <span className="client-status">{brief.topFinding}</span>
                    {run.evidence.length > 0 && <EvidenceList entries={run.evidence} />}
                  </div>
                </article>
              ))}
            {!briefsLoaded && (
              <div className="empty-state">
                <LoaderCircle className="spin" size={26} />
                <h4 aria-level={3}>Loading…</h4>
                <p>One moment.</p>
              </div>
            )}
            {briefsLoaded && briefsError && (
              <div className="empty-state">
                <CircleAlert size={26} />
                <h4 aria-level={3}>Couldn't load research briefs</h4>
                <p>Something went wrong fetching this. Try reloading the page.</p>
              </div>
            )}
            {briefsLoaded && !briefsError && renderableBriefs.length === 0 && (
              <div className="empty-state">
                <Newspaper size={26} />
                <h4 aria-level={3}>No research briefs yet</h4>
                <p>These are generated when a company is researched for outreach.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {showRedditCorpus && <ResearchScreen connections={connections} setToast={setToast} />}

      {drafting && (
        <DraftDialog
          entry={drafting}
          offer={offer}
          setOffer={setOffer}
          starting={starting}
          dialogError={dialogError}
          onCancel={closeDraftDialog}
          onSubmit={() => {
            void startDraft(drafting);
          }}
        />
      )}
    </div>
  );
}
