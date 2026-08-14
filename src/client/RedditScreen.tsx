import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Search,
  Send,
  ShieldCheck,
  Unplug
} from 'lucide-react';
import {
  commentOnReddit,
  deleteRedditCredentials,
  getRedditAccount,
  loginReddit,
  researchReddit,
  saveRedditCredentials,
  type RedditAccountResponse,
  type RedditLoginResult,
  type RedditResearchResult,
  type RedditThread,
  type RedditWorkerStatus
} from './api';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';

/**
 * Reddit, on one screen, in the order the work actually happens: connect the
 * account, read what people are saying, answer one of them.
 *
 * Two things are true here that are not true of the LinkedIn screens:
 *
 * 1. THERE IS NO PACING ENGINE BEHIND THIS SCREEN. A LinkedIn reply becomes a
 *    gated row that a worker drains at a randomised gap. A Reddit comment is
 *    posted by the button that says it posts one. The operator is the pacing
 *    engine, which is why every send affordance here says what it does in the
 *    same breath it offers to do it.
 * 2. THE HANDLE IS NOT SECRET. LinkedIn masks the sign-in email because nobody
 *    else ever sees it. Reddit prints `u/name` under every comment the account
 *    posts, so masking it here would only hide from the operator which account
 *    is about to speak.
 */

/** The four listings Reddit itself offers. Taken from the response type so the two cannot drift. */
type RedditSort = RedditResearchResult['reads'][number]['sort'];

const SORTS: RedditSort[] = ['hot', 'new', 'top', 'rising'];

/**
 * `SaaS, r/Entrepreneur selfhosted` -> `['SaaS', 'Entrepreneur', 'selfhosted']`.
 *
 * Commas and spaces both separate because both are how people write a list of
 * subreddits, and a leading `r/` is stripped because it is how people write a
 * subreddit. Deduplicated: the server walks these one at a time to stay under
 * the rate limit, so a name typed twice would cost a whole extra read.
 */
