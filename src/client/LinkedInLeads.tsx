import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Users
} from 'lucide-react';
import {
  createLinkedInLeadSource,
  getLinkedInLeadSources,
  getLinkedInLeads,
  type LeadSourceKind,
  type LeadSourceStatus,
  type LinkedInLead,
  type LinkedInLeadSource
} from './api';
import { errorMessage, stageTargets, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';

/**
 * `#/outreach/leads` -- a search page or a post, walked into a list of people.
 *
 * THIS FEATURE IS OFF BY DEFAULT AND THAT IS DELIBERATE, which is the only
 * thing about this screen worth writing at length.
 *
 * Everything else in outreach automates the operator's OWN account: their
 * seat, their invites, their messages, paced so the account survives. Reading
 * other people's profiles out of a search page is a different act with a
 * different name on it -- it is scraping under LinkedIn's User Agreement 8.2 --
 * and the contractual exposure is not the same exposure. So it is a second,
 * separate opt-in, it is a config decision rather than a switch on a screen,
 * and a hosted deployment cannot grant it at all.
 *
 * Which means this screen renders `offReason` VERBATIM and offers no control
 * to change it. A toggle here would be the product quietly deciding for the
 * operator that the two risks are the same risk. They are not, and the copy
 * says so in two sentences rather than an essay nobody reads.
 *
 * THE LIST STILL READS WHEN IT IS OFF. A workspace with sources from before
 * the switch was turned off must still be able to see what they found; only
 * queueing a new walk is refused.
 */

const KIND_LABELS: Record<LeadSourceKind, string> = {
  search: 'People search',
  post: 'Post engagement'
};

const KIND_HINTS: Record<LeadSourceKind, string> = {
  search: 'A LinkedIn people-search results URL — the page you get after running a search, filters and all.',
  post: 'A LinkedIn post URL. The walk reads who reacted to it and who commented on it.'
};

/**
 * Keywords -> the people-search URL LinkedIn itself would produce.
 *
 * TYPING KEYWORDS IS THE WHOLE INTERACTION. The URL field fills itself as the
 * operator types, and the walk queues straight from that -- a step that only
 * ever produces one predictable string is a step the screen can take itself.
 *
 * It stays a convenience OVER the URL field, not a replacement for it.
 * Everything past a keyword string -- industry, seniority, company headcount,
 * connection degree -- lives in facet parameters whose values are LinkedIn's
 * own internal ids, and no honest version of this box can invent them. So the
 * operator who wants filters runs the search on LinkedIn and pastes it, and
 * hand-editing the URL stops the keywords overwriting it. The field is the
 * source of truth either way.
 */
function peopleSearchUrl(keywords: string): string | null {
  const query = keywords.trim().replace(/\s+/g, ' ');
  if (!query) return null;
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set('keywords', query);
  url.searchParams.set('origin', 'GLOBAL_SEARCH_HEADER');
  return url.toString();
}

const STATUS_LABELS: Record<LeadSourceStatus, string> = {
  pending: 'Queued',
  running: 'Walking',
  completed: 'Done',
  failed: 'Failed'
};

/** `https://www.linkedin.com/in/pankaj-x/` -> `in/pankaj-x`. The URL still links. */
const shortUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, '');
    return `${parsed.host}${path}`.slice(0, 90);
  } catch { return url.slice(0, 90); }
};

