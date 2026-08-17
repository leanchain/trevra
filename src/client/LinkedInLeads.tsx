import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  Gauge,
  ListPlus,
  ScanSearch,
  ShieldCheck,
  Users
} from 'lucide-react';
import {
  ApiError,
  createLinkedInLeadSource,
  getLinkedInLeadAllowance,
  getLinkedInLeadSources,
  getLinkedInLeads,
  getLinkedInManagerLeadLists,
  importLinkedInLeadSource,
  setLinkedInLeadAllowance,
  type DailyLeadAllowance,
  type LeadSourceKind,
  type LeadSourceStatus,
  type LinkedInLead,
  type LinkedInLeadSource
} from './api';
// The account switcher, rendered here to SAY WHAT IT DOES NOT REACH. See the
// scope sentence below: lead sources are workspace-wide, and a screen that
// silently ignored the switch would look exactly like one that honoured it.
import { ActiveAccountBar } from './LinkedInAccounts';
import { errorMessage, stageTargets, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { formatVisitWindow, queueWaitCopy } from './LinkedInTiming';
import { navigate } from './ui/route';

/**
 * `/outreach/leads` -- a search page or a post, walked into a list of people.
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
  sales_navigator: 'Sales Navigator search',
  content: 'Post & comment keywords',
  post: 'One post’s engagement'
};

const KIND_HINTS: Record<LeadSourceKind, string> = {
  search: 'Find people from LinkedIn people search.',
  sales_navigator: 'Use a Sales Navigator people search you already ran.',
  content: 'Find people writing or commenting about these terms.',
  post: 'Find people who reacted to or commented on one post.'
};

const KIND_PLACEHOLDERS: Record<LeadSourceKind, string> = {
  search: 'https://www.linkedin.com/search/results/people/?keywords=…',
  sales_navigator: 'https://www.linkedin.com/sales/search/people?query=…',
  content: 'https://www.linkedin.com/search/results/content/?keywords=…',
  post: 'https://www.linkedin.com/posts/…'
};

/** Which kinds the keyword box can write a URL for. Sales Navigator cannot be composed. */
const KEYWORD_KINDS: readonly LeadSourceKind[] = ['search', 'content'];

const INTERACTION_LABELS: Record<'post' | 'comment', string> = {
  post: 'Wrote the post',
  comment: 'Commented'
};

/**
 * Keywords -> the search URL LinkedIn itself would produce.
 *
 * TYPING KEYWORDS IS THE WHOLE INTERACTION. The URL field fills itself as the
 * operator types, and the walk queues straight from that -- a step that only
 * ever produces one predictable string is a step the screen can take itself.
 *
 * TWO SURFACES, ONE BOX. `people` answers "who matches these words" from
 * profile text; `content` answers "who is TALKING about these words" and is
 * the one the brief asks for -- posts and comments, with the post kept. The
 * kind selector picks which question is being asked; the box is the same.
 *
 * It stays a convenience OVER the URL field, not a replacement for it.
 * Everything past a keyword string -- industry, seniority, company headcount,
 * connection degree -- lives in facet parameters whose values are LinkedIn's
 * own internal ids, and no honest version of this box can invent them. So the
 * operator who wants filters runs the search on LinkedIn and pastes it, and
 * hand-editing the URL stops the keywords overwriting it. The field is the
 * source of truth either way. Sales Navigator is not offered here at all: its
 * `query=(...)` grammar is entirely facet ids, so a keyword-only Sales
 * Navigator URL would be a worse search wearing a better name.
 */
function searchUrlForKeywords(kind: LeadSourceKind, keywords: string): string | null {
  const query = keywords.trim().replace(/\s+/g, ' ');
  if (!query) return null;
  if (!KEYWORD_KINDS.includes(kind)) return null;
  const url = new URL(kind === 'content'
    ? 'https://www.linkedin.com/search/results/content/'
    : 'https://www.linkedin.com/search/results/people/');
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

/**
 * HOW MANY OF A WALK'S PEOPLE ONE READ CAN SHOW, and it is not how many it
 * stored.
 *
 * `/lead-sources/:id/leads` clamps `limit` to 500 and takes no offset, so 500
 * rows is the whole of what this screen can put on a page. The number beside a
 * source is `result_count`, which the walk itself wrote -- a different fact,
 * and the true one. They were printed as though they were the same fact, so an
 * 800-person walk read "800 stored" over 500 rows, "select all" quietly meant
 * 500, and Save wrote all 800. Each of those three is now said in its own
 * words rather than left to be discovered.
 */
const LEAD_PAGE = 500;

/**
 * Is this lead list the one a previous save of this source created?
 *
 * The import stores the source's URL on the list as `source_ref`, so that is
 * what identifies it -- but the two strings travel through different
 * validators (`assertLeadSourceUrl` normalises through `URL`), and a trailing
 * slash is not a different search. Compared on the part that identifies the
 * page rather than byte for byte.
 */
const sameSourceUrl = (sourceRef: string | null, sourceUrl: string): boolean => {
  if (!sourceRef) return false;
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value);
      return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch { return value.trim(); }
  };
  return normalize(sourceRef) === normalize(sourceUrl);
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
  const [urlEditing, setUrlEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  /** The source being drilled into. Null on the list. */
  const [openSource, setOpenSource] = useState<LinkedInLeadSource | null>(null);
  const [leads, setLeads] = useState<LinkedInLead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /**
   * The lead list a previous save of THIS source went into, if there is one.
   *
   * The import route creates a list whenever it is handed no `listId`, so a
   * second press of Save built a SECOND list with the same auto-generated name
   * and nothing in it -- every person was already a contact, so every row
   * deduped away and the operator was left with two lists, one of them empty.
   * Matched on the URL the import stored as the list's `source_ref`, so a save
   * made last week is found as surely as one made a minute ago.
   */
  const [savedList, setSavedList] = useState<{ id: string; name: string } | null>(null);

  /** The daily ceiling on how many people this workspace will collect at all. */
  const [allowance, setAllowance] = useState<DailyLeadAllowance | null>(null);
  const [capDraft, setCapDraft] = useState('');
  const [savingCap, setSavingCap] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [result, nextAllowance] = await Promise.all([getLinkedInLeadSources(200), getLinkedInLeadAllowance()]);
      setSources(result.sources);
      setEnabled(result.enabled);
      setOffReason(result.offReason);
      setAllowance(nextAllowance);
      setCapDraft(String(nextAllowance.limit));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the lead sources. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  // Pending/running sources are live queue rows. Refresh them quietly so an
  // ETA that was missed while the laptop slept advances on its own after wake,
  // and a completed walk appears without making the operator press Refresh.
  const hasLiveSources = sources.some((source) => source.status === 'pending' || source.status === 'running');
  useEffect(() => {
    if (!hasLiveSources) return;
    const timer = window.setInterval(() => {
      void getLinkedInLeadSources(200).then((result) => {
        setSources(result.sources);
        setEnabled(result.enabled);
        setOffReason(result.offReason);
      }).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [hasLiveSources]);
  useOutreachRefresh(load);

  const queue = async () => {
    if (!url.trim()) { setError('Type a search above or paste a LinkedIn URL first.'); return; }
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
      // of off it is. It reads verbatim, in the calm block, not as a fault --
      // which is what the comment always said and what the red banner was doing
      // the opposite of. A 409 on this route can only be `assertLeadSourcingOn`
      // refusing, so it is also news: the switch is off, and this screen now
      // knows it and stops offering a walk it cannot queue.
      if (err instanceof ApiError && err.status === 409) {
        setEnabled(false);
        setOffReason(errorMessage(err, 'Lead sourcing is switched off for this deployment.'));
        setError('');
      } else {
        setError(errorMessage(err, 'Unable to queue that source'));
      }
    } finally { setBusy(false); }
  };

  const openLeads = async (source: LinkedInLeadSource) => {
    setOpenSource(source);
    setLeads([]);
    setPicked(new Set());
    setSavedList(null);
    setLeadsLoading(true);
    try {
      const result = await getLinkedInLeads(source.id, LEAD_PAGE);
      setLeads(result.leads);
      if (result.source) setOpenSource(result.source);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the people this source found'));
    } finally { setLeadsLoading(false); }
    // Afterwards and on its own: which list a previous save went into is worth
    // knowing and is never worth failing the read of the people over. Without
    // it the button below says it will create a list -- which is then exactly
    // what it does, so a failure here costs honesty nothing.
    try {
      const existing = await getLinkedInManagerLeadLists();
      const match = existing.find((list) => sameSourceUrl(list.sourceRef, source.url));
      setSavedList(match ? { id: match.id, name: match.name } : null);
    } catch { /* the copy falls back to "a new list", which is what will then happen */ }
  };

  const saveCap = async () => {
    const cap = Number(capDraft);
    if (!Number.isInteger(cap) || cap < 0 || cap > 1000) { setError('The daily lead limit is a whole number between 0 and 1000.'); return; }
    setSavingCap(true);
    try {
      const next = await setLinkedInLeadAllowance(cap);
      setAllowance(next);
      setCapDraft(String(next.limit));
      setToast(cap === 0
        ? 'Daily lead limit set to 0. No walk will store anybody until you raise it.'
        : `Daily lead limit set to ${cap} new leads a day, counted over a rolling 24 hours.`);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to change the daily lead limit.'));
    } finally { setSavingCap(false); }
  };

  /**
   * Harvested rows become leads a campaign can actually enrol.
   *
   * Two different tables with two different jobs: a walk stores what it SAW,
   * and a lead list holds people a workflow may act on. This is the one step
   * between them, and it is explicit rather than automatic -- collecting is not
   * the same decision as contacting.
   */
  const importToList = async (source: LinkedInLeadSource) => {
    setImporting(true);
    try {
      // THE TICKED ROWS TRAVEL. A screen that offers checkboxes, counts them
      // beside the button and then imports the whole walk is worse than one
      // that offers no checkboxes at all -- five of five hundred meant five
      // hundred. Absent `leadIds` still means everybody, which is what the
      // button says when nothing is ticked.
      const chosen = leads.filter((lead) => picked.has(lead.profileUrl)).map((lead) => lead.id);
      const result = await importLinkedInLeadSource(source.id, {
        // Naming the list a previous save created is what stops a second press
        // building a second one; without it the route creates.
        ...(savedList ? { listId: savedList.id } : {}),
        ...(chosen.length > 0 ? { leadIds: chosen } : {})
      });
      setSavedList({ id: result.list.id, name: result.list.name });
      // `skipped` is the importer's own count, and it skips on exactly two
      // things: a profile URL it cannot address, or no first name to open a
      // message with. It has never skipped anybody for a missing company --
      // post engagers rarely have one, and rejecting those would leave keyword
      // discovery unable to feed a campaign at all.
      setToast(`${result.inserted} lead(s) added to “${result.list.name}”${result.reused ? `, ${result.reused} already known` : ''}${result.skipped ? `, ${result.skipped} skipped for an unusable profile URL or no first name` : ''}. They can be enrolled in a campaign now.`);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to turn this source into a lead list.'));
    } finally { setImporting(false); }
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
    navigate('/outreach/campaigns');
  };

  return <div className="page-stack">
    <ActiveAccountBar scope={<>
      <b>This screen is not per-account.</b> Lead sources, the people they find and the lists you save them into are
      shared by every LinkedIn account in this workspace — switching above changes nothing here. The account is chosen
      later, on the campaign that reaches out to them.
    </>} />
    {error && <div className="error-banner">{error}</div>}

    {/* Not an error, and it must not be styled as one: this is a deliberate
        posture, so it reads as an explanation with the server's own sentence
        in it and no control to overturn it. */}
    {!enabled && <section className="li-leads-off">
      <ShieldCheck size={20} />
      <div>
        <strong>Lead sourcing is unavailable right now.</strong>
        <p className="li-blocked-message">{offReason ?? 'Connect the local LinkedIn companion to enable this feature.'}</p>
      </div>
    </section>}

    {openSource
      ? <LeadList
        source={openSource}
        leads={leads}
        loading={leadsLoading}
        picked={picked}
        allPicked={allPicked}
        savedList={savedList}
        onBack={() => { setOpenSource(null); setLeads([]); setPicked(new Set()); setSavedList(null); }}
        onToggle={toggle}
        onToggleAll={() => setPicked(allPicked ? new Set() : new Set(leads.map((lead) => lead.profileUrl)))}
        onSend={sendToBuilder}
        importing={importing}
        onImport={() => void importToList(openSource)}
      />
      : <>
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Find people on LinkedIn</h3>
              <p>Choose the search type, type what you are looking for, and Trevra builds the LinkedIn URL for you. Queueing it only schedules a local browser walk — it contacts nobody.</p>
            </div>
            <ScanSearch size={20} className="li-heading-icon" />
          </div>

          <div className="li-form-grid">
            <label>Search type
              <select
                value={kind}
                disabled={!enabled}
                onChange={(event) => {
                  const next = event.target.value as LeadSourceKind;
                  setKind(next);
                  setUrlDirty(false);
                  setUrl(searchUrlForKeywords(next, keywords) ?? '');
                }}
              >
                <option value="search">{KIND_LABELS.search}</option>
                <option value="content">{KIND_LABELS.content}</option>
                <option value="sales_navigator">{KIND_LABELS.sales_navigator}</option>
                <option value="post">{KIND_LABELS.post}</option>
              </select>
              <small className="li-hint">{KIND_HINTS[kind]}</small>
            </label>

            {KEYWORD_KINDS.includes(kind) && <label>Search
              <input
                value={keywords}
                disabled={!enabled}
                placeholder={kind === 'content' ? 'cold outreach, sales automation' : 'revops founder seed stage'}
                onChange={(event) => {
                  const next = event.target.value;
                  setKeywords(next);
                  if (!urlDirty) setUrl(searchUrlForKeywords(kind, next) ?? '');
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || busy || !enabled || !url.trim()) return;
                  event.preventDefault();
                  void queue();
                }}
              />
              <small className="li-hint">The LinkedIn URL below is built automatically as you type.</small>
            </label>}
          </div>

          <div className="li-search-builder">
            <div className="li-url-field">
              <div className="li-url-label-row">
                <span className="li-url-label">LinkedIn URL</span>
                {!urlEditing && <button
                  className="li-url-edit"
                  type="button"
                  disabled={!enabled}
                  aria-label="Edit LinkedIn URL"
                  title="Edit LinkedIn URL"
                  onClick={() => setUrlEditing(true)}
                ><Pencil size={14} /> Edit</button>}
              </div>
              {urlEditing
                ? <div className="li-url-editor-row">
                  <textarea
                    rows={2}
                    autoFocus
                    value={url}
                    disabled={!enabled}
                    onChange={(event) => { setUrl(event.target.value); setUrlDirty(true); }}
                    placeholder={KIND_PLACEHOLDERS[kind]}
                  />
                  <button className="secondary-button" type="button" onClick={() => setUrlEditing(false)}>Done</button>
                </div>
                : <div className="li-url-display" title={url || KIND_PLACEHOLDERS[kind]}>
                  <code>{url || KIND_PLACEHOLDERS[kind]}</code>
                </div>}
            </div>
            <p className="li-hint">
              {KEYWORD_KINDS.includes(kind)
                ? urlDirty
                  ? 'Using the URL you pasted or edited. Trevra preserves LinkedIn filters in that URL.'
                  : 'Built from your search. If you want LinkedIn filters such as industry, seniority or connection degree, run that filtered search on LinkedIn and paste its URL here.'
                : 'Paste the LinkedIn URL you want Trevra to open.'}
            </p>
            {urlDirty && KEYWORD_KINDS.includes(kind) && keywords.trim() && <button
              className="ghost-button"
              type="button"
              disabled={!enabled}
              onClick={() => {
                setUrlDirty(false);
                setUrl(searchUrlForKeywords(kind, keywords) ?? '');
              }}
            >Use generated URL</button>}
          </div>

          <div className="panel-footer">
            <span>Queueing only schedules this source for the local LinkedIn worker. Exclusions are applied later, before anybody can become an outreach target.</span>
            <button className="primary-button" type="button" disabled={busy || !enabled || !url.trim()} onClick={() => void queue()}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} {kind === 'post' ? 'Queue post' : 'Queue search'}
            </button>
          </div>
        </section>

        {/* The ceiling on collection itself, which is a different question from
            how deep any one walk goes: six walks in a morning each stopping at
            100 is 600 people nobody set out to collect. */}
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>How many new leads a day</h3>
              <p>Counted over a rolling 24 hours across every source. A walk that would pass this limit stops early and
                says so instead of collecting anyway.</p>
            </div>
            <Gauge size={20} className="li-heading-icon" />
          </div>
          <div className="li-form-grid">
            <label>Daily limit
              <input
                type="number"
                min={0}
                max={1000}
                value={capDraft}
                // Off with everything else on this screen. A ceiling on
                // collection is only a ceiling on something that can run, and
                // an editable one where no walk is permitted implies a walk is.
                disabled={!enabled}
                onChange={(event) => setCapDraft(event.target.value)}
              />
              <small className="li-hint">0–1000. Set 0 to collect nobody at all.</small>
            </label>
            {/* NOT ZERO WHEN IT IS UNKNOWN. A failed read of the allowance used
                to print "Still allowed 0", which reads as a hard block that
                does not exist and sends an operator looking for a limit to
                raise. A number nobody read is not a number this screen has. */}
            <div className="li-lead-cap-stats">
              <div className="li-stat">
                <p>Collected today</p>
                <strong>{allowance ? allowance.used : <span className="li-unknown">—</span>}</strong>
                <span>Rolling 24 hours</span>
              </div>
              <div className="li-stat li-stat-ok">
                <p>Still allowed</p>
                <strong>{allowance ? allowance.remaining : <span className="li-unknown">—</span>}</strong>
                <span>Before this daily cap</span>
              </div>
            </div>
          </div>
          {!allowance && !loading && <p className="li-hint">
            Today’s count could not be read, so neither number is shown. The limit itself is unchanged and is still
            applied by the walk — Refresh below reads it again.
          </p>}
          <div className="panel-footer">
            <span>Changing this affects the next walk. It never deletes anybody already collected.</span>
            {/* The old test compared the draft against `allowance?.limit ?? ''`,
                so a failed read made it `'' === ''` and the button could never
                be pressed again without a reload -- the one state in which the
                operator most wants to set a number. Empty is the only draft
                there is nothing to save from; a known limit still guards
                against saving what is already stored. */}
            <button
              className="secondary-button"
              type="button"
              disabled={!enabled || savingCap || capDraft.trim() === '' || (allowance !== null && capDraft === String(allowance.limit))}
              onClick={() => void saveCap()}
            >
              {savingCap ? <LoaderCircle className="spin" size={14} /> : <Gauge size={14} />} Save limit
            </button>
          </div>
        </section>

        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Sources</h3>
              <p>Result counts are people <em>stored</em>, not people seen. Queued rows show the next expected LinkedIn visit. If your computer or Trevra tab misses that window, Trevra moves the work to the next normal visit — missed visits are never replayed as a catch-up burst.</p>
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
                {source.status === 'pending' && <span className="li-source-next-run">
                  {queueWaitCopy(source.waitingFor)
                    ? <><strong>{queueWaitCopy(source.waitingFor)}</strong>{formatVisitWindow(source.nextRunAt, source.nextRunWindowEndAt, source.nextRunTimezone) ? ` · next normal visit ${formatVisitWindow(source.nextRunAt, source.nextRunWindowEndAt, source.nextRunTimezone)}` : ''}</>
                    : formatVisitWindow(source.nextRunAt, source.nextRunWindowEndAt, source.nextRunTimezone)
                      ? <>Expected in LinkedIn visit · {formatVisitWindow(source.nextRunAt, source.nextRunWindowEndAt, source.nextRunTimezone)}</>
                      : <>Waiting for the next eligible LinkedIn visit</>}
                </span>}
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
function LeadList({ source, leads, loading, picked, allPicked, importing, savedList, onBack, onToggle, onToggleAll, onSend, onImport }: {
  source: LinkedInLeadSource;
  leads: LinkedInLead[];
  loading: boolean;
  picked: ReadonlySet<string>;
  allPicked: boolean;
  importing: boolean;
  /** The list a previous save of this source went into, so a repeat can name it. */
  savedList: { id: string; name: string } | null;
  onBack: () => void;
  onToggle: (profileUrl: string) => void;
  onToggleAll: () => void;
  onSend: () => void;
  onImport: () => void;
}) {
  const showsPosts = leads.some((lead) => lead.postUrl !== null || lead.interactionKind !== null);
  /**
   * TWO NUMBERS, AND THEY ARE NOT THE SAME NUMBER. `stored` is what the walk
   * wrote against the source; `leads.length` is what one read of it can put on
   * a page. Printing the first over rows that are the second is how "800
   * stored" came to sit above 500 rows, and every control below now names
   * whichever of the two it actually operates on.
   */
  const stored = source.resultCount ?? 0;
  const capped = leads.length >= LEAD_PAGE;
  const beyondPage = capped && stored > leads.length;
  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3 aria-level={2}>{source.resultCount ?? 0} person(s) stored</h3>
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
          <h4 aria-level={3}>Nobody was stored from this source</h4>
          <p>Either the walk has not run yet, or the page rendered nothing this worker could read. Nothing is invented
            to fill the gap.</p>
        </div>
        : <>
          <div className="li-filter-row">
            <label className="li-inline-check">
              <input type="checkbox" checked={allPicked} onChange={onToggleAll} aria-label="Select every person listed here" />
              <span>
                {picked.size} of {leads.length} listed selected
                {beyondPage && ` · ${stored} stored in all`}
              </span>
            </label>
            <button className="secondary-button" type="button" disabled={picked.size === 0} onClick={onSend}>
              <Users size={14} /> Add {picked.size} to the campaign builder
            </button>
            {/* The button says what it will write, because it can now write two
                different things: the ticked rows, or the whole walk. */}
            <button className="primary-button" type="button" disabled={importing || leads.length === 0} onClick={onImport}>
              {importing ? <LoaderCircle className="spin" size={14} /> : <ListPlus size={14} />}
              {picked.size > 0
                ? ` Save the ${picked.size} selected as leads`
                : savedList
                  ? ` Add all ${stored || leads.length} to “${savedList.name}”`
                  : ` Save all ${stored || leads.length} as a lead list`}
            </button>
          </div>

          {beyondPage && <p className="li-hint">
            This walk stored {stored} people and one read of the list returns at most {LEAD_PAGE}, so {leads.length} are
            listed below. Ticking rows reaches those {leads.length}; saving with nothing ticked writes all {stored}.
          </p>}

          <div className="li-table-scroll">
            <table className="li-table">
              <thead><tr><th /><th>Name</th><th>Headline</th><th>Company</th>{showsPosts && <><th>Found on</th><th>How</th></>}<th>Profile</th></tr></thead>
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
                {/* NOT "Unknown", WHICH READS AS "WE LOOKED AND COULD NOT TELL".
                    A post or comment card carries no company field at all, so
                    for everybody found that way this was never read rather than
                    read and missing. An empty cell says the true thing; the
                    note under the table says which. */}
                <td>{lead.company ?? <span className="li-unknown">—</span>}</td>
                {showsPosts && <>
                  <td>{lead.postUrl
                    ? <a className="li-link" href={lead.postUrl} target="_blank" rel="noreferrer">the post <ExternalLink size={11} /></a>
                    : <span className="li-unknown">—</span>}</td>
                  <td>{lead.interactionKind
                    ? <span className="li-chip">{INTERACTION_LABELS[lead.interactionKind]}</span>
                    : <span className="li-unknown">—</span>}</td>
                </>}
                <td className="li-target">
                  <a className="li-link" href={lead.profileUrl} target="_blank" rel="noreferrer">{lead.profileUrl}</a>
                </td>
              </tr>)}</tbody>
            </table>
          </div>

          <p className="li-hint">
            A dash is a field the page did not render for that person — left empty rather than filled in. A company is
            the usual one: a post or a comment card does not carry one, so people found that way have none to read.
          </p>

          <div className="panel-footer">
            <span>
              Adding stages the selected profile URLs in the campaign builder’s targets field. It creates no campaign
              and schedules nothing; the exclusion list is applied where the plan is produced, so anyone who asked to be
              left alone is dropped before a payload exists.
              {' '}{picked.size > 0
                ? <>Saving writes <b>the {picked.size} you ticked</b> and nobody else.</>
                : <>With nothing ticked, saving writes <b>everybody this walk stored</b>.</>}
              {' '}{savedList
                ? <>They go into <b>“{savedList.name}”</b>, the list this source was saved to before — somebody already
                  in it is not added a second time.</>
                : <>They go into a new list for this source. Saving again afterwards adds to that same list rather than
                  building another.</>}
            </span>
          </div>
        </>}
  </section>;
}
