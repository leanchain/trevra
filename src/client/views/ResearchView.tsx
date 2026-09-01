import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, Database, LoaderCircle, MessageSquare, Newspaper, X } from 'lucide-react';
import type { ConnectionSummary, SkillRun } from '../../shared/types';
import {
  createWatch,
  draftMentionReply,
  getOutreachOfferDefaults,
  getOutreachThreads,
  getSkillRuns,
  getWatchMentions,
  getWatchTrend,
  getWatches,
  runWatch,
  startPlaybook,
  type BrandWatch,
  type BrandWatchMention,
  type FeedThread,
  type OutreachOffer,
  type WatchPlatformReport,
  type WatchTrendPoint
} from '../api';
import { RedditAccountPanel } from '../RedditScreen';
import { ResearchScreen } from '../ResearchScreen';
import { EvidenceList } from './inspector';
import {
  chipPoints,
  factsLine,
  platformLabel,
  sentimentChip,
  trendHeadline,
  whyChips
} from './researchFormat';
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

// linkedin is absent on purpose: its scout is permanently disabled by policy,
// so a watch on it could only ever report that.
//
// devto is absent too, as of the whole-branch fix wave (2026-09-01):
// devtoScout.search has no keyword search endpoint -- it always loops the
// four hardcoded DEVTO_TAGS and filters locally, and it never reads
// ScoutQuery.communities, so the `communities: []` sitewide mechanism every
// other watch platform relies on is a silent no-op for it. A watch for a
// brand outside ai/llm/programming/productivity would report "nobody
// mentions you" having only ever looked at those four tags. Still used by
// gtm.scout-threads, which never claimed sitewide coverage from it.
const WATCH_PLATFORMS = ['hackernews', 'stackoverflow', 'lobsters', 'github', 'reddit', 'mastodon'];
// lobsters dropped from the default set 2026-09-01: it has no server-side
// search (client-side filter over the current `newest.json` window only) and
// measured zero mentions for two high-traffic terms. Still selectable in
// WATCH_PLATFORMS above. See docs/superpowers/specs/2026-08-30-brand-keyword-watch-design.md.
const WATCH_DEFAULT_PLATFORMS = ['hackernews', 'stackoverflow', 'github'];

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

/**
 * The credential-gap note for the mentions empty state: the reason for
 * every platform that isn't `ready`, so a founder whose only real source
 * needs a credential never reads that as "nobody is talking about us" (the
 * risk this whole panel exists to avoid).
 *
 * `watch.platformAvailability` is computed server-side at read time, so it
 * is correct even before anyone has clicked "Run now" this session. A more
 * recent `runReports` (from `runSelectedWatch`, scoped to this same watch by
 * the caller) is merged over it per platform, since a run can surface a
 * failure `platformAvailability` alone would not know about.
 */
function mergedAvailabilityNote(
  watch: BrandWatch | null,
  runReports: WatchPlatformReport[] | null
): string {
  if (!watch) return '';
  const merged = new Map(
    watch.platformAvailability.map((entry) => [entry.platform, entry] as const)
  );
  if (runReports) {
    for (const report of runReports) {
      merged.set(report.platform, {
        platform: report.platform,
        mode: report.availability.mode,
        reason: report.availability.reason
      });
    }
  }
  return [...merged.values()]
    .filter((entry) => entry.mode !== 'ready')
    .map((entry) => entry.reason)
    .join(' ');
}

/**
 * What actually happened on the watch's last run, per platform -- distinct
 * from `mergedAvailabilityNote` above, which only ever reports a platform's
 * static credential/policy MODE. A platform stays `ready` even when every
 * request it made degraded to a warning (a 403, a timeout, a throttle --
 * `outreach/scouts/http.ts`'s degrade contract), so a founder reading only
 * the availability note would see nothing wrong. `watch.lastRunWarnings` is
 * written by `runBrandWatch` from exactly that degrade path, so it is
 * current after the worker's own cadence sweep, not only after a manual
 * "Run now" in this session.
 */