export function OutreachLeads({ setToast }: { setToast: (message: string) => void }) {
  const [sources, setSources] = useState<LinkedInLeadSource[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [offReason, setOffReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [kind, setKind] = useState<LeadSourceKind>('search');
  const [url, setUrl] = useState('');
  /** What to search for. Writes the URL below until the operator edits it themselves. */
  const [keywords, setKeywords] = useState('');
  /** True once the URL was hand-edited, after which keywords stop touching it. */
  const [urlDirty, setUrlDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  /** The source being drilled into. Null on the list. */
  const [openSource, setOpenSource] = useState<LinkedInLeadSource | null>(null);
  const [leads, setLeads] = useState<LinkedInLead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getLinkedInLeadSources(200);
      setSources(result.sources);
      setEnabled(result.enabled);
      setOffReason(result.offReason);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the lead sources. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  const queue = async () => {
    if (!url.trim()) { setError('Paste the URL of a LinkedIn people search or a post first.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await createLinkedInLeadSource({ kind, url: url.trim() });
      setToast(result.duplicate
        ? 'That URL is already queued or running — nothing was created, and the live source is in the list below.'
        : 'Queued. The walk happens on the local worker’s own tick, at paced gaps, in a real browser.');
      setUrl('');
      setKeywords('');
      setUrlDirty(false);
      await load();
    } catch (err) {
      // The 409 here is the opt-in refusing, and its sentence names which kind
      // of off it is. It reads verbatim, in the calm block, not as a fault.
      setError(errorMessage(err, 'Unable to queue that source'));
    } finally { setBusy(false); }
  };

  const openLeads = async (source: LinkedInLeadSource) => {
    setOpenSource(source);
    setLeads([]);
    setPicked(new Set());
    setLeadsLoading(true);
    try {
      const result = await getLinkedInLeads(source.id, 500);
      setLeads(result.leads);
      if (result.source) setOpenSource(result.source);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the people this source found'));
    } finally { setLeadsLoading(false); }
  };

  const toggle = (profileUrl: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(profileUrl)) next.delete(profileUrl); else next.add(profileUrl);
    return next;
  });

  const allPicked = leads.length > 0 && picked.size === leads.length;

  /**
   * Hand the picked people to the campaign builder.
   *
   * It STAGES them; it creates nothing. A campaign's targets are fixed when the
   * campaign is created, so this fills the field the operator is about to read
   * before they name the campaign — and they can still cut the list there.
   */
  const sendToBuilder = () => {
    const list = leads.filter((lead) => picked.has(lead.profileUrl)).map((lead) => lead.profileUrl);
    if (list.length === 0) return;
    stageTargets(list);
    setToast(`${list.length} profile URL(s) staged for the campaign builder. Nothing was created — they land in the targets field.`);
    window.location.hash = '#/outreach/campaigns';
  };

  return <div className="page-stack">
    {error && <div className="error-banner">{error}</div>}

    {/* Not an error, and it must not be styled as one: this is a deliberate
        posture, so it reads as an explanation with the server's own sentence
        in it and no control to overturn it. */}
    {!enabled && <section className="li-leads-off">
      <ShieldCheck size={20} />
      <div>
        <strong>Lead sourcing is off, on purpose.</strong>
        <p className="li-blocked-message">{offReason ?? 'Lead sourcing is switched off for this deployment.'}</p>
        <p>
          Everything else in outreach automates <em>your own</em> account. Harvesting profiles out of a search page is
          scraping someone else’s data, which carries a different contractual risk from acting on your own seat — so it
          is a separate opt-in made in config by whoever runs this deployment, and there is no switch for it on this
          screen.
        </p>
      </div>
    </section>}

    {openSource
      ? <LeadList
        source={openSource}
        leads={leads}
        loading={leadsLoading}
        picked={picked}
        allPicked={allPicked}
        onBack={() => { setOpenSource(null); setLeads([]); setPicked(new Set()); }}
        onToggle={toggle}
        onToggleAll={() => setPicked(allPicked ? new Set() : new Set(leads.map((lead) => lead.profileUrl)))}
        onSend={sendToBuilder}
      />
      : <>
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3>Walk a source</h3>
              <p>One URL becomes one walk. Nothing is fetched by this screen — the local worker opens the page in a real
                browser on its own tick, at paced gaps, and stores only what LinkedIn rendered.</p>
            </div>
            <ScanSearch size={20} className="li-heading-icon" />
          </div>

          {kind === 'search' && <div className="li-search-builder">
            <label>What are you searching for
              <input
                value={keywords}
                disabled={!enabled}
                placeholder="revops founder seed stage"
                onChange={(event) => {
                  const next = event.target.value;
                  setKeywords(next);
                  // The URL follows the keywords until the operator takes it over.
                  if (!urlDirty) setUrl(peopleSearchUrl(next) ?? '');
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || busy || !enabled) return;
                  event.preventDefault();
                  void queue();
                }}
              />
            </label>
            <p className="li-hint">
              Type and the URL below writes itself; Enter queues the walk. Filters — industry, seniority, headcount,
              connection degree — are LinkedIn’s own internal ids, so a filtered search is one you run on LinkedIn and
              paste into that field, which then stops following what you type here. Nothing is invented to stand in for
              them.
            </p>
          </div>}

          <div className="li-form-grid">
            <label>What kind of page
              <select value={kind} onChange={(event) => setKind(event.target.value as LeadSourceKind)} disabled={!enabled}>
                <option value="search">{KIND_LABELS.search}</option>
                <option value="post">{KIND_LABELS.post}</option>
              </select>
              <small className="li-hint">{KIND_HINTS[kind]}</small>
            </label>
            <label>URL
              <input
                value={url}
                disabled={!enabled}
                onChange={(event) => { setUrl(event.target.value); setUrlDirty(true); }}
                placeholder={kind === 'search'
                  ? 'https://www.linkedin.com/search/results/people/?keywords=…'
                  : 'https://www.linkedin.com/posts/…'}
              />
              <small className="li-hint">
                The URL is validated before the row exists, not before the fetch: a stored URL is one a worker will
                later open in a browser you are signed into.
              </small>
            </label>
          </div>

          <div className="panel-footer">
            <span>
              Queueing writes one row. It contacts nobody, and nobody on the exclusion list is dropped by this step —
              exclusions are applied where a plan is produced, before anything reaches a payload.
            </span>
            <button className="primary-button" type="button" disabled={busy || !enabled || !url.trim()} onClick={() => void queue()}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Queue this walk
            </button>
          </div>
        </section>

        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3>Sources</h3>
              <p>Result counts are people <em>stored</em>, not people seen.</p>
            </div>
            <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
              {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
            </button>
          </div>

          {sources.length === 0
            ? <p className="empty-copy">{enabled
              ? 'No source has been walked yet. Paste a search or a post URL above.'
              : 'No source was ever walked on this workspace, and none can be while lead sourcing is off.'}</p>
            : <div className="li-source-list">
              {sources.map((source) => <button
                key={source.id}
                type="button"
                className="li-source-row"
                onClick={() => void openLeads(source)}
              >
                <span className="li-source-top">
                  <span className="li-chip">{KIND_LABELS[source.kind]}</span>
                  <span className={`li-chip li-lead-${source.status}`}>{STATUS_LABELS[source.status] ?? source.status}</span>
                  <span className="li-source-count">{source.resultCount ?? 0} stored</span>
                </span>
                <span className="li-source-url">{shortUrl(source.url)}</span>
                <span className="li-source-meta">
                  Queued {relativeTime(source.requestedAt)}
                  {source.finishedAt && ` · finished ${relativeTime(source.finishedAt)}`}
                </span>
                {source.failureReason && <span className="li-source-failure">
                  <CircleAlert size={12} /> {source.failureReason}
                </span>}
              </button>)}
            </div>}
        </section>
      </>}
  </div>;
}

/** The people one walk stored, and the one thing to do with them. */
function LeadList({ source, leads, loading, picked, allPicked, onBack, onToggle, onToggleAll, onSend }: {
  source: LinkedInLeadSource;
  leads: LinkedInLead[];
  loading: boolean;
  picked: ReadonlySet<string>;
  allPicked: boolean;
  onBack: () => void;
  onToggle: (profileUrl: string) => void;
  onToggleAll: () => void;
  onSend: () => void;
}) {
  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3>{source.resultCount ?? 0} person(s) stored</h3>
        <p>
          <span className="li-chip">{KIND_LABELS[source.kind]}</span>{' '}
          <a className="li-link" href={source.url} target="_blank" rel="noreferrer">{shortUrl(source.url)} <ExternalLink size={11} /></a>
        </p>
      </div>
      <button className="ghost-button" type="button" onClick={onBack}><ArrowLeft size={14} /> All sources</button>
    </div>

    {source.failureReason && <div className="li-degraded">
      <strong>This walk stopped early.</strong>
      <p>{source.failureReason}</p>
    </div>}

    {loading
      ? <p className="empty-copy"><LoaderCircle className="spin" size={14} /> Reading the people this source found…</p>
      : leads.length === 0
        ? <div className="empty-state">
          <Users size={26} />
          <h4>Nobody was stored from this source</h4>
          <p>Either the walk has not run yet, or the page rendered nothing this worker could read. Nothing is invented
            to fill the gap.</p>
        </div>
        : <>
          <div className="li-filter-row">
            <label className="li-inline-check">
              <input type="checkbox" checked={allPicked} onChange={onToggleAll} aria-label="Select every person this source found" />
              <span>{picked.size} of {leads.length} selected</span>
            </label>
            <button className="secondary-button" type="button" disabled={picked.size === 0} onClick={onSend}>
              <Users size={14} /> Send {picked.size} to the campaign builder
            </button>
          </div>

          <div className="li-table-scroll">
            <table className="li-table">
              <thead><tr><th /><th>Name</th><th>Headline</th><th>Company</th><th>Profile</th></tr></thead>
              <tbody>{leads.map((lead) => <tr key={lead.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.has(lead.profileUrl)}
                    onChange={() => onToggle(lead.profileUrl)}
                    aria-label={`Select ${lead.name ?? lead.profileUrl}`}
                  />
                </td>
                <td>{lead.name ?? <span className="li-unknown">Unknown</span>}</td>
                <td>{lead.headline ?? <span className="li-unknown">Unknown</span>}</td>
                <td>{lead.company ?? <span className="li-unknown">Unknown</span>}</td>
                <td className="li-target">
                  <a className="li-link" href={lead.profileUrl} target="_blank" rel="noreferrer">{lead.profileUrl}</a>
                </td>
              </tr>)}</tbody>
            </table>
          </div>

          <div className="panel-footer">
            <span>
              Sending stages the selected profile URLs in the campaign builder’s targets field. It creates no campaign
              and schedules nothing; the exclusion list is applied where the plan is produced, so anyone who asked to be
              left alone is dropped before a payload exists.
            </span>
          </div>
        </>}
  </section>;
}
