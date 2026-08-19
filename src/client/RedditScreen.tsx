import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  LoaderCircle,
  LogIn,
  MessageSquare,
  ShieldCheck,
  Unplug
} from 'lucide-react';
import {
  deleteRedditCredentials,
  getRedditAccount,
  loginReddit,
  saveRedditCredentials,
  type RedditAccountResponse,
  type RedditLoginResult,
  type RedditWorkerStatus
} from './api';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';

/**
 * The Reddit account: connect with credentials, confirm the session, or
 * disconnect. Reading subreddits and posting comments live next to the
 * research corpus now, not here.
 *
 * THE HANDLE IS NOT SECRET. LinkedIn masks the sign-in email because nobody
 * else ever sees it. Reddit prints `u/name` under the account, so masking it
 * here would only hide from the operator which account is connected.
 */

/** One sentence each, deduplicated. The server already scopes `blockers` to this auth mode. */
const blockersOf = (worker: RedditWorkerStatus | null) =>
  worker ? Array.from(new Set(worker.blockers)) : [];

export function RedditAccountPanel({ setToast }: { setToast: (message: string) => void }) {
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

  useEffect(() => {
    void reload();
  }, [reload]);

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
    setNote({
      tone: result.status === 'challenge' ? 'instruction' : 'error',
      message: result.message
    });
  };

  const attempt = async (run: () => Promise<void>) => {
    setSigningIn(true);
    try {
      await run();
    } catch (err) {
      setNote({ tone: 'error', message: errorMessage(err, 'Unable to sign in to Reddit') });
    } finally {
      setSigningIn(false);
    }
  };

  /**
   * The only way out of the OTP stage that isn't a page reload.
   *
   * The username stays -- it's still state, nothing cleared it. The password
   * does not come back: it was wiped from memory the moment it went on the
   * wire, and that isn't something a Back button should undo. The stale code
   * and whatever the last attempt said both go, because neither means
   * anything once the operator is back to fixing what they typed.
   */
  const backToCredentials = () => {
    setStage('credentials');
    setOtp('');
    setNote(null);
  };

  const signIn = () =>
    void attempt(async () => {
      // `u/pankaj` and `pankaj` are the same account, and the operator has no way
      // of knowing which form the login route wants. Only one of them is it.
      const handle = username.trim().replace(/^\/?u\//i, '');
      if (!handle || !password) {
        setNote({
          tone: 'error',
          message: 'Both the username and the password are needed to sign in.'
        });
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
      setToast(
        'Credentials removed. Nothing on this machine can sign in until you add them again.'
      );
      await reload();
    } catch (err) {
      setNote({
        tone: 'error',
        message: errorMessage(err, 'Unable to remove the stored credentials')
      });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>The Reddit account</h3>
            <p>
              One handle per workspace. It is the name printed under everything this screen posts.
            </p>
          </div>
          <MessageSquare size={20} className="li-heading-icon" />
        </div>

        {loadError && <div className="error-banner">{loadError}</div>}

        {/* Only when something is actually wrong, and one line per problem. */}
        {blockers.length > 0 && (
          <ul className="li-blockers">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        )}

        {connected ? (
          <div className="li-signin-row">
            <span className="li-signin-id">
              <MessageSquare size={15} /> {auth?.username ?? 'Reddit account'}
            </span>
            <span>
              {auth?.sessionValidAt
                ? `Session confirmed live ${relativeTime(auth.sessionValidAt)}`
                : 'Session not confirmed yet — the sign-in has not completed.'}
            </span>
            <div className="li-signin-actions">
              {!auth?.sessionValidAt && (
                <button
                  className="secondary-button"
                  disabled={signingIn}
                  onClick={() => void attempt(() => runLogin())}
                >
                  {signingIn ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />}{' '}
                  Sign in
                </button>
              )}
              <button
                className="ghost-button danger"
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                {disconnecting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />}{' '}
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* The reassurance comes first, because after the password is typed a
              promise about it is not a promise, it is a receipt. */}
            {stage === 'credentials' && (
              <div className="li-dryrun" style={{ marginTop: 14 }}>
                <ShieldCheck size={20} />
                <div>
                  <strong>Before you type it — what happens to this password.</strong>
                  <p>
                    It is encrypted at rest. It is sent nowhere but Reddit. It is used for exactly
                    one thing: opening a browser session on this machine. You can remove it at any
                    time, and nothing here can sign in again once you have. No screen ever renders
                    it back — the handle is the most Trevra will say, and that is public anyway.
                  </p>
                </div>
              </div>
            )}

            <div className="li-signin">
              <strong>Connect Reddit</strong>
              {stage === 'otp' ? (
                <form
                  className="li-signin-fields li-signin-otp"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void attempt(() => runLogin(otp.trim()));
                  }}
                >
                  <label>
                    Verification code
                    <input
                      value={otp}
                      onChange={(event) => setOtp(event.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      aria-label="Verification code"
                    />
                  </label>
                  <div className="li-signin-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={signingIn}
                      onClick={backToCredentials}
                    >
                      <ArrowLeft size={14} /> Back
                    </button>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={signingIn || otp.trim().length < 6}
                    >
                      {signingIn ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Check size={15} />
                      )}{' '}
                      Verify
                    </button>
                  </div>
                </form>
              ) : (
                <form
                  className="li-signin-fields"
                  onSubmit={(event) => {
                    event.preventDefault();
                    signIn();
                  }}
                >
                  <label>
                    Reddit username
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      placeholder="yourhandle"
                    />
                  </label>
                  <label>
                    Reddit password
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={signingIn}>
                    {signingIn ? <LoaderCircle className="spin" size={15} /> : <LogIn size={15} />}{' '}
                    Sign in to Reddit
                  </button>
                </form>
              )}
              {stage === 'otp' && (
                <p className="li-hint">
                  Reddit sent a code to your email or authenticator. Enter it to finish signing in.
                </p>
              )}
              {note && (
                <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>
                  {note.message}
                </p>
              )}
            </div>
          </>
        )}

        {connected && note && (
          <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>
            {note.message}
          </p>
        )}
      </section>
    </div>
  );
}