function lastRunWarningsNote(watch: BrandWatch | null): string {
  if (!watch) return '';
  return watch.lastRunWarnings.map((entry) => entry.reason).join(' ');
}

/*
 * The draft dialog stops at approval -- it starts `gtm.thread-reply` and
 * hands the run to the founder's queue. Nothing here sends or posts
 * anything; every label says draft, prepare, or approval instead.
 */
function DraftDialog({
  title,
  offer,
  setOffer,
  starting,
  dialogError,
  onCancel,
  onSubmit
}: {
  title: string;
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
            <h3 id={titleId}>{title}</h3>
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

/**
 * Creates a `BrandWatch` -- structured exactly like `DraftDialog`, since it is
 * the same drawer chrome (`createPortal`, `.drawer-backdrop`, `.drawer`,
 * `useDialog`) used for a form instead of an approval.
 */
function WatchDialog({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (watch: BrandWatch) => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const [name, setName] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(WATCH_DEFAULT_PLATFORMS);
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!submitting) onClose();
  };
  useDialog(dialog, close);

  const keywords = keywordsText
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== '');
  const canSubmit =
    !submitting && name.trim() !== '' && keywords.length > 0 && platforms.length > 0;

  function togglePlatform(platform: string): void {
    setPlatforms((current) =>
      current.includes(platform)
        ? current.filter((entry) => entry !== platform)
        : [...current, platform]
    );
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const watch = await createWatch({ name: name.trim(), keywords, platforms, cadence });
      onCreated(watch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the watch.');
    } finally {
      setSubmitting(false);
    }
  }

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
            <span className="drawer-kicker">New watch</span>
            <h3 id={titleId}>Track a brand or keyword</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close without creating a watch"
            disabled={submitting}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <label>
            Name
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Keywords (comma-separated)
            <input
              type="text"
              value={keywordsText}
              onChange={(event) => setKeywordsText(event.target.value)}
            />
          </label>
          <div>
            <span className="li-filter-label">Platforms</span>
            <div className="client-why">
              {WATCH_PLATFORMS.map((platform) => (
                <label className="client-status" key={platform}>
                  <input
                    type="checkbox"
                    checked={platforms.includes(platform)}
                    onChange={() => togglePlatform(platform)}
                  />
                  {platformLabel(platform)}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="li-filter-label">Cadence</span>
            <div className="client-why">
              <label className="client-status">
                <input
                  type="radio"
                  name="watch-cadence"
                  checked={cadence === 'daily'}
                  onChange={() => setCadence('daily')}
                />
                Daily
              </label>
              <label className="client-status">
                <input
                  type="radio"
                  name="watch-cadence"
                  checked={cadence === 'weekly'}
                  onChange={() => setCadence('weekly')}
                />
                Weekly
              </label>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={submitting} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canSubmit}
            onClick={() => {
              void submit();
            }}
          >
            {submitting && <LoaderCircle className="spin" size={16} />}
            Create watch
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
  const [redditOpen, setRedditOpen] = useState(false);
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

  const [watches, setWatches] = useState<BrandWatch[]>([]);
  const [watchesLoaded, setWatchesLoaded] = useState(false);
  const [selectedWatch, setSelectedWatch] = useState<string | null>(null);
  const [mentions, setMentions] = useState<BrandWatchMention[]>([]);
  const [mentionsLoaded, setMentionsLoaded] = useState(false);
  const [mentionsError, setMentionsError] = useState(false);
  const [trend, setTrend] = useState<WatchTrendPoint[]>([]);
  // The last "Run now" result for the selected watch, if any -- fresher than
  // the watch's own `platformAvailability`, and merged over it by
  // `mergedAvailabilityNote`. Reset whenever the selected watch changes so a
  // stale run's report never gets attributed to a different watch.
  const [runReports, setRunReports] = useState<WatchPlatformReport[] | null>(null);
  const [watchDialogOpen, setWatchDialogOpen] = useState(false);
  const [runningWatch, setRunningWatch] = useState(false);
  const [draftingMention, setDraftingMention] = useState<BrandWatchMention | null>(null);

  // Mirrors `selectedWatch` so an in-flight `runSelectedWatch` call can tell,
  // after each await, whether the selection has since moved on -- a plain
  // closed-over variable would always read the value from the render that
  // started the call, never a later one.
  const selectedWatchRef = useRef<string | null>(null);
  useEffect(() => {
    selectedWatchRef.current = selectedWatch;
  }, [selectedWatch]);

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

  // Loads once. The first watch is selected automatically once the list is
  // in, via the functional update below, so this effect never needs
  // `selectedWatch` in its dependency array.
  useEffect(() => {
    let cancelled = false;
    getWatches()
      .then((rows) => {
        if (cancelled) return;
        setWatches(rows);
        setWatchesLoaded(true);
        setSelectedWatch((current) => current ?? rows[0]?.id ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setWatches([]);
        setWatchesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRunReports(null);
    if (!selectedWatch) {
      setMentions([]);
      setTrend([]);
      setMentionsError(false);
      setMentionsLoaded(true);
      return;
    }
    let cancelled = false;
    setMentionsLoaded(false);
    Promise.all([getWatchMentions(selectedWatch), getWatchTrend(selectedWatch)])
      .then(([rows, points]) => {
        if (cancelled) return;
        setMentions(rows);
        setTrend(points);
        setMentionsError(false);
        setMentionsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setMentions([]);
        setTrend([]);
        setMentionsError(true);
        setMentionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWatch]);

  useEffect(() => {
    if (!drafting && !draftingMention) return;
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
  }, [drafting, draftingMention]);

  // A 201 only means the run was accepted -- the guard step can still fail
  // synchronously (e.g. a blocked thread's daily cap or cooldown), landing
  // the run at `failed` instead of `waiting_approval`. That is an answer, not
  // a fault: report it as blocked rather than as success (spec §4). Shared by
  // thread drafts and mention drafts so a promoted mention lands in the same
  // approval queue, reported the same way.
  function reportPlaybookOutcome(run: Awaited<ReturnType<typeof startPlaybook>>): void {
    if (run.status === 'waiting_approval') {
      setToast(`Draft prepared for approval (run ${run.id}).`);
    } else {
      setToast(`Blocked: ${run.error ?? 'The run did not reach approval.'}`);
    }
  }

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
      reportPlaybookOutcome(run);
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

  async function startMentionDraft(mention: BrandWatchMention): Promise<void> {
    if (!selectedWatch) return;
    const watchId = selectedWatch;
    setStarting(true);
    setDialogError(null);
    let promoted = false;
    try {
      const run = await draftMentionReply(watchId, mention.id, offer);
      setDraftingMention(null);
      setOffer(EMPTY_OFFER);
      reportPlaybookOutcome(run);
      promoted = true;
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Could not start the draft.');
    } finally {
      setStarting(false);
    }
    if (!promoted) return;
    // The mention was just promoted server-side (201) -- refetch so its
    // card's promotedRunId flips and it stops offering "Draft reply"
    // (clicking it again would only 409, but it should not be offered at
    // all). Same staleness guard as runSelectedWatch: the founder can
    // switch watches while this was in flight, and a stale mention list
    // must not clobber whatever watch is now selected. A refetch failure
    // does not undo the promotion, so it is swallowed rather than surfaced
    // as a draft error -- the button simply stays visible until the next
    // natural refresh (switching watches, or a manual "Run now").
    if (selectedWatchRef.current !== watchId) return;
    try {
      const freshMentions = await getWatchMentions(watchId);
      if (selectedWatchRef.current === watchId) setMentions(freshMentions);
    } catch {
      /* best-effort refresh only */
    }
  }

  function closeMentionDraftDialog(): void {
    if (starting) return;
    setDraftingMention(null);
    setDialogError(null);
  }

  async function runSelectedWatch(): Promise<void> {
    const watchId = selectedWatch;
    if (!watchId) return;
    setRunningWatch(true);
    try {
      const result = await runWatch(watchId);
      if (result.warnings.length > 0) setToast(result.warnings.join(' '));
      // The selection can move on while this is in flight (click watch A's
      // "Run now", then click watch B's pill before A's response lands) -- a
      // stale response must not clobber whatever is now on screen.
      if (selectedWatchRef.current !== watchId) return;
      setRunReports(result.reports);
      // Refetched, not patched in place: `runBrandWatch` already persisted
      // `lastRunAt`/`lastRunWarnings` before this response returned, and a
      // full refetch is the only way this screen picks them up. Without it
      // `lastRunAt` stayed null after a manual run and the empty state kept
      // reading "This watch runs daily; nothing found yet." right after the
      // founder ran it.
      const [freshMentions, freshTrend, freshWatches] = await Promise.all([
        getWatchMentions(watchId),
        getWatchTrend(watchId),
        getWatches()
      ]);
      if (selectedWatchRef.current !== watchId) return;
      setMentions(freshMentions);
      setMentionsError(false);
      setMentionsLoaded(true);
      setTrend(freshTrend);
      setWatches(freshWatches);
    } catch (error) {
      if (selectedWatchRef.current === watchId) {
        setToast(error instanceof Error ? error.message : 'Could not run the watch.');
      }
    } finally {
      setRunningWatch(false);
    }
  }

  const renderableBriefs = briefs
    .map((run) => ({ run, brief: asResearchBrief(run.output) }))
    .filter(
      (entry): entry is { run: SkillRun; brief: ResearchBriefOutput } => entry.brief !== null
    );

  const showBriefs = platform === 'all' || platform === 'linkedin';
  const showRedditCorpus = platform === 'all' || platform === 'reddit';
  const selectedWatchRow = watches.find((watch) => watch.id === selectedWatch) ?? null;
  const watchAvailabilityNote = mergedAvailabilityNote(selectedWatchRow, runReports);
  const watchRunWarningsNote = lastRunWarningsNote(selectedWatchRow);

  return (
    <div className="page-stack">
      <section className="research-toolbar">
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

      {watchesLoaded && (
        <section className="research-watch-bar">
          <div className="li-filter-row" role="group" aria-label="Watch">
            <span className="li-filter-label">Watches</span>
            {watches.map((watch) => (
              <button
                key={watch.id}
                type="button"
                className={`li-range ${selectedWatch === watch.id ? 'is-active' : ''}`}
                aria-pressed={selectedWatch === watch.id}
                onClick={() => setSelectedWatch(watch.id)}
              >
                {watch.name}
              </button>
            ))}
            <button type="button" className="li-range" onClick={() => setWatchDialogOpen(true)}>
              New watch
            </button>
          </div>
          {selectedWatchRow && (
            <p className="research-watch-meta">
              Runs {selectedWatchRow.cadence}.{' '}
              {selectedWatchRow.lastRunAt
                ? `Last run ${new Date(selectedWatchRow.lastRunAt).toLocaleString()}.`
                : 'Not run yet.'}{' '}
              <button type="button" onClick={() => void runSelectedWatch()} disabled={runningWatch}>
                {runningWatch ? 'Running…' : 'Run now'}
              </button>
            </p>
          )}
          {watches.length === 0 && (
            <p className="research-watch-empty">
              Create a watch to start tracking mentions of your brand or a keyword.
            </p>
          )}
        </section>
      )}

      <div className="research-feed-grid">
        <section className="page-panel research-thread-panel">
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

        {selectedWatch !== null && (
          <section className="page-panel research-mention-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>Mentions</h3>
                <p>Where this watch’s keywords came up, and how it was said.</p>
              </div>
              {mentionsLoaded && !mentionsError && (
                <div className="research-trend-wrap">
                  <span className="research-trend-headline">{trendHeadline(trend)}</span>
                  <div className="research-trend" aria-label="Sentiment over the last 30 days">
                    {trend.map((point) => {
                      const total = point.positive + point.neutral + point.negative;
                      const tone =
                        total === 0
                          ? 'is-empty'
                          : point.average > 0.15
                            ? 'is-positive'
                            : point.average < -0.15
                              ? 'is-negative'
                              : 'is-neutral';
                      const description =
                        total === 0
                          ? `${point.day}: no mentions`
                          : `${point.day}: +${point.positive} / ${point.neutral} / -${point.negative}`;
                      return (
                        <span
                          key={point.day}
                          role="img"
                          aria-label={description}
                          title={description}
                          className={`research-trend-bar ${tone}`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="client-table">
              {mentionsLoaded &&
                !mentionsError &&
                mentions.map((mention) => {
                  const chip = sentimentChip(mention);
                  return (
                    <article className="client-card-large" key={mention.id}>
                      <div className="client-avatar large">
                        {platformLabel(mention.platform).slice(0, 2)}
                      </div>
                      <div>
                        <h3>
                          <a href={mention.url} target="_blank" rel="noreferrer">
                            {mention.title || mention.url}
                          </a>
                        </h3>
                        <span className={`client-status research-sentiment ${chip.tone}`}>
                          {chip.text}
                        </span>
                      </div>
                      {mention.promotedRunId ? (
                        <span className="client-status">Promoted to a reply run</span>
                      ) : (
                        <button type="button" onClick={() => setDraftingMention(mention)}>
                          Draft reply
                        </button>
                      )}
                    </article>
                  );
                })}
              {!mentionsLoaded && (
                <div className="empty-state">
                  <LoaderCircle />
                </div>
              )}
              {mentionsLoaded && mentionsError && (
                <div className="empty-state">
                  <CircleAlert /> Mentions could not be loaded.
                </div>
              )}
              {mentionsLoaded && !mentionsError && mentions.length === 0 && (
                <div className="empty-state">
                  <MessageSquare />
                  {selectedWatchRow?.lastRunAt
                    ? 'Nothing found on the last run.'
                    : `This watch runs ${selectedWatchRow?.cadence ?? 'daily'}; nothing found yet.`}
                  {watchAvailabilityNote && <p>{watchAvailabilityNote}</p>}
                  {watchRunWarningsNote && <p>{watchRunWarningsNote}</p>}
                </div>
              )}
            </div>
          </section>
        )}

        {showBriefs && (
          <section className="page-panel research-brief-panel">
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
      </div>

      {showRedditCorpus && (
        // Closed on first render: most operators are not managing Reddit sources
        // on every visit, and mounting it only once opened means it does not
        // fetch its sources/runs/search state until someone asks for it.
        <details
          className="mgr-inputs"
          open={redditOpen}
          onToggle={(event) => setRedditOpen(event.currentTarget.open)}
        >
          <summary>
            <Database size={13} /> Reddit research corpus
          </summary>
          <div className="mgr-inputs-body">
            {redditOpen && <RedditAccountPanel setToast={setToast} />}
            {redditOpen && <ResearchScreen connections={connections} setToast={setToast} />}
          </div>
        </details>
      )}

      {drafting && (
        <DraftDialog
          title={drafting.row.title}
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

      {draftingMention && (
        <DraftDialog
          title={draftingMention.title || draftingMention.url}
          offer={offer}
          setOffer={setOffer}
          starting={starting}
          dialogError={dialogError}
          onCancel={closeMentionDraftDialog}
          onSubmit={() => {
            void startMentionDraft(draftingMention);
          }}
        />
      )}

      {watchDialogOpen && (
        <WatchDialog
          onClose={() => setWatchDialogOpen(false)}
          onCreated={(watch) => {
            setWatches((current) => [...current, watch]);
            setSelectedWatch(watch.id);
            setWatchDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}
