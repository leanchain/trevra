import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CircleAlert,
  ExternalLink,
  Inbox,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck
} from 'lucide-react';
import {
  ApiError,
  getLinkedInCampaigns,
  getLinkedInThread,
  getLinkedInThreads,
  replyToLinkedInThread,
  syncLinkedInInbox,
  syncLinkedInThread,
  type LinkedInCampaign,
  type LinkedInConversation,
  type LinkedInSafetyVerdict,
  type LinkedInThreadRecord
} from './api';
import { errorMessage, reloadOutreach, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { ConfidenceTag } from './LinkedInViz';

/**
 * `#/outreach/inbox` -- the conversations, and the one place a reply is written.
 *
 * THREE THINGS THIS SCREEN MUST NOT SOFTEN.
 *
 * 1. A REPLY IS QUEUED, NEVER SENT. `POST .../reply` files a gated
 *    `linkedin_actions` row of kind `reply`; the local worker claims it,
 *    re-runs the whole safety gate against it, and types it into a real
 *    browser at paced gaps. The composer says so beside the button, because a
 *    "Send" that does not send is the one lie this product cannot afford.
 * 2. A 409 IS THE PRODUCT WORKING. The gate refuses in its own words and names
 *    what to do -- over the day's ceiling, outside business hours, a seat
 *    that is paused. That sentence is rendered verbatim and is not styled as a
 *    fault, because it is a decision, not a crash.
 * 3. WHAT IS ON SCREEN IS WHAT THE LAST SYNC STORED. Listing and reading are
 *    plain database reads and answer instantly anywhere; only Sync walks
 *    LinkedIn, which needs a browser this process can open. Where it cannot,
 *    the 409 names the one thing to go and do -- the same contract the seat's
 *    detect has, surfaced the same way.
 */

/** Neither filter is on by default: an inbox that opens filtered is an inbox that looks empty. */
interface InboxFilters {
  unread: boolean;
  hasReply: boolean;
  campaignId: string;
}

const EMPTY_FILTERS: InboxFilters = { unread: false, hasReply: false, campaignId: '' };

/** `sentAt` is parsed from display text and is frequently null. Never invented. */
const messageTime = (sentAt: string | null) => {
  if (!sentAt) return null;
  const parsed = Date.parse(sentAt);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null;
};

export function OutreachInbox({ setToast }: { setToast: (message: string) => void }) {
  const [threads, setThreads] = useState<LinkedInThreadRecord[]>([]);
  const [campaigns, setCampaigns] = useState<LinkedInCampaign[]>([]);
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_FILTERS);
  const [openUrn, setOpenUrn] = useState<string | null>(null);
  const [conversation, setConversation] = useState<LinkedInConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [syncing, setSyncing] = useState<'rail' | 'thread' | null>(null);
  const [error, setError] = useState('');
  /** A 409 from a sync route: something to go and do on this machine, shown verbatim. */
  const [blocked, setBlocked] = useState('');
  const [degraded, setDegraded] = useState<string[]>([]);

  // The composer.
  const [body, setBody] = useState('');
  const [queueing, setQueueing] = useState(false);
  /** The gate's own sentence, verbatim. Not an error: a decision with a reason. */
  const [refusal, setRefusal] = useState('');
  const [queued, setQueued] = useState<{ plannedFor: string; verdict: LinkedInSafetyVerdict } | null>(null);

  /** Last request wins, so a fast unfiltered read cannot overwrite a slow filtered one. */
  const listToken = useRef(0);

  const loadThreads = useCallback(async () => {
    const token = listToken.current + 1;
    listToken.current = token;
    setLoading(true);
    try {
      const next = await getLinkedInThreads({
        ...(filters.unread ? { unread: true } : {}),
        ...(filters.hasReply ? { hasReply: true } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        limit: 200
      });
      if (listToken.current !== token) return;
      setThreads(next);
      setError('');
    } catch (err) {
      if (listToken.current === token) {
        setError(errorMessage(err, 'Unable to read the inbox. Nothing was changed — try the filters again.'));
      }
    } finally {
      if (listToken.current === token) setLoading(false);
    }
  }, [filters.unread, filters.hasReply, filters.campaignId]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);
  useOutreachRefresh(loadThreads);

  useEffect(() => {
    // A picker that cannot be populated simply is not offered; it never blocks
    // the conversations, which is what this screen is for.
    void (async () => {
      try { setCampaigns(await getLinkedInCampaigns()); }
      catch { /* the campaign filter is not worth an error banner over the inbox */ }
    })();
  }, []);

  const openThread = async (threadUrn: string) => {
    setOpenUrn(threadUrn);
    setReading(true);
    setBody('');
    setRefusal('');
    setQueued(null);
    try {
      setConversation(await getLinkedInThread(threadUrn));
      setError('');
    } catch (err) {
      setConversation(null);
      setError(errorMessage(err, 'Unable to read that conversation. Nothing was changed.'));
    } finally { setReading(false); }
  };

  /**
   * Walk the rail in a real browser.
   *
   * A 409 is not a fault: this process cannot open a browser for this seat, and
   * the server's sentence names what to run and where. It goes in the calm
   * block, not the error banner.
   */
  const syncRail = async () => {
    setSyncing('rail');
    setBlocked('');
    setError('');
    setDegraded([]);
    try {
      const result = await syncLinkedInInbox();
      setDegraded(result.degraded);
      setToast(`${result.threads} conversation(s) walked · ${result.created} new, ${result.updated} updated, `
        + `${result.inbound} inbound message(s) stored, ${result.linked} matched to a campaign.`);
      await reloadOutreach();
      if (openUrn) await openThread(openUrn);
    } catch (err) {
      const message = errorMessage(err, 'Unable to walk the inbox');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally { setSyncing(null); }
  };

  const syncOne = async (threadUrn: string) => {
    setSyncing('thread');
    setBlocked('');
    setError('');
    setDegraded([]);
    try {
      const result = await syncLinkedInThread(threadUrn);
      setDegraded(result.degraded);
      setToast(`${result.inserted} message(s) stored, ${result.inbound} of them inbound.`);
      await openThread(threadUrn);
      await loadThreads();
    } catch (err) {
      const message = errorMessage(err, 'Unable to re-read that conversation');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally { setSyncing(null); }
  };

  /**
   * Queue the reply. NOTHING IS SENT HERE, and the copy under the button says so.
   *
   * A 409 is the safety gate refusing in its own words. It is kept apart from
   * `error` on purpose: an error is something that went wrong, and this is the
   * gate doing exactly its job.
   */
  const queueReply = async () => {
    if (!openUrn || !body.trim()) return;
    setQueueing(true);
    setRefusal('');
    setError('');
    setQueued(null);
    try {
      const result = await replyToLinkedInThread(openUrn, body);
      setQueued({ plannedFor: result.plannedFor, verdict: result.verdict });
      setBody('');
      setToast('Reply queued as a gated action. Nothing has been sent — the worker claims it, gates it again, and types it.');
      await reloadOutreach();
    } catch (err) {
      const message = errorMessage(err, 'Unable to queue that reply');
      if (err instanceof ApiError && err.status === 409) setRefusal(message);
      else setError(message);
    } finally { setQueueing(false); }
  };

  const filtered = filters.unread || filters.hasReply || Boolean(filters.campaignId);
  const messages = conversation?.messages ?? [];

  return <div className="page-stack">
    {error && <div className="error-banner">
      <strong>{error}</strong> Whatever is below is the last good read.{' '}
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void loadThreads()}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read the inbox again
      </button>
    </div>}

    {blocked && <div className="li-connect-blocked">
      <strong><CircleAlert size={14} /> One thing has to happen on your machine first.</strong>
      <p className="li-blocked-message">{blocked}</p>
      <p>Nothing was read and nothing was changed. What is below is still the last sync.</p>
    </div>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Inbox</h3>
          <p>
            What the last sync stored. Reading is a database read; syncing walks LinkedIn in a real browser on this
            machine, at paced gaps, and the worker does the same walk on its own tick.
          </p>
        </div>
        <button className="secondary-button" type="button" disabled={syncing !== null} onClick={() => void syncRail()}>
          {syncing === 'rail' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Sync the inbox
        </button>
      </div>

      <div className="li-filter-row">
        <span className="li-filter-label">Show</span>
        <button
          type="button"
          className={`li-range ${filters.unread ? 'is-active' : ''}`}
          aria-pressed={filters.unread}
          onClick={() => setFilters((current) => ({ ...current, unread: !current.unread }))}
        >Unread</button>
        <button
          type="button"
          className={`li-range ${filters.hasReply ? 'is-active' : ''}`}
          aria-pressed={filters.hasReply}
          onClick={() => setFilters((current) => ({ ...current, hasReply: !current.hasReply }))}
        >Has a reply</button>
        <label>Campaign
          <select
            value={filters.campaignId}
            onChange={(event) => setFilters((current) => ({ ...current, campaignId: event.target.value }))}
          >
            <option value="">Any campaign</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        {loading && <LoaderCircle className="spin" size={14} aria-label="Reading the inbox" />}
      </div>

      {degraded.length > 0 && <div className="li-degraded">
        <strong>Walked, but not all of it came back:</strong>
        <ul>{degraded.slice(0, 8).map((entry) => <li key={entry}>{entry}</li>)}</ul>
        <p>Anything missing is simply not stored. Nothing here is guessed at.</p>
      </div>}
    </section>

    <div className="li-inbox">
      <section className="page-panel li-thread-pane">
        {threads.length === 0
          ? <div className="empty-state">
            <Inbox size={26} />
            <h4>{filtered ? 'No conversation matches this filter' : 'Nothing has been synced yet'}</h4>
            <p>{filtered
              ? 'The filters above narrow what the last sync stored; they never fetch anything new.'
              : 'Sync the inbox to walk the conversation rail. Trevra stores what LinkedIn rendered — it invents no message and no timestamp.'}</p>
            {filtered && <button className="secondary-button" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear the filters
            </button>}
          </div>
          : <ul className="li-thread-list">
            {threads.map((thread) => <li key={thread.threadUrn}>
              <button
                type="button"
                className={`li-thread ${openUrn === thread.threadUrn ? 'is-open' : ''}`}
                onClick={() => void openThread(thread.threadUrn)}
              >
                <span className="li-thread-top">
                  {thread.unread && <i className="li-unread-dot" aria-label="Unread at the last sync" />}
                  <strong className="li-thread-name">{thread.name ?? <em className="li-unknown">Name unknown</em>}</strong>
                  <span className="li-thread-time">
                    {thread.lastMessageAt ? relativeTime(thread.lastMessageAt) : '—'}
                  </span>
                </span>
                <span className="li-thread-snippet">{thread.snippet || 'No snippet was rendered for this conversation.'}</span>
                <span className="li-thread-meta">
                  {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
                  {thread.hasReply && <span className="li-chip li-status-replied">replied</span>}
                  {thread.campaignId && <span className="li-chip">campaign</span>}
                </span>
              </button>
            </li>)}
          </ul>}
      </section>

      <section className="page-panel li-convo">
        {!conversation
          ? <p className="empty-copy">{reading
            ? 'Reading that conversation…'
            : 'Pick a conversation on the left. Its messages are what the last sync stored, oldest first.'}</p>
          : <>
            <div className="section-heading li-convo-head">
              <div>
                <h3>{conversation.thread.name ?? 'Conversation'}</h3>
                <p>
                  {conversation.thread.profileUrl
                    ? <a className="li-seat-vanity" href={conversation.thread.profileUrl} target="_blank" rel="noreferrer">
                      {conversation.thread.profileUrl}<ExternalLink size={11} />
                    </a>
                    : <span className="li-unknown">No profile URL was resolved, so this conversation cannot be replied to yet.</span>}
                </p>
                <p>Last synced {relativeTime(conversation.thread.syncedAt)}.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={syncing !== null}
                onClick={() => void syncOne(conversation.thread.threadUrn)}
              >
                {syncing === 'thread' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Sync this thread
              </button>
            </div>

            {messages.length === 0
              ? <p className="empty-copy">No message has been stored for this conversation. Sync it to read what LinkedIn shows.</p>
              : <ol className="li-msgs">
                {messages.map((message) => <li key={message.id} className={`li-msg li-msg-${message.direction}`}>
                  <span className="li-msg-who">{message.direction === 'in' ? 'Them' : 'You'}</span>
                  <p>{message.body}</p>
                  <span className="li-msg-time">
                    {messageTime(message.sentAt) ?? 'No timestamp was rendered'}
                    {message.actionId && ' · sent through Trevra'}
                  </span>
                </li>)}
              </ol>}

            <div className="li-composer">
              <label className="li-block-label">Your reply
                <textarea
                  rows={4}
                  value={body}
                  disabled={!conversation.thread.profileUrl}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Write the reply. Trevra sends approved bytes and does not compose them."
                />
              </label>

              {refusal && <div className="li-gate-refusal">
                <strong><ShieldCheck size={14} /> The safety gate refused this reply.</strong>
                <p className="li-blocked-message">{refusal}</p>
                <p>Nothing was queued and nobody was contacted. This is the gate working, not a failure.</p>
              </div>}

              {queued && <div className="li-queued">
                <strong><ShieldCheck size={14} /> Queued for {new Date(queued.plannedFor).toLocaleString()}.</strong>
                <p>
                  It is a `reply` row in the ledger, not a sent message. The local worker claims it, runs every check
                  below again, and types it into a real browser at a randomised gap.
                </p>
                <details className="li-gate-checks">
                  <summary>What the gate checked ({(queued.verdict.checks ?? []).length})</summary>
                  <ul>{(queued.verdict.checks ?? []).map((check) => <li key={check.check}>
                    <b>{check.check.replaceAll('-', ' ')}</b> — {check.detail}
                  </li>)}</ul>
                  <p>{queued.verdict.automationReason}</p>
                </details>
              </div>}

              <div className="panel-footer li-composer-foot">
                <span>
                  <b>This queues a reply; it does not send one.</b> It is filed as a gated action for the local worker,
                  which re-runs the whole safety gate against it and types it at paced gaps inside the seat’s business
                  hours. If the gate refuses, you get its reason here rather than a row that never drains.
                  {' '}<ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.3" compact />
                </span>
                <button
                  className="primary-button"
                  type="button"
                  disabled={queueing || !body.trim() || !conversation.thread.profileUrl}
                  onClick={() => void queueReply()}
                >
                  {queueing ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />} Queue this reply
                </button>
              </div>
            </div>
          </>}
      </section>
    </div>

    <p className="panel-note">
      <MessageSquare size={13} /> A queued reply appears on the{' '}
      <a className="li-link" href="#/outreach/queue">queue</a> as a <code>reply</code> slot, and it is charged against
      this seat’s ceilings like every other action.
    </p>
  </div>;
}