const parseSubreddits = (raw: string) => Array.from(new Set(
  raw.split(/[\s,]+/).map((name) => name.trim().replace(/^\/?r\//i, '')).filter(Boolean)
));

/**
 * A count Reddit did not render comes back as null, and it renders as a dash.
 *
 * NULL IS NOT ZERO. A thread whose score the listing withheld has not scored
 * nothing; printing `0` would state a number nobody measured, and the operator
 * picking which thread to answer would be reading a fact we invented.
 */
const countOf = (value: number | null) => value === null ? '—' : value.toLocaleString();

/** `u/name`, whether or not the listing already prefixed it. */
const authorHandle = (author: string | null) => author === null ? null : `u/${author.replace(/^u\//, '')}`;

/** One sentence each, deduplicated. The server already scopes `blockers` to this auth mode. */
const blockersOf = (worker: RedditWorkerStatus | null) => worker ? Array.from(new Set(worker.blockers)) : [];

export function RedditScreen({ setToast }: { setToast: (message: string) => void }) {
  const [account, setAccount] = useState<RedditAccountResponse | null>(null);
  const [loadError, setLoadError] = useState('');

  // Sign-in. `password` is the one value on this screen that must not outlive
  // its own submit, so nothing else ever reads it and it is cleared the moment
  // the request that carries it has been made.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'credentials' | 'otp'>('credentials');
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  /** The server's own sentence. 'instruction' is a step to take; 'error' is something that went wrong. */
  const [note, setNote] = useState<{ tone: 'error' | 'instruction'; message: string } | null>(null);

  const [subreddits, setSubreddits] = useState('');
  const [sort, setSort] = useState<RedditSort>('hot');
  const [limit, setLimit] = useState('25');
  const [reading, setReading] = useState(false);
  const [research, setResearch] = useState<RedditResearchResult | null>(null);
  const [researchError, setResearchError] = useState('');

  /** The URL of the one thread whose composer is open. One at a time; a reply deserves the whole attention. */
  const [composing, setComposing] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const auth = account?.auth ?? null;
  const worker = account?.worker ?? null;
  const blockers = blockersOf(worker);

  // A code the operator is halfway through typing outranks a stored credential:
  // the POST that saved it already succeeded, and swapping to the connected row
  // now would take the OTP field away mid-sign-in.
  const connected = Boolean(auth?.hasCredentials) && stage === 'credentials';

  const reload = useCallback(async () => {
    try {
      setAccount(await getRedditAccount());
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Unable to read the Reddit account'));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * One round of the login route, and the four things it can answer.
   *
   * `otp_required` is a STEP, not a failure: Reddit took the password and is
   * waiting on the code it just sent, so the card swaps to one field rather
   * than turning red. `challenge` is a thing to go and do. Only `failed` is an
   * error, and all three arrive as one sentence written by the server.
   */
  const runLogin = async (code?: string) => {
    const result: RedditLoginResult = await loginReddit(code);
    if (result.status === 'otp_required') {
      setStage('otp');
      setNote(null);
      return;
    }
    if (result.status === 'ok') {
      setStage('credentials');
      setOtp('');
      setNote(null);
      setToast('Signed into Reddit on this machine.');
      await reload();
      return;
    }
    setNote({ tone: result.status === 'challenge' ? 'instruction' : 'error', message: result.message });
  };

  const attempt = async (run: () => Promise<void>) => {
    setSigningIn(true);
    try { await run(); }
    catch (err) { setNote({ tone: 'error', message: errorMessage(err, 'Unable to sign in to Reddit') }); }
    finally { setSigningIn(false); }
  };

  const signIn = () => void attempt(async () => {
    // `u/pankaj` and `pankaj` are the same account, and the operator has no way
    // of knowing which form the login route wants. Only one of them is it.
    const handle = username.trim().replace(/^\/?u\//i, '');
    if (!handle || !password) {
      setNote({ tone: 'error', message: 'Both the username and the password are needed to sign in.' });
      return;
    }
    setNote(null);
    try {
      await saveRedditCredentials({ username: handle, password });
    } finally {
      // Out of component state the moment it is on the wire, whatever became of it.
      setPassword('');
    }
    await runLogin();
  });

  const disconnect = async () => {
    setDisconnecting(true);
    setNote(null);
    try {
      await deleteRedditCredentials();
      setStage('credentials');
      setUsername('');
      setOtp('');
      setToast('Credentials removed. Nothing on this machine can sign in until you add them again.');
      await reload();
    } catch (err) {
      setNote({ tone: 'error', message: errorMessage(err, 'Unable to remove the stored credentials') });
    } finally { setDisconnecting(false); }
  };

  const read = async () => {
    const names = parseSubreddits(subreddits);
    if (names.length === 0) {
      setResearchError('Name at least one subreddit to read.');
      return;
    }
    setReading(true);
    setResearchError('');
    try {
      const count = Number(limit);
      setResearch(await researchReddit({
        subreddits: names,
        sort,
        // An unreadable box is not an instruction to read everything: fall back
        // to the server's own default rather than sending NaN.
        limit: Number.isFinite(count) && count > 0 ? Math.min(100, Math.round(count)) : undefined
      }));
    } catch (err) {
      setResearchError(errorMessage(err, 'Unable to read those subreddits'));
    } finally { setReading(false); }
  };

  const openComposer = (url: string) => {
    setComposing(url);
    setReplyBody('');
    setReplyError(null);
  };

  /**
   * Post the comment, now, once.
   *
   * THERE IS NO RETRY BUTTON AND THERE MUST NOT BE ONE. A failure here does not
   * mean nothing was posted -- the request may have reached Reddit and only its
   * answer got lost -- and a comment that is already live cannot be un-posted.
   * So the server's sentence is shown verbatim, the composer stays open with
   * the words still in it, and the operator decides after looking at the
   * thread. Retrying on their behalf would risk a double post nobody can undo.
   */
  const postComment = async (url: string) => {
    setPosting(true);
    setReplyError(null);
    try {
      await commentOnReddit({ url, body: replyBody });
      setComposing(null);
      setReplyBody('');
      setToast('Comment posted to Reddit.');
    } catch (err) {
      setReplyError(errorMessage(err, 'Reddit did not accept the comment'));
    } finally { setPosting(false); }
  };

  return <div className="page-stack">
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>The Reddit account</h3>
          <p>One handle per workspace. It is the name printed under everything this screen posts.</p>
        </div>
        <MessageSquare size={20} className="li-heading-icon" />
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {/* Only when something is actually wrong, and one line per problem. */}
      {blockers.length > 0 && <ul className="li-blockers">
        {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>}

      {connected
        ? <div className="li-signin-row">
          <span className="li-signin-id"><MessageSquare size={15} /> {auth?.username ?? 'Reddit account'}</span>
          <span>{auth?.sessionValidAt
            ? `Session confirmed live ${relativeTime(auth.sessionValidAt)}`
            : 'Session not confirmed yet — the sign-in has not completed.'}</span>
          <div className="li-signin-actions">
            {!auth?.sessionValidAt && <button
              className="secondary-button"
              disabled={signingIn}
              onClick={() => void attempt(() => runLogin())}
            >{signingIn ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />} Sign in</button>}
            <button className="ghost-button danger" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />} Disconnect
            </button>
          </div>
        </div>
        : <>
          {/* The reassurance comes first, because after the password is typed a
              promise about it is not a promise, it is a receipt. */}
          {stage === 'credentials' && <div className="li-dryrun" style={{ marginTop: 14 }}>
            <ShieldCheck size={20} />
            <div>
              <strong>Before you type it — what happens to this password.</strong>
              <p>
                It is encrypted at rest. It is sent nowhere but Reddit. It is used for exactly one thing: opening a
                browser session on this machine. You can remove it at any time, and nothing here can sign in again once
                you have. No screen ever renders it back — the handle is the most Trevra will say, and that is public
                anyway.
              </p>
            </div>
          </div>}

          <div className="li-signin">
            <strong>Connect Reddit</strong>
            {stage === 'otp'
              ? <form className="li-signin-fields li-signin-otp" onSubmit={(event) => { event.preventDefault(); void attempt(() => runLogin(otp.trim())); }}>
                <label>Verification code<input
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  aria-label="Verification code"
                /></label>
                <button className="primary-button" type="submit" disabled={signingIn || otp.trim().length < 6}>
                  {signingIn ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Verify
                </button>
              </form>
              : <form className="li-signin-fields" onSubmit={(event) => { event.preventDefault(); signIn(); }}>
                <label>Reddit username<input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="yourhandle"
                /></label>
                <label>Reddit password<input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                /></label>
                <button className="primary-button" type="submit" disabled={signingIn}>
                  {signingIn ? <LoaderCircle className="spin" size={15} /> : <LogIn size={15} />} Sign in to Reddit
                </button>
              </form>}
            {stage === 'otp' && <p className="li-hint">Reddit sent a code to your email or authenticator. Enter it to finish signing in.</p>}
            {note && <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>{note.message}</p>}
          </div>
        </>}

      {connected && note && <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>{note.message}</p>}
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Read subreddits</h3>
          <p>Read-only. This button opens listings through the signed-in session and posts nothing.</p>
        </div>
        <Search size={20} className="li-heading-icon" />
      </div>

      {researchError && <div className="error-banner">{researchError}</div>}

      <div className="li-filter-row">
        <label>Subreddits<input
          value={subreddits}
          onChange={(event) => setSubreddits(event.target.value)}
          placeholder="SaaS, Entrepreneur, selfhosted"
        /></label>
        <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as RedditSort)}>
          {SORTS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select></label>
        <label>Posts each<input
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        /></label>
        <button className="primary-button" disabled={reading} onClick={() => void read()}>
          {reading ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />} Read
        </button>
      </div>

      <p className="li-hint">
        Separate names with commas or spaces; a leading <code>r/</code> is fine. They are walked one at a time rather
        than at once, because a burst of listing reads from one account is what gets an account rate-limited — several
        names take a while on purpose.
      </p>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Threads</h3>
          <p>Replying here posts the comment immediately. There is no queue and nothing to approve afterwards.</p>
        </div>
        <Send size={20} className="li-heading-icon" />
      </div>

      {/* Named rather than dropped. A private, banned or misspelled subreddit is
          the operator's next action, and a silent absence from the list below
          reads as "nobody is posting there". */}
      {research && research.refused.length > 0 && <div className="li-degraded">
        <strong>Not read at all:</strong>
        <ul>{research.refused.map((entry) => <li key={entry.subreddit}>r/{entry.subreddit} — {entry.reason}</li>)}</ul>
        <p>Nothing was read from these, so nothing below came from them.</p>
      </div>}

      {!research
        ? <div className="empty-state">
          <MessageSquare size={22} />
          <h4 aria-level={3}>Nothing read yet</h4>
          <p>Name a subreddit above and read it. What comes back is what the listing showed, unranked and unfiltered.</p>
        </div>
        : research.reads.length === 0
          ? <p className="empty-copy">No subreddit could be read. Every name is accounted for above.</p>
          : <div className="automation-list">
            {research.reads.map((entry) => <article key={`${entry.subreddit}:${entry.sort}`} className="automation-card">
              <div className="li-thread-top">
                <strong className="li-thread-name">r/{entry.subreddit} · {entry.sort}</strong>
                <span className="li-thread-time">{entry.threads.length} thread(s)</span>
              </div>

              {/* Verbatim, and never swallowed: a read that came back short is
                  not a subreddit that went quiet. */}
              {entry.degraded.length > 0 && <div className="li-degraded">
                <strong>Read, but not all of it came back:</strong>
                <ul>{entry.degraded.map((line) => <li key={line}>{line}</li>)}</ul>
                <p>Anything missing is held as unknown, never as zero.</p>
              </div>}

              {entry.threads.length === 0
                ? <p className="empty-copy">The listing rendered no posts.</p>
                : <div className="proof-items">
                  {entry.threads.map((thread) => <ThreadRow
                    key={thread.id}
                    thread={thread}
                    open={composing === thread.url}
                    body={replyBody}
                    posting={posting}
                    error={composing === thread.url ? replyError : null}
                    onOpen={() => openComposer(thread.url)}
                    onCancel={() => { setComposing(null); setReplyBody(''); setReplyError(null); }}
                    onBody={setReplyBody}
                    onPost={() => void postComment(thread.url)}
                  />)}
                </div>}
            </article>)}
          </div>}
    </section>
  </div>;
}

/**
 * One post, and the composer that answers it.
 *
 * The row holds no state of its own: which composer is open, what is typed in
 * it and what the last post attempt said all live one level up, so opening a
 * second composer cannot leave a half-written reply behind in the first.
 */
function ThreadRow({ thread, open, body, posting, error, onOpen, onCancel, onBody, onPost }: {
  thread: RedditThread;
  open: boolean;
  body: string;
  posting: boolean;
  error: string | null;
  onOpen: () => void;
  onCancel: () => void;
  onBody: (value: string) => void;
  onPost: () => void;
}) {
  const author = authorHandle(thread.author);

  return <div className="proof-item">
    <div className="li-thread-top">
      <a className="li-thread-name" href={thread.url} target="_blank" rel="noopener noreferrer">
        {thread.title} <ExternalLink size={11} />
      </a>
      <span className="li-thread-time">{thread.createdAt ? relativeTime(thread.createdAt) : '—'}</span>
    </div>

    <p className="li-thread-meta">
      <span>{author ?? <span className="li-unknown">author unknown</span>}</span>
      <span>· {countOf(thread.score)} points</span>
      <span>· {countOf(thread.comments)} comments</span>
    </p>

    {open
      ? <div className="li-composer">
        <label className="li-block-label">Your reply
          <textarea
            rows={4}
            value={body}
            onChange={(event) => onBody(event.target.value)}
            placeholder="Write the comment. Trevra posts the words you approved and does not compose them."
          />
        </label>

        {error && <>
          <div className="error-banner">{error}</div>
          {/* The copy has to say this, not just the code: an operator who presses
              a Reply button again after an error is not retrying, they are
              posting a second comment. */}
          <p className="li-hint">
            <CircleAlert size={13} /> There is no retry, on purpose. The comment may already be live — Reddit can
            accept a post and still fail to say so — and a duplicate cannot be un-posted. Open the thread and look
            before you send this again.
          </p>
        </>}

        <div className="panel-footer li-composer-foot">
          <span>
            <b>This posts the comment now.</b> No queue, no approval step, no safety gate between this button and
            r/{thread.subreddit ?? 'the thread'} — the account signed in above is the one that will have said it.
          </span>
          <div className="li-signin-actions">
            <button className="secondary-button" type="button" disabled={posting} onClick={onCancel}>Cancel</button>
            <button className="primary-button" type="button" disabled={posting || !body.trim()} onClick={onPost}>
              {posting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />} Post comment
            </button>
          </div>
        </div>
      </div>
      : <button className="secondary-button" type="button" onClick={onOpen}>
        <Send size={13} /> Reply
      </button>}
  </div>;
}
