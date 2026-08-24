import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Clock,
  ExternalLink,
  Inbox,
  ListPlus,
  LoaderCircle,
  MessageSquare,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  X
} from 'lucide-react';
import {
  ApiError,
  completeLinkedInManualTask,
  editLinkedInActionBody,
  getLinkedInActions,
  getLinkedInManagedCampaigns,
  getLinkedInManualTasks,
  getLinkedInSeat,
  getLinkedInThread,
  getLinkedInThreads,
  replyToLinkedInThread,
  skipLinkedInAction,
  syncLinkedInInbox,
  syncLinkedInThread,
  type LinkedInActionView,
  type LinkedInConversation,
  type LinkedInMessageRecord,
  type LinkedInSafetyVerdict,
  type LinkedInSeatResponse,
  type LinkedInThreadRecord
} from './api';
import type { ManagedCampaign, ManualTaskView } from '../server/linkedin/managed-campaigns';
import { useActiveSeatKey } from './LinkedInActiveAccount';
import { errorMessage, reloadOutreach, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { DELAY_CHOICES, plannedForFrom, queueWaitCopy, type ScheduleMode } from './LinkedInTiming';
import { useWorkspaceMembers } from './TeamScreen';
import { ConfidenceTag } from './LinkedInViz';
import { Select } from './ui/primitives';
import { plural } from './ui/plural';

/**
 * `/outreach/inbox` -- THE ONE PLACE AN OPERATOR ANSWERS A PERSON.
 *
 * Two kinds of thing land here and they are not the same kind of thing. A
 * CONVERSATION is something a human sent; a MANUAL-MESSAGE TASK is a campaign
 * screen -- but a task is drawn as a to-do, never as a received message,
 * because an inbox that pads its unread count with its own homework is an
 * inbox nobody trusts twice.
 *
 * FOUR THINGS THIS SCREEN MUST NOT SOFTEN.
 *
 * 1. A REPLY IS QUEUED, NEVER SENT. `POST .../reply` files a checked
 *    `linkedin_actions` row of kind `reply`; the local worker claims it,
 *    re-runs the whole safety check against it, and types it into a real
 *    browser at paced gaps. The composer no longer stops at that disclaimer:
 *    it reads those rows back and names WHERE this message got to -- waiting,
 *    being typed, delivered, or held back. A "Send" that does not send is the
 *    one lie this product cannot afford; a warning with no state behind it is
 *    the second.
 * 2. QUEUEING A MESSAGE AND CLOSING A TASK ARE TWO ACTS, and the screen keeps
 *    them two buttons. Queueing hands bytes to the worker. Marking as sent is
 *    the operator's word that the message went out -- however it went out --
 *    and it is the only thing that releases the campaign member to the next
 *    step. Fusing them would let Trevra claim to have sent bytes it did not.
 * 3. A 409 IS THE PRODUCT WORKING. It refuses in its own words and names what
 *    to do -- over the day's ceiling, outside business hours, a paused
 *    account. That sentence is rendered verbatim and is not styled as a
 *    fault, because it is a decision, not a crash.
 * 4. WHAT IS ON SCREEN IS WHAT THE LAST SYNC STORED. Listing and reading are
 *    plain database reads and answer instantly anywhere; only Sync walks
 *    LinkedIn, which needs a browser this process can open. Where it cannot,
 *    the 409 names the one thing to go and do.
 */

/** No message filter is on by default: an inbox that opens filtered is an inbox that looks empty. */
interface InboxFilters {
  unread: boolean;
  hasReply: boolean;
  campaignId: string;
}

const EMPTY_FILTERS: InboxFilters = { unread: false, hasReply: false, campaignId: '' };

/**
 * HOW MUCH OF THE INBOX ONE READ ASKS FOR, and how much it can ever get.
 *
 * `/api/linkedin/inbox/threads` takes a `limit` it clamps to 500 and offers no
 * offset and no total, so this is not paging in the usual sense: each press
 * re-reads the same newest-first slice a page deeper, and the last press is the
 * one the server's own ceiling stops. Two things follow, and both are said on
 * screen rather than hidden. A full page means older conversations exist and
 * were not asked for -- never "200 of N", because the route returns rows and no
 * count, and a total nobody measured is a total this screen will not print. And
 * at 500 the honest sentence is that one read reaches no further, with the
 * filters named as the way to bring older conversations into range.
 */
const THREAD_PAGE = 100;
const THREAD_MAX = 500;

/**
 * The same ceiling on `/api/linkedin/actions`, which the send-state strip reads.
 *
 * It powers two things: where each queued message got to, and whether one to
 * this person is still outstanding. A truncated read can only make the strip
 * miss an older message, never invent one -- but missing one silently would let
 * the composer say "nothing is queued" about a workspace whose newest 500
 * queued messages simply crowded it out, so a truncated read says so.
 */
const REPLY_MAX = 500;

/**
 * A queued reply that has not finished, in the ledger's terms.
 *
 * WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT.
 *
 * The reply guard is no longer "one reply per person, ever" -- migration 047
 * keys it on the conversation PLUS THE MESSAGE BEING ANSWERED, so the refusal
 * that remains is "you already have an unsent answer to that exact message".
 * Two consequences, and the button obeys both. A second reply after they have
 * written again is a different answer to a different message and IS allowed, so
 * disabling on "a live reply exists" would lock an operator out of the ordinary
 * back-and-forth this screen exists for. And the key itself is a server fact --
 * the ledger row carries neither the conversation nor the message it answers
 * out to the client -- so a screen that gated on it would be guessing at a
 * predicate it cannot see.
 *
 * So this is used to SAY where the last message got to and to state the rule
 * in the operator's words, and the refusal, when there is one, arrives from the
 * server in its own sentence. A gate that cannot be computed honestly is not
 * worth computing at all; a gate the operator cannot predict is what the copy
 *
 * 'held' IS LIVE, AND LEAVING IT OUT MADE THIS LIST DISAGREE WITH THE SERVER.
 * The replay index refuses on `status <> 'skipped'` (`hasTarget` in
 * src/server/linkedin/actions.ts), so a held answer -- one whose campaign is
 * paused, migration 051 -- still vetoes a second answer to the same message.
 * Without it here the strip said nothing was in flight, the composer offered
 * the button, and the operator got a 409 enforcing a rule this screen had just
 * told them did not apply. It is also the truthful reading on its own terms: a
 * held reply has not been sent and has not been cancelled, which is the exact
 * definition of in flight.
 */
const LIVE_REPLY_STATUSES: ReadonlySet<string> = new Set(['planned', 'held', 'exported']);

/** `sentAt` is parsed from display text and is frequently null. Never invented. */
const messageTime = (sentAt: string | null) => {
  if (!sentAt) return null;
  const parsed = Date.parse(sentAt);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null;
};

/**
 * Compare a task's person with a synced conversation's.
 *
 * Both URLs came from LinkedIn, but one was typed into a spreadsheet and the
 * other read off a page, so a trailing slash or a tracking query is the normal
 * difference between them rather than a different person.
 */
const profileKey = (url: string | null | undefined) =>
  (url ?? '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

/**
 * WHERE A QUEUED MESSAGE ACTUALLY IS, in the operator's words.
 *
 * This is the whole answer to "did it go?", and it is read off the same row
 * the worker drains, not off a hopeful local flag. Planned with nothing
 * claiming it is waiting; planned and claimed is being typed right now; sent
 * is delivered; skipped or withdrawn means it never left -- which the operator
 * has to be able to see here rather than be sent to another screen to find.
 * Held is a pause parking it, and it is the one state where "waiting" would be
 * a lie: see its branch below.
 */
const replyStage = (
  action: LinkedInActionView,
  waitingFor?: LinkedInSeatResponse['execution']['waitingFor']
): { label: string; chip: string; detail: string } => {
  if (action.status === 'sent' || action.status === 'accepted' || action.status === 'replied') {
    return {
      label: 'Delivered',
      chip: 'li-status-sent',
      detail: action.recordedAt
        ? `Typed into LinkedIn ${relativeTime(action.recordedAt)}.`
        : 'Typed into LinkedIn.'
    };
  }
  if (
    action.status === 'skipped' ||
    action.status === 'withdrawn' ||
    action.status === 'declined'
  ) {
    return {
      label: 'Never sent',
      chip: 'li-status-skipped',
      detail: action.failureKind
        ? `Held back to keep this account safe (${action.failureKind.replaceAll('_', ' ')}). Nothing reached them.`
        : 'This one was cancelled before it was typed. Nothing reached them.'
    };
  }
  /**
   * PARKED BY A PAUSE, AND THE ONE STATE WHERE "WAITING TO SEND" IS FALSE.
   *
   * `pauseManagedCampaign` moves every unclaimed row of a paused campaign to
   * 'held' (migration 051), and the worker's claim query asks for 'planned'.
   * So nothing will pick this up: not tonight, not at its planned moment, not
   * ever, until a human resumes the campaign. Before this branch existed a
   * held row fell through to the `plannedFor` test below and was labelled
   * "Waiting to send" beside a future time it would sail past untouched --
   * the operator would read that same sentence three days later while nothing
   * moved, on the one screen that exists to answer "did it go?".
   *
   * It must not wear "Never sent" either. Resuming puts the identical row back
   * to 'planned' with its wording, its person and its slot unchanged
   * (`startManagedCampaign`), so the detail names both exits an operator
   * actually has: resume and it goes, stop the campaign and it never does
   * (`stopCampaign` skips held rows along with planned ones).
   */
  if (action.status === 'held') {
    return {
      label: 'Paused',
      chip: 'li-status-held',
      detail:
        'Its campaign is paused, so nothing will pick this up — not at its planned time, not later. ' +
        'Resume the campaign and it goes back in the queue exactly as it is; stop the campaign and it never sends.'
    };
  }
  if (action.claimedAt) {
    return {
      label: 'Sending now',
      chip: 'li-status-planned',
      detail: `Trevra picked it up ${relativeTime(action.claimedAt)} and is typing it into LinkedIn in a real browser.`
    };
  }
  const due = action.plannedFor ? Date.parse(action.plannedFor) : Number.NaN;
  if (Number.isFinite(due) && due > Date.now()) {
    return {
      label: 'Waiting to send',
      chip: 'li-status-planned',
      detail: `Not before ${new Date(due).toLocaleString()} — inside this account’s working hours, at a human-looking gap.`
    };
  }
  const wait = queueWaitCopy(waitingFor);
  return {
    label: wait ? 'Waiting' : 'Due now',
    chip: 'li-status-planned',
    detail: wait
      ? `${wait}. Its planned time has arrived; Trevra will not replay missed clock ticks when the prerequisite returns.`
      : 'Its planned time has arrived and it is eligible for the next worker cycle. Nothing has reached them yet.'
  };
};

/** LinkedIn draws this from a photo; Trevra has none, so a solid tone stands in. Five tones, reused from the existing chip palette -- not a new one. */
const AVATAR_TONES = ['a', 'b', 'c', 'd', 'e'] as const;

/** First and last initial. `name` is never empty by the time this is called for real data, but a stray blank never renders nothing. */
const initials = (name: string | null | undefined) => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
};

/** Same person, same tint, for as long as this tab stays open -- a small hash over a fixed tone set, not a new palette and not a stored preference. */
const avatarTone = (seed: string) => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1)
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
};

/** The avatar-led row every native message UI draws. `seed` keys the tint to the PERSON (a profile URL, ideally), not the row, so a task and its later conversation read as the same person. */
function LiAvatar({
  name,
  seed,
  large
}: {
  name: string | null | undefined;
  seed: string;
  large?: boolean;
}) {
  return (
    <span
      className={`li-avatar li-avatar-${avatarTone(seed || name || '?')}${large ? ' li-avatar-lg' : ''}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** "Today" / "Yesterday" / a date -- read the way a person reads a calendar, never off a raw millisecond subtraction (which a timezone or a DST flip can push across midnight either direction). */
const dayLabel = (ms: number) => {
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  });
};

type ThreadItem =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'group'; key: string; direction: 'in' | 'out'; items: LinkedInMessageRecord[] };

/**
 * Consecutive same-direction messages collapse into one visual group -- the
 * who/when caption is said once per group, not once per bubble, the way
 * LinkedIn's own thread reads. A day divider is inserted only where `sentAt`
 * actually parsed, the same defensive read `messageTime` already does; a
 * null timestamp never invents a date or a divider.
 */
const groupMessages = (messages: LinkedInMessageRecord[]): ThreadItem[] => {
  const items: ThreadItem[] = [];
  let lastDay: string | null = null;
  let current: Extract<ThreadItem, { kind: 'group' }> | null = null;
  for (const message of messages) {
    const parsed = message.sentAt ? Date.parse(message.sentAt) : Number.NaN;
    if (Number.isFinite(parsed)) {
      const day = new Date(parsed).toDateString();
      if (day !== lastDay) {
        items.push({ kind: 'divider', key: `day-${message.id}`, label: dayLabel(parsed) });
        lastDay = day;
        current = null;
      }
    }
    if (current && current.direction === message.direction) current.items.push(message);
    else {
      current = {
        kind: 'group',
        key: `group-${message.id}`,
        direction: message.direction,
        items: [message]
      };
      items.push(current);
    }
  }
  return items;
};

/**
 * One row in the unified thread list -- a real conversation or a campaign
 * step waiting on the operator, sorted together by recency. See `inboxRows`
 * for what keeps a task from ever reading as a received message.
 */
type InboxRow =
  | { kind: 'task'; key: string; ts: number; task: ManualTaskView }
  | { kind: 'thread'; key: string; ts: number; thread: LinkedInThreadRecord };

export function OutreachInbox({ setToast }: { setToast: (message: string) => void }) {
  // Who queued each outbound message -- team-workspace-access design goal 5.
  // The same member list the switcher and Team settings read, not a second
  // fetch of who is in this workspace.
  const { nameFor } = useWorkspaceMembers();
  /**
   * The account the operator picked, wherever they picked it.
   *
   * Accounts, the queue and this screen are separate hash routes with no common
   * parent, so the choice lives in `localStorage` and an event rather than a
   * context. Reading it here is what stops the inbox showing one account while
   * the screen the operator just came from showed another.
   */
  const [activeSeatKey] = useActiveSeatKey();
  const [threads, setThreads] = useState<LinkedInThreadRecord[]>([]);
  const [seatDetail, setSeatDetail] = useState<LinkedInSeatResponse | null>(null);
  const [managed, setManaged] = useState<ManagedCampaign[]>([]);
  /** Campaign steps waiting on a human. Pending only: a closed task is not a to-do. */
  const [tasks, setTasks] = useState<ManualTaskView[]>([]);
  /**
   * UNFILTERED, and only read when a task exists.
   *
   * A task has to find its conversation even while the list on the left is
   * narrowed to unread, because "Trevra cannot send this for you" must mean
   * exactly that and never "your filter is hiding the thread".
   */
  const [taskThreads, setTaskThreads] = useState<LinkedInThreadRecord[]>([]);
  /** True when that read came back full, so a task's conversation may be past the ceiling. */
  const [taskThreadsTruncated, setTaskThreadsTruncated] = useState(false);
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_FILTERS);
  /** Narrows the same in-memory list the filters do -- name, snippet, or a task's draft. Never triggers a read of its own. */
  const [search, setSearch] = useState('');
  /** How deep the conversation list is currently reading. Raised a page at a time, never past `THREAD_MAX`. */
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE);
  const [openUrn, setOpenUrn] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<LinkedInConversation | null>(null);
  /** Every `reply` this workspace queued, so the composer can say where each one got to. */
  const [replies, setReplies] = useState<LinkedInActionView[]>([]);
  /** True when that read came back full: an older queued message to somebody may be missing from the strip. */
  const [repliesTruncated, setRepliesTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [syncing, setSyncing] = useState<'rail' | 'thread' | null>(null);
  const [error, setError] = useState('');
  /** A 409 from a sync route: something to go and do on this machine, shown verbatim. */
  const [blocked, setBlocked] = useState('');
  const [degraded, setDegraded] = useState<string[]>([]);
  /** Kept apart from `error`: a to-do list that failed to load must not blank the conversations. */
  const [taskError, setTaskError] = useState('');

  // The composer. One draft, because only one of the two panes is ever open.
  const [body, setBody] = useState('');
  const [queueing, setQueueing] = useState(false);
  /**
   * WHEN the reply being written is for. One control serves both composers,
   * because there is only ever one draft open on this screen.
   */
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('now');
  const [delayMinutes, setDelayMinutes] = useState(DELAY_CHOICES[1].minutes);
  /** A `datetime-local` value: local wall-clock, no zone, exactly as typed. */
  const [sendAt, setSendAt] = useState('');
  const [completing, setCompleting] = useState(false);
  /** The safety check's own sentence, verbatim. Not an error: a decision with a reason. */
  const [refusal, setRefusal] = useState('');
  const [queued, setQueued] = useState<{
    plannedFor: string;
    verdict: LinkedInSafetyVerdict;
  } | null>(null);
  /**
   * The queued message currently open for rewriting, and the draft of it.
   *
   * Kept apart from the composer's own `body`: one is a message that does not
   * exist yet, the other is bytes already in the ledger with a slot of their
   * own, and typing in one must never overwrite the other.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  /** The row a cancel is in flight for, so only its own button says so. */
  const [cancellingId, setCancellingId] = useState<string | null>(null);

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
        seatKey: activeSeatKey,
        limit: threadLimit
      });
      if (listToken.current !== token) return;
      setThreads(next);
      setError('');
    } catch (err) {
      if (listToken.current === token) {
        setError(
          errorMessage(
            err,
            'Unable to read the inbox. Nothing was changed — try the filters again.'
          )
        );
      }
    } finally {
      if (listToken.current === token) setLoading(false);
    }
  }, [filters.unread, filters.hasReply, filters.campaignId, activeSeatKey, threadLimit]);

  const loadTasks = useCallback(async () => {
    try {
      const next = await getLinkedInManualTasks({ status: 'pending', seatKey: activeSeatKey });
      setTasks(next);
      // Read as deep as the route allows, because this is the read that decides
      // whether Trevra can queue a task's message at all: a conversation past
      // the ceiling is indistinguishable from one that was never synced, and
      // the composer has to be able to tell those two apart.
      const conversations =
        next.length === 0
          ? []
          : await getLinkedInThreads({ seatKey: activeSeatKey, limit: THREAD_MAX });
      setTaskThreads(conversations);
      setTaskThreadsTruncated(conversations.length >= THREAD_MAX);
      setTaskError('');
    } catch (err) {
      setTaskError(
        errorMessage(
          err,
          'Unable to read the messages campaigns are waiting on you for. Nothing was changed.'
        )
      );
    }
  }, [activeSeatKey]);

  const loadReplies = useCallback(async () => {
    try {
      const next = await getLinkedInActions({
        kind: 'reply',
        seatKey: activeSeatKey,
        limit: REPLY_MAX
      });
      setReplies(next);
      setRepliesTruncated(next.length >= REPLY_MAX);
    } catch {
      /* the send-state strip adds to a conversation; it is never a reason to fail reading one */
    }
  }, [activeSeatKey]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);
  useEffect(() => {
    void loadTasks();
    void loadReplies();
  }, [loadTasks, loadReplies]);

  const reloadAll = useCallback(async () => {
    await Promise.allSettled([loadThreads(), loadTasks(), loadReplies()]);
  }, [loadThreads, loadTasks, loadReplies]);
  useOutreachRefresh(reloadAll);
  const hasLiveReplies = replies.some((action) => LIVE_REPLY_STATUSES.has(action.status));
  useEffect(() => {
    if (!hasLiveReplies) return;
    const timer = window.setInterval(() => {
      void reloadAll();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [hasLiveReplies, reloadAll]);

  useEffect(() => {
    void (async () => {
      try {
        setManaged(await getLinkedInManagedCampaigns());
      } catch {
        /* a task still names its person without a campaign name */
      }
      try {
        setSeatDetail(await getLinkedInSeat(activeSeatKey));
      } catch {
        setSeatDetail(null);
      }
    })();
  }, [activeSeatKey]);
  const campaignName = useCallback(
    (campaignId: string) =>
      managed.find((campaign) => campaign.id === campaignId)?.name ?? 'A campaign',
    [managed]
  );
  /**
   * The Campaign filter's own options, scoped to the active account.
   *
   * `managed` above stays unfiltered -- a task or reply already on screen may
   * name a campaign under an account the operator has since switched away
   * from, and `campaignName` still has to resolve it. The filter is a
   * different question: "which campaign, sending from the account I am
   * looking at", the same scoping `getLinkedInCampaigns(seatKey)` used to do
   * server-side before that route was deleted. `GET /api/linkedin/manager/campaigns`
   * has no seatKey param, so this filters the workspace-wide read it already
   * has rather than asking the server a second, narrower question.
   */
  const seatCampaigns = useMemo(
    () => managed.filter((campaign) => campaign.seatKey === activeSeatKey),
    [managed, activeSeatKey]
  );
  /**
   * A campaign filter chosen under one account does not carry over to another:
   * once `seatCampaigns` re-scopes, an id no longer among them would keep
   * querying by it while the select can show nothing selected -- an inbox
   * that reads empty with no visible reason. Cleared here, the same tick the
   * options change, so the visible filter and the query never disagree.
   */
  useEffect(() => {
    if (
      filters.campaignId &&
      !seatCampaigns.some((campaign) => campaign.id === filters.campaignId)
    ) {
      setFilters((current) => ({ ...current, campaignId: '' }));
    }
  }, [seatCampaigns, filters.campaignId]);
  const replyStageFor = useCallback(
    (action: LinkedInActionView) => replyStage(action, seatDetail?.execution.waitingFor),
    [seatDetail]
  );

  const visibleTasks = tasks;
  const openTask = useMemo(
    () => visibleTasks.find((task) => task.id === openTaskId) ?? null,
    [visibleTasks, openTaskId]
  );
  /** The conversation this task's person is already in, if the last sync found one. */
  const taskThread = useMemo(() => {
    const key = profileKey(openTask?.profileUrl);
    if (!key) return null;
    return taskThreads.find((thread) => profileKey(thread.profileUrl) === key) ?? null;
  }, [openTask, taskThreads]);
  const repliesFor = useCallback(
    (profileUrl: string | null | undefined) => {
      const key = profileKey(profileUrl);
      if (!key) return [];
      return replies.filter((action) => profileKey(action.targetRef) === key).slice(0, 4);
    },
    [replies]
  );

  /**
   * The message to this person that is still in flight, if there is one.
   *
   * Searches every row rather than the four the strip shows, because this is
   * the state the button turns on: one live reply per person, and the next one
   * queueable the moment this one is delivered or held back. Read off the same
   * rows the server would refuse against, so the screen and the ledger disagree
   * only for as long as it takes this list to be re-read.
   */
  const liveReplyTo = useCallback(
    (profileUrl: string | null | undefined) => {
      const key = profileKey(profileUrl);
      if (!key) return null;
      return (
        replies.find(
          (action) => profileKey(action.targetRef) === key && LIVE_REPLY_STATUSES.has(action.status)
        ) ?? null
      );
    },
    [replies]
  );

  /**
   * WHICH ACCOUNT THIS CONVERSATION IS IN, taken off the row that named it.
   *
   * Every inbox call behind this screen resolves a thread PER SEAT and defaults
   * to the owner's, so reading, refreshing or replying to a secondary account's
   * conversation without saying whose it is either 404s or -- worse -- resolves
   * a different account's thread of the same URN. The list rows carry
   * `seatKey`, so it is read from the row that was clicked rather than inferred
   * from the filter, which may well be "Any account".
   */
  const seatForThread = useCallback(
    (threadUrn: string): string | undefined =>
      threads.find((thread) => thread.threadUrn === threadUrn)?.seatKey ??
      taskThreads.find((thread) => thread.threadUrn === threadUrn)?.seatKey ??
      (conversation?.thread.threadUrn === threadUrn ? conversation.thread.seatKey : undefined) ??
      activeSeatKey,
    [threads, taskThreads, conversation, activeSeatKey]
  );

  const openThread = async (threadUrn: string) => {
    setOpenUrn(threadUrn);
    setOpenTaskId(null);
    setReading(true);
    setBody('');
    setRefusal('');
    setQueued(null);
    try {
      setConversation(await getLinkedInThread(threadUrn, seatForThread(threadUrn)));
      setError('');
    } catch (err) {
      setConversation(null);
      setError(errorMessage(err, 'Unable to read that conversation. Nothing was changed.'));
    } finally {
      setReading(false);
    }
  };

  /** A task is something to write, not something that arrived. Opening one loads its draft. */
  const selectTask = (task: ManualTaskView) => {
    setOpenTaskId(task.id);
    setOpenUrn(null);
    setConversation(null);
    setBody(task.suggestedBody ?? '');
    setRefusal('');
    setQueued(null);
  };

  /**
   * Walk the rail in a real browser.
   *
   * A 409 is not a fault: this process cannot open a browser for this account,
   * and the server's sentence names what to run and where. It goes in the calm
   * block, not the error banner.
   */
  const syncRail = async () => {
    setSyncing('rail');
    setBlocked('');
    setError('');
    setDegraded([]);
    try {
      const result = await syncLinkedInInbox({ seatKey: activeSeatKey });
      setDegraded(result.degraded);
      setToast(
        `${plural(result.threads, 'conversation')} walked · ${result.created} new, ${result.updated} updated, ` +
          `${plural(result.inbound, 'inbound message')} stored, ${result.linked} matched to a campaign.`
      );
      await reloadOutreach();
      if (openUrn) await openThread(openUrn);
    } catch (err) {
      const message = errorMessage(err, 'Unable to walk the inbox');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally {
      setSyncing(null);
    }
  };

  const syncOne = async (threadUrn: string) => {
    setSyncing('thread');
    setBlocked('');
    setError('');
    setDegraded([]);
    try {
      const seatKey = seatForThread(threadUrn);
      const result = await syncLinkedInThread(threadUrn, seatKey ? { seatKey } : {});
      setDegraded(result.degraded);
      setToast(`${plural(result.inserted, 'message')} stored, ${result.inbound} inbound.`);
      await openThread(threadUrn);
      await loadThreads();
      await loadReplies();
    } catch (err) {
      const message = errorMessage(err, 'Unable to re-read that conversation');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally {
      setSyncing(null);
    }
  };

  /**
   * Queue the message. NOTHING IS SENT HERE, and the copy under the button
   * says so -- then this screen keeps saying where it got to afterwards.
   *
   * A 409 is the safety check refusing in its own words. It is kept apart from
   * `error` on purpose: an error is something that went wrong, and this is the
   * account protection doing exactly its job.
   */
  const queueReply = async (threadUrn: string) => {
    if (!body.trim()) return;
    // Recomputed against the clock AT THE PRESS, so "in 3 hours" is three hours
    // from now and not from whenever the option was chosen.
    const slot = plannedForFrom(scheduleMode, delayMinutes, sendAt, new Date());
    if (slot.problem) {
      setError(slot.problem);
      return;
    }
    setQueueing(true);
    setRefusal('');
    setError('');
    setQueued(null);
    try {
      const result = await replyToLinkedInThread(
        threadUrn,
        body,
        slot.at ? slot.at.toISOString() : undefined,
        seatForThread(threadUrn)
      );
      setQueued({ plannedFor: result.plannedFor, verdict: result.verdict });
      setBody('');
      // The words are gone, so the time they were for goes with them: a stale
      // absolute instant silently reused on the next reply is the bug this
      // reset exists to prevent.
      setScheduleMode('now');
      setSendAt('');
      setToast(
        'Message queued. Nothing has been sent yet — this screen shows when it is typed into LinkedIn.'
      );
      await loadReplies();
      await reloadOutreach();
    } catch (err) {
      const message = errorMessage(err, 'Unable to queue that message');
      if (err instanceof ApiError && err.status === 409) setRefusal(message);
      else setError(message);
    } finally {
      setQueueing(false);
    }
  };

  /**
   * Close the checkpoint, AND NOTHING ELSE.
   *
   * This claims no bytes were sent by Trevra. It records that the operator
   * sent them -- in the tool, by hand, on the phone, it does not matter -- and
   * that word is the only thing that releases this person to the campaign's
   * next step. It is deliberately a second button.
   */
  const completeTask = async (task: ManualTaskView) => {
    setCompleting(true);
    setError('');
    try {
      await completeLinkedInManualTask(task.id);
      setToast(
        `${task.firstName} ${task.lastName} marked as messaged. The campaign can move them to its next step.`
      );
      setOpenTaskId(null);
      setBody('');
      await loadTasks();
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to close that one off. Nothing was changed.'));
    } finally {
      setCompleting(false);
    }
  };

  /**
   * Open a queued message for rewriting, with its own words in the box.
   *
   * The draft starts as what is ACTUALLY queued, read off the row, so an
   * operator edits the message rather than retyping it from memory.
   */
  const startEditingQueued = (action: LinkedInActionView) => {
    setEditingId(action.id);
    setEditDraft(action.body ?? '');
    setError('');
    setRefusal('');
  };

  /**
   * Change the words, and nothing else. Same person, same slot, same ledger row.
   *
   * A 409 here is the server refusing because the row moved -- almost always
   * the worker claiming it mid-edit -- so it is shown the way every other
   * refusal on this screen is: verbatim, as a decision with a reason.
   */
  const saveQueuedEdit = async (action: LinkedInActionView) => {
    if (!editDraft.trim()) return;
    setSavingEdit(true);
    setError('');
    setRefusal('');
    try {
      await editLinkedInActionBody(action.id, editDraft);
      setEditingId(null);
      setToast(
        'Message updated. Same person, same slot — only the words changed, and nothing has been sent.'
      );
      await loadReplies();
    } catch (err) {
      const message = errorMessage(err, 'Unable to change that message');
      if (err instanceof ApiError && err.status === 409) setRefusal(message);
      else setError(message);
    } finally {
      setSavingEdit(false);
    }
  };

  /** Drop a queued message before it is typed. Nothing reaches them, ever. */
  const cancelQueued = async (action: LinkedInActionView) => {
    setCancellingId(action.id);
    setError('');
    try {
      await skipLinkedInAction(action.id);
      if (editingId === action.id) setEditingId(null);
      setToast('Cancelled. It was never typed, so nothing reached them — you can write a new one.');
      await loadReplies();
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to cancel that message. Nothing was changed.'));
    } finally {
      setCancellingId(null);
    }
  };

  /** Where each message to this person got to. Read off the queued rows, never guessed. */
  const sendState = (profileUrl: string | null | undefined) => {
    const rows = repliesFor(profileUrl);
    if (rows.length === 0) return null;
    return (
      <div className="li-queued">
        <strong>
          <Clock size={14} />{' '}
          {rows.length === 1 ? 'Your message to them' : `Your last ${rows.length} messages to them`}
        </strong>
        {rows.map((action) => {
          const stage = replyStageFor(action);
          /**
           * WHAT A WAITING MESSAGE STILL ALLOWS.
           *
           * Until the worker claims a row its words are text in a database the
           * operator owns, so both controls are honest: rewriting changes what
           * will be typed and nothing else, and cancelling means nothing is ever
           * typed. A claimed row offers neither -- the browser may be typing
           * these very bytes -- and neither does a campaign's own copy.
           */
          const editable =
            action.status === 'planned' && !action.claimedAt && action.source === 'manual';
          const editing = editingId === action.id;
          return (
            <div className="li-chip-row" key={action.id}>
              <span className={`li-chip ${stage.chip}`}>{stage.label}</span>
              <p>{stage.detail}</p>
              {action.body && !editing && (
                <blockquote className="li-queued-body">{action.body}</blockquote>
              )}
              {editable && !editing && (
                <div className="li-queued-controls">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => startEditingQueued(action)}
                  >
                    <Pencil size={14} /> Edit these words
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={cancellingId === action.id}
                    onClick={() => void cancelQueued(action)}
                  >
                    <X size={14} /> {cancellingId === action.id ? 'Cancelling…' : 'Cancel it'}
                  </button>
                </div>
              )}
              {editing && (
                <div className="li-queued-edit">
                  <label className="li-block-label">
                    The words that will be typed
                    <textarea
                      rows={4}
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      placeholder="Write the message you want to send."
                    />
                  </label>
                  <div className="li-queued-controls">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={savingEdit || !editDraft.trim()}
                      onClick={() => void saveQueuedEdit(action)}
                    >
                      {savingEdit ? 'Saving…' : 'Save these words'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={savingEdit}
                      onClick={() => setEditingId(null)}
                    >
                      Leave it as it was
                    </button>
                  </div>
                  <p className="li-hint">
                    Words only. Same person, same slot, same safety checks — saving sends nothing,
                    and if Trevra picks the message up while you are typing, your change is refused
                    rather than half-applied.
                  </p>
                </div>
              )}
            </div>
          );
        })}
        {repliesTruncated && (
          <p className="li-hint">
            Only the {REPLY_MAX} most recent messages this workspace queued were read, so an older
            one to them may be missing from this list. Nothing here is guessed at either way.
          </p>
        )}
      </div>
    );
  };

  /**
   * WHEN, beside WHAT.
   *
   * The route has taken a `plannedFor` since it was written and this screen
   * never sent one, so every reply an operator wrote was for the next slot
   * whether that was what they meant or not. The three shapes are the three
   * things people actually say: send it when you can, send it after a wait,
   * send it at a time I am picking.
   *
   * Recomputed every render so the sentence under it stays true; the value
   * that is actually queued is recomputed again at the press.
   */
  const schedule = plannedForFrom(scheduleMode, delayMinutes, sendAt, new Date());
  const scheduleRow = (
    <fieldset className="li-schedule">
      <legend>When it should go out</legend>
      <div className="li-schedule-modes">
        <label>
          <input
            type="radio"
            name="li-schedule"
            checked={scheduleMode === 'now'}
            onChange={() => setScheduleMode('now')}
          />
          At the next slot Trevra can take
        </label>
        <label>
          <input
            type="radio"
            name="li-schedule"
            checked={scheduleMode === 'in'}
            onChange={() => setScheduleMode('in')}
          />
          After a wait of
          <Select
            value={delayMinutes}
            aria-label="How long to wait before this is sent"
            onChange={(event) => {
              setDelayMinutes(Number(event.target.value));
              setScheduleMode('in');
            }}
          >
            {DELAY_CHOICES.map((choice) => (
              <option key={choice.minutes} value={choice.minutes}>
                {choice.label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <input
            type="radio"
            name="li-schedule"
            checked={scheduleMode === 'at'}
            onChange={() => setScheduleMode('at')}
          />
          At
          <input
            type="datetime-local"
            value={sendAt}
            aria-label="The date and time this should be sent"
            onChange={(event) => {
              setSendAt(event.target.value);
              setScheduleMode('at');
            }}
          />
        </label>
      </div>
      <p className="li-hint">
        {schedule.problem ? (
          schedule.problem
        ) : schedule.at ? (
          <>
            Trevra runs every safety check again at {schedule.at.toLocaleString()} and types it in
            then. A slot outside this account’s working hours is refused when you press Queue, in
            the server’s own words — it is never quietly sent at some other time.
          </>
        ) : (
          <>
            Trevra takes the next slot its pacing and this account’s working hours allow. Nothing
            leaves when you press Queue either way.
          </>
        )}
      </p>
    </fieldset>
  );

  const filtered =
    filters.unread || filters.hasReply || Boolean(filters.campaignId) || Boolean(search.trim());
  const messages = conversation?.messages ?? [];
  /**
   * ONE LIST, NOT TWO. A native inbox is a single rail sorted by recency; a
   * task's "recency" is when the campaign asked for it (`createdAt`), a
   * conversation's is its last message. Search narrows this same in-memory
   * list and never triggers a read of its own -- it says nothing about what
   * the server returned. Nothing here changes what counts as unread or
   * has-a-reply: those stay properties of `threads` alone (the filters
   * above), so a task can never satisfy either one.
   */
  const inboxRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (parts: Array<string | null | undefined>) =>
      query === '' || parts.some((part) => (part ?? '').toLowerCase().includes(query));
    const rows: InboxRow[] = [];
    for (const task of visibleTasks) {
      if (!matches([task.firstName, task.lastName, task.company, task.suggestedBody])) continue;
      rows.push({
        kind: 'task',
        key: `task-${task.id}`,
        ts: Date.parse(task.createdAt) || 0,
        task
      });
    }
    for (const thread of threads) {
      if (!matches([thread.name, thread.snippet])) continue;
      rows.push({
        kind: 'thread',
        key: `thread-${thread.threadUrn}`,
        ts: thread.lastMessageAt ? Date.parse(thread.lastMessageAt) || 0 : 0,
        thread
      });
    }
    return rows.sort((a, b) => b.ts - a.ts);
  }, [visibleTasks, threads, search]);
  /**
   * Whether a message to the person in front of the operator is still in
   * flight, for each of the two panes. This is what the queue buttons below
   * turn on, and what their copy explains -- see `LIVE_REPLY_STATUSES`.
   */
  const taskLiveReply = openTask ? liveReplyTo(openTask.profileUrl) : null;
  const threadLiveReply = conversation ? liveReplyTo(conversation.thread.profileUrl) : null;

  return (
    <div className="page-stack">
      {error && (
        <div className="error-banner">
          <strong>{error}</strong> Whatever is below is the last good read.{' '}
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void reloadAll()}
          >
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read
            the inbox again
          </button>
        </div>
      )}

      {blocked && (
        <div className="li-connect-blocked">
          <strong>
            <CircleAlert size={14} /> One thing has to happen on your machine first.
          </strong>
          <p className="li-blocked-message">{blocked}</p>
          <p>Nothing was read and nothing was changed. What is below is still the last sync.</p>
        </div>
      )}

      {/* ONE ROW, because everything in it is a control.

          The title, a paragraph explaining the screen and the Sync button used
          to be a section heading, with the filters a second block under it --
          roughly two hundred pixels of standing copy above an inbox, every
          time, on a screen whose whole job is to show conversations. The
          sentence it carried is not lost: it is under the panes, next to the
          other standing fact about queued replies. */}
      <section className="page-panel li-inbox-bar">
        <h3 aria-level={2}>
          <Inbox size={16} /> Inbox
        </h3>
        <div className="li-inbox-filters" role="group" aria-label="Narrow the inbox">
          <span className="li-chip" aria-live="polite">
            {inboxRows.length} shown
          </span>
          {visibleTasks.length > 0 && (
            <span className="li-chip li-status-held">{visibleTasks.length} need you</span>
          )}
          <button
            type="button"
            className={`li-range ${filters.unread ? 'is-active' : ''}`}
            aria-pressed={filters.unread}
            onClick={() => setFilters((current) => ({ ...current, unread: !current.unread }))}
          >
            Unread
          </button>
          <button
            type="button"
            className={`li-range ${filters.hasReply ? 'is-active' : ''}`}
            aria-pressed={filters.hasReply}
            onClick={() => setFilters((current) => ({ ...current, hasReply: !current.hasReply }))}
          >
            Has a reply
          </button>
          <Select
            aria-label="Campaign"
            value={filters.campaignId}
            onChange={(event) =>
              setFilters((current) => ({ ...current, campaignId: event.target.value }))
            }
          >
            <option value="">Any campaign</option>
            {seatCampaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </Select>
          {loading && <LoaderCircle className="spin" size={14} aria-label="Reading the inbox" />}
        </div>
        <button
          className="secondary-button li-inbox-sync"
          type="button"
          disabled={syncing !== null}
          onClick={() => void syncRail()}
        >
          {syncing === 'rail' ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <RefreshCw size={14} />
          )}{' '}
          Sync the inbox
        </button>
      </section>

      {degraded.length > 0 && (
        <section className="page-panel">
          <div className="li-degraded">
            <strong>Walked, but not all of it came back:</strong>
            <ul>
              {degraded.slice(0, 8).map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
            <p>Anything missing is simply not stored. Nothing here is guessed at.</p>
          </div>
        </section>
      )}

      <div className="li-inbox">
        <section className="page-panel li-thread-pane">
          <div className="li-search-row">
            <Search className="li-search-icon" size={14} aria-hidden="true" />
            <input
              type="search"
              className="li-search-input"
              placeholder="Search messages"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search conversations and messages to write"
            />
          </div>

          {taskError && <p className="li-hint">{taskError}</p>}

          {inboxRows.length === 0 ? (
            <div className="empty-state">
              <Inbox size={26} />
              <h4 aria-level={3}>{filtered ? 'Nothing matches' : 'Nothing has been synced yet'}</h4>
              <p>
                {filtered
                  ? 'The filters and search above narrow what the last sync stored; they never fetch anything new.'
                  : 'Sync the inbox to walk the conversation rail. Trevra stores what LinkedIn rendered — it invents no message and no timestamp.'}
              </p>
              {/* Clearing drops the narrowing, not the account: the account is a
                choice made across outreach, and silently widening the inbox to
                every seat would be this screen overruling it. */}
              {filtered && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setFilters(EMPTY_FILTERS);
                  }}
                >
                  Clear the filters
                </button>
              )}
            </div>
          ) : (
            <ul className="li-thread-list">
              {inboxRows.map((row) =>
                row.kind === 'task' ? (
                  <li key={row.key}>
                    <button
                      type="button"
                      className={`li-thread ${openTaskId === row.task.id ? 'is-open' : ''}`}
                      onClick={() => selectTask(row.task)}
                    >
                      <LiAvatar
                        name={`${row.task.firstName} ${row.task.lastName}`}
                        seed={
                          profileKey(row.task.profileUrl) ||
                          `${row.task.firstName} ${row.task.lastName}`
                        }
                      />
                      <span className="li-thread-body">
                        <span className="li-thread-top">
                          <strong className="li-thread-name">
                            {row.task.firstName} {row.task.lastName}
                          </strong>
                          <span className="li-thread-time">{relativeTime(row.task.createdAt)}</span>
                        </span>
                        <span className="li-thread-snippet">
                          {row.task.suggestedBody?.trim() ||
                            'No draft was written for this step — the words are yours.'}
                        </span>
                        <span className="li-thread-meta">
                          <span className="li-chip li-status-planned">To write</span>
                          {row.task.company && <span>{row.task.company}</span>}
                          <span>{campaignName(row.task.campaignId)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={row.key}>
                    <button
                      type="button"
                      className={`li-thread ${openUrn === row.thread.threadUrn ? 'is-open' : ''}`}
                      onClick={() => void openThread(row.thread.threadUrn)}
                    >
                      <LiAvatar
                        name={row.thread.name}
                        seed={
                          profileKey(row.thread.profileUrl) ||
                          row.thread.name ||
                          row.thread.threadUrn
                        }
                      />
                      <span className="li-thread-body">
                        <span className="li-thread-top">
                          {row.thread.unread && (
                            <i className="li-unread-dot" aria-label="Unread at the last sync" />
                          )}
                          <strong className="li-thread-name">
                            {row.thread.name ?? <em className="li-unknown">Name unknown</em>}
                          </strong>
                          <span className="li-thread-time">
                            {row.thread.lastMessageAt
                              ? relativeTime(row.thread.lastMessageAt)
                              : '—'}
                          </span>
                        </span>
                        <span className="li-thread-snippet">
                          {row.thread.snippet || 'No snippet was rendered for this conversation.'}
                        </span>
                        <span className="li-thread-meta">
                          {row.thread.messageCount} message
                          {row.thread.messageCount === 1 ? '' : 's'}
                          {row.thread.hasReply && (
                            <span className="li-chip li-status-replied">replied</span>
                          )}
                          {row.thread.campaignId && <span className="li-chip">campaign</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              )}
            </ul>
          )}

          {/* A full page means there are older conversations this read did not
            ask for. It is deliberately not phrased as "N of M": the route
            returns rows and no count, so the total is a number nobody has
            measured and this screen will not print one. Keyed to `threads`,
            not `inboxRows`: this is about the server's own paging, and
            neither search nor folding tasks in changes what was asked for. */}
          {threads.length >= threadLimit && (
            <div className="panel-footer">
              <span>
                {threadLimit < THREAD_MAX ? (
                  <>
                    The {threads.length} most recently active conversations are shown. There are
                    older ones — this read simply did not ask for them.
                  </>
                ) : (
                  <>
                    The {THREAD_MAX} most recently active conversations are shown, which is as far
                    as one read of this list reaches. Narrow it by campaign above to bring older
                    ones into range.
                  </>
                )}
              </span>
              {threadLimit < THREAD_MAX && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={loading}
                  onClick={() =>
                    setThreadLimit((current) => Math.min(THREAD_MAX, current + THREAD_PAGE))
                  }
                >
                  {loading ? <LoaderCircle className="spin" size={14} /> : <Inbox size={14} />} Show
                  older conversations
                </button>
              )}
            </div>
          )}
        </section>

        <section className="page-panel li-convo">
          {openTask ? (
            <>
              <div className="section-heading li-convo-head">
                <div className="li-convo-title">
                  <LiAvatar
                    name={`${openTask.firstName} ${openTask.lastName}`}
                    seed={
                      profileKey(openTask.profileUrl) ||
                      `${openTask.firstName} ${openTask.lastName}`
                    }
                    large
                  />
                  <div>
                    <h3 aria-level={2}>
                      <ClipboardList size={16} /> Write to {openTask.firstName} {openTask.lastName}
                    </h3>
                    <p>
                      {openTask.company || 'Company unknown'} · {campaignName(openTask.campaignId)}{' '}
                      reached a step it will not do on its own, and has been waiting since{' '}
                      {new Date(openTask.createdAt).toLocaleString()}.
                    </p>
                    <p>
                      {openTask.profileUrl ? (
                        <a
                          className="li-seat-vanity"
                          href={openTask.profileUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {openTask.profileUrl}
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span className="li-unknown">
                          No profile URL is stored for this person.
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                {taskThread && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void openThread(taskThread.threadUrn)}
                  >
                    <MessageSquare size={14} /> Open the conversation
                  </button>
                )}
              </div>

              <div className="li-composer">
                <label className="li-block-label">
                  The message
                  <textarea
                    rows={5}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Write the message you want to send."
                  />
                </label>
                {scheduleRow}
                <p className="li-hint">
                  {openTask.suggestedBody?.trim()
                    ? 'This draft came from the campaign step. Change as much of it as you like — nothing goes anywhere until you queue it.'
                    : 'This step carries no draft, so nothing has been written for you.'}
                </p>

                {/* The server's sentence, verbatim, whichever refusal it is: the
                  day's ceiling, working hours, a paused account, or a message
                  to this person that has not been typed yet. Naming it as the
                  safety gate specifically would put the wrong sentence over the
                  last of those, so the heading says only what is certain --
                  nothing was queued, and the reason below is the server's. */}
                {refusal && (
                  <div className="li-gate-refusal">
                    <strong>
                      <ShieldCheck size={14} /> Trevra did not queue this message, and said why.
                    </strong>
                    <p className="li-blocked-message">{refusal}</p>
                    <p>
                      Nothing was queued and nobody was contacted. That is a decision with a reason,
                      not a failure.
                    </p>
                  </div>
                )}

                {queued && (
                  <div className="li-queued">
                    <strong>
                      <ShieldCheck size={14} /> Queued — planned for{' '}
                      {new Date(queued.plannedFor).toLocaleString()}.
                    </strong>
                    <p>
                      Nothing has been sent yet. Trevra runs every check below again the moment it
                      is due, then types the message into LinkedIn in a real browser at a
                      human-looking gap. It reads as Delivered here once it has.
                    </p>
                    <details className="li-gate-checks">
                      <summary>
                        What Trevra checked before queuing this (
                        {(queued.verdict.checks ?? []).length})
                      </summary>
                      <ul>
                        {(queued.verdict.checks ?? []).map((check) => (
                          <li key={check.check}>
                            <b>{check.check.replaceAll('-', ' ')}</b> — {check.detail}
                          </li>
                        ))}
                      </ul>
                      <p>{queued.verdict.automationReason}</p>
                    </details>
                  </div>
                )}

                {sendState(openTask.profileUrl)}

                {/*
                WHY THERE ARE TWO DIFFERENT LEFT-HAND BUTTONS HERE.

                that route is addressed by CONVERSATION: it looks the thread up,
                refuses one with no resolved profile URL, and paces the message
                against it. So a task whose person has no synced conversation
                has no thread to name, and there is no route on this API that
                opens a new one -- which is exactly the first message a campaign
                asks for. A permanently grey "Queue this message" said none of
                that; it just looked broken. So the grey button is gone, and its
                place is taken by the one action that can actually change the
                answer -- walking the rail, which is what files a thread row for
                somebody this account has already written to. Where even that
                cannot help, the copy names the way forward instead: send the
                first message on their profile, then mark it as sent.
              */}
                <div className="panel-footer li-composer-foot">
                  <span>
                    {taskThread ? (
                      <>
                        Trevra can send this one for you: it queues the message on the conversation
                        it already synced with {openTask.firstName} and types it in later.{' '}
                        <b>Marking it as sent is a separate act</b> — do that once the message has
                        really gone out, however it went out.
                      </>
                    ) : (
                      <>
                        Trevra types a message into a conversation LinkedIn has already shown it,
                        and it has synced none with {openTask.firstName}. Nothing here opens a new
                        one, so send this first message from their profile above and then{' '}
                        <b>mark it as sent</b>. If you have already written to them from this
                        account, <b>Sync the inbox</b> and the conversation appears — after that
                        Trevra can queue the next one for you.
                        {taskThreadsTruncated && (
                          <>
                            {' '}
                            Only the {THREAD_MAX} most recently active conversations were read, so
                            an older one with them would not have been seen.
                          </>
                        )}
                      </>
                    )}
                    {taskThread && taskLiveReply && (
                      <>
                        {' '}
                        One message to {openTask.firstName} is already queued and has not been typed
                        yet — it reads as <b>{replyStageFor(taskLiveReply).label}</b> above.
                        Queueing a second answer to the same message is refused; once that one is
                        typed in, or once they write again, the next is a different answer and goes
                        through.
                      </>
                    )}{' '}
                    Marking it as sent is what releases {openTask.firstName} to the campaign’s next
                    step; nothing else does.{' '}
                    <ConfidenceTag
                      confidence="REPORTED"
                      source="docs/linkedin-outreach-plan.md 1.3"
                      compact
                    />
                  </span>
                  <div className="li-row-actions">
                    {taskThread ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={queueing || !body.trim() || Boolean(schedule.problem)}
                        onClick={() => void queueReply(taskThread.threadUrn)}
                      >
                        {queueing ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <ListPlus size={15} />
                        )}{' '}
                        Queue this message
                      </button>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={syncing !== null}
                        onClick={() => void syncRail()}
                      >
                        {syncing === 'rail' ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <RefreshCw size={15} />
                        )}{' '}
                        Sync the inbox
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={completing}
                      onClick={() => void completeTask(openTask)}
                    >
                      {completing ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <CheckCircle2 size={15} />
                      )}{' '}
                      Mark as sent
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : !conversation ? (
            <p className="empty-copy">
              {reading
                ? 'Reading that conversation…'
                : 'Pick a conversation on the left, or one of the messages a campaign is waiting on you to write. A conversation shows what the last sync stored, oldest first.'}
            </p>
          ) : (
            <>
              <div className="section-heading li-convo-head">
                <div className="li-convo-title">
                  <LiAvatar
                    name={conversation.thread.name}
                    seed={
                      profileKey(conversation.thread.profileUrl) ||
                      conversation.thread.name ||
                      conversation.thread.threadUrn
                    }
                    large
                  />
                  <div>
                    <h3 aria-level={2}>{conversation.thread.name ?? 'Conversation'}</h3>
                    <p>
                      {conversation.thread.profileUrl ? (
                        <a
                          className="li-seat-vanity"
                          href={conversation.thread.profileUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {conversation.thread.profileUrl}
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span className="li-unknown">
                          No profile URL was resolved, so this conversation cannot be replied to
                          yet.
                        </span>
                      )}
                    </p>
                    <p>Last synced {relativeTime(conversation.thread.syncedAt)}.</p>
                  </div>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={syncing !== null}
                  onClick={() => void syncOne(conversation.thread.threadUrn)}
                >
                  {syncing === 'thread' ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}{' '}
                  Sync this thread
                </button>
              </div>

              {messages.length === 0 ? (
                <p className="empty-copy">
                  No message has been stored for this conversation. Sync it to read what LinkedIn
                  shows.
                </p>
              ) : (
                <ol className="li-msgs">
                  {groupMessages(messages).map((item) => {
                    if (item.kind === 'divider') {
                      return (
                        <li key={item.key} className="li-day-divider" role="presentation">
                          <span>{item.label}</span>
                        </li>
                      );
                    }
                    const last = item.items[item.items.length - 1];
                    const queuedBy = last.actionId ? nameFor(last.queuedByUserId) : null;
                    return (
                      <li key={item.key} className={`li-msg-group li-msg-group-${item.direction}`}>
                        <span className="li-msg-who">
                          {item.direction === 'in' ? 'Them' : 'You'}
                        </span>
                        {item.items.map((message) => (
                          <p key={message.id} className="li-msg-bubble">
                            {message.body}
                          </p>
                        ))}
                        <span className="li-msg-time">
                          {messageTime(last.sentAt) ?? 'No timestamp was rendered'}
                          {last.actionId &&
                            ` · sent through Trevra${queuedBy ? ` by ${queuedBy}` : ''}`}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="li-composer">
                <label className="li-block-label">
                  Your reply
                  <textarea
                    rows={4}
                    value={body}
                    disabled={!conversation.thread.profileUrl}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Write the reply. Trevra sends approved bytes and does not compose them."
                  />
                </label>
                {scheduleRow}

                {/* Verbatim, and headed neutrally for the same reason as the
                    task composer: "held back to keep the account safe" is the
                    wrong sentence over a refusal that says a reply to this
                    person is already in flight. */}
                {refusal && (
                  <div className="li-gate-refusal">
                    <strong>
                      <ShieldCheck size={14} /> Trevra did not queue this reply, and said why.
                    </strong>
                    <p className="li-blocked-message">{refusal}</p>
                    <p>
                      Nothing was queued and nobody was contacted. That is a decision with a reason,
                      not a failure.
                    </p>
                  </div>
                )}

                {queued && (
                  <div className="li-queued">
                    <strong>
                      <ShieldCheck size={14} /> Queued — planned for{' '}
                      {new Date(queued.plannedFor).toLocaleString()}.
                    </strong>
                    <p>
                      Nothing has been sent yet. Trevra runs every check below again the moment it
                      is due, then types the reply into LinkedIn in a real browser at a
                      human-looking gap. It reads as Delivered here once it has.
                    </p>
                    <details className="li-gate-checks">
                      <summary>
                        What Trevra checked before queuing this (
                        {(queued.verdict.checks ?? []).length})
                      </summary>
                      <ul>
                        {(queued.verdict.checks ?? []).map((check) => (
                          <li key={check.check}>
                            <b>{check.check.replaceAll('-', ' ')}</b> — {check.detail}
                          </li>
                        ))}
                      </ul>
                      <p>{queued.verdict.automationReason}</p>
                    </details>
                  </div>
                )}

                {sendState(conversation.thread.profileUrl)}

                {/* THE COPY STATES THE LEDGER'S RULE; THE BUTTON DOES NOT
                    PRETEND TO ENFORCE IT. The guard is keyed on the message
                    being answered, so "you already have an unsent answer to
                    this person" is checked by the server. Neither a stored
                    conversation nor that message rides out on a ledger row, so
                    this screen cannot evaluate the predicate. What it can do is
                    say the rule before the press and show the server's sentence
                    after it, which is what an operator needs either way. */}
                <div className="panel-footer li-composer-foot">
                  <span>
                    <b>Nothing leaves when you press this.</b> Trevra holds the reply against
                    {' this account'}, checks it again the moment it is due, then types it into
                    LinkedIn in a real browser inside your working hours. You watch it move from{' '}
                    <b>Waiting to send</b> to <b>Delivered</b> right here — and if it is held back
                    to keep the account safe, you get the reason in place of silence.
                    {threadLiveReply ? (
                      <>
                        {' '}
                        One answer to them is in flight already — it reads as{' '}
                        <b>{replyStageFor(threadLiveReply).label}</b> above.{' '}
                        <b>A second answer to the same message is refused</b>, in the server’s own
                        words; once that one is typed in, or once they write again, the next is a
                        different answer and is queued.
                      </>
                    ) : (
                      <>
                        {' '}
                        One unsent answer per message they send: a duplicate is refused with the
                        reason, and carrying the conversation on is not.
                      </>
                    )}{' '}
                    <ConfidenceTag
                      confidence="REPORTED"
                      source="docs/linkedin-outreach-plan.md 1.3"
                      compact
                    />
                  </span>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      queueing ||
                      !body.trim() ||
                      !conversation.thread.profileUrl ||
                      Boolean(schedule.problem)
                    }
                    onClick={() => void queueReply(conversation.thread.threadUrn)}
                  >
                    {queueing ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <ListPlus size={15} />
                    )}{' '}
                    Queue this reply
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <p className="panel-note">
        <MessageSquare size={13} /> Reading here never touches LinkedIn. Sync opens it in a real
        browser on this machine at paced gaps — every conversation that moved in the last 30 days,
        and the messages inside that window — and Trevra does the same walk on its own schedule.
        Queued replies count against this account’s daily message limit exactly like any other
        message Trevra sends.
      </p>
    </div>
  );
}
