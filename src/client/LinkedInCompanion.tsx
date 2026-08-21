import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Copy, Laptop, LoaderCircle, Unplug } from 'lucide-react';
import {
  createLinkedInCompanionPairing,
  getLinkedInCompanionStatus,
  getLinkedInWorkerStatus,
  revokeLinkedInCompanionDevice,
  type LinkedInCompanionStatus,
  type LinkedInWorkerStatus
} from './api';
import { OWNER_ACCOUNT_KEY } from './LinkedInActiveAccount';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { Hint } from './ui/hint';

export function Wall({
  title,
  message,
  children
}: {
  title: string;
  message?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="li-connect-blocked">
      <strong>
        <CircleAlert size={14} /> {title}
      </strong>
      {message && <p className="li-blocked-message">{message}</p>}
      {children}
    </div>
  );
}

/**
 * Human-required companion recovery, shown across every Outreach route rather
 * than only on the Accounts screen. The server derives this from the latest
 * auth event for each seat, so a successful session check removes the banner
 * without a separate dismiss/clear write that could lie about browser state.
 */
export function LinkedInCompanionAttention({ setToast }: { setToast: (message: string) => void }) {
  const [status, setStatus] = useState<LinkedInCompanionStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [next, worker] = await Promise.all([
        getLinkedInCompanionStatus(),
        getLinkedInWorkerStatus()
      ]);
      setStatus(worker.companionBrowser ? next : null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // Reconnect is interactive; 30s made a correct server-side clear feel
    // broken. Ten seconds stays light while making recovery visibly converge.
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useOutreachRefresh(load);

  const noDeviceOnline =
    Boolean(status) &&
    (status!.devices.length === 0 || !status!.devices.some((device) => device.online));
  if (!status?.attention.length && !noDeviceOnline) return null;

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setToast('Reconnect command copied. Run it on the paired computer.');
    } catch {
      setToast('Copy was blocked. Select the reconnect command and copy it manually.');
    }
  };

  const offlineDevice =
    status && status.devices.length > 0
      ? (status.devices.find((device) => !device.online) ?? null)
      : null;

  return (
    <>
      {/* Nothing at all can run LinkedIn work right now -- a different, more
        fundamental problem than a single account needing a human (below).
        Kept visually heavier (danger vs. warning) so the two are never
        confused at a glance. */}
      {noDeviceOnline && (
        <section
          className="page-panel li-companion-attention li-companion-offline"
          role="alert"
          aria-live="polite"
        >
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>
                <Laptop size={17} /> No computer connected for LinkedIn
              </h3>
              {status!.devices.length === 0 ? (
                <p>
                  Background LinkedIn work is paused. Connect a computer from{' '}
                  <a href="/setup/workspace">Setup → Workspace</a> to start it.
                </p>
              ) : (
                <p>Background LinkedIn work is paused because the paired computer is offline.</p>
              )}
            </div>
          </div>
          <div className="li-companion-attention-list">
            <div className="li-companion-attention-row">
              <div>
                {status!.devices.length === 0 ? (
                  <>
                    <strong>No computer has ever been paired</strong>
                    <p>
                      Connect a computer from <a href="/setup/workspace">Setup → Workspace</a> to
                      run LinkedIn work in the background.
                    </p>
                  </>
                ) : (
                  <>
                    <strong>{offlineDevice?.label ?? 'Paired computer'} is offline</strong>
                    <p>
                      {offlineDevice?.lastSeenAt ? (
                        <>Not seen since {relativeTime(offlineDevice.lastSeenAt)}.</>
                      ) : (
                        'Never connected.'
                      )}{' '}
                      LinkedIn work is paused until it is back online.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {status?.attention.length ? (
        <section className="page-panel li-companion-attention" role="alert" aria-live="polite">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>
                <CircleAlert size={17} /> LinkedIn needs your attention
              </h3>
              <p>
                Background work is held for the affected account until its local LinkedIn session is
                healthy again.
              </p>
            </div>
          </div>
          <div className="li-companion-attention-list">
            {status.attention.map((item) => {
              const command =
                item.seatKey === OWNER_ACCOUNT_KEY
                  ? 'trevra linkedin reconnect'
                  : `trevra linkedin reconnect --seat ${item.seatKey}`;
              return (
                <div className="li-companion-attention-row" key={item.seatKey}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.message}</p>
                    <small>
                      Raised {relativeTime(item.since)}. Complete the LinkedIn check in the visible
                      Trevra Chrome window, then close that window; the background service resumes
                      automatically.
                    </small>
                  </div>
                  <div className="li-companion-reconnect-command">
                    <code>{command}</code>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void copy(command)}
                    >
                      <Copy size={14} /> Copy
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------
 * The paired computer: hosted Trevra, local LinkedIn browser.
 * ---------------------------------------------------------------------- */

export function CompanionPanel({ setToast }: { setToast: (message: string) => void }) {
  const [status, setStatus] = useState<LinkedInCompanionStatus | null>(null);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
    command: string;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const hadDevice = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await getLinkedInCompanionStatus();
      setStatus(next);
      setError('');
      if (next.devices.length > 0) {
        if (!hadDevice.current) {
          hadDevice.current = true;
          window.dispatchEvent(new Event('trevra:linkedin-companion-changed'));
        }
      } else {
        hadDevice.current = false;
      }
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to read connected computers.'));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const pair = async () => {
    setBusy('pair');
    setError('');
    try {
      const created = await createLinkedInCompanionPairing();
      setPairing(created);
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to create a pairing code.'));
    } finally {
      setBusy('');
    }
  };

  const copy = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.command);
      setToast('Install command copied. Run it once on the computer that should use LinkedIn.');
    } catch {
      setToast('Copy was blocked by the browser. Select the command and copy it manually.');
    }
  };

  const revoke = async (deviceId: string, label: string) => {
    setBusy(deviceId);
    setError('');
    try {
      await revokeLinkedInCompanionDevice(deviceId);
      setToast(`${label} disconnected. It can no longer lend Trevra a LinkedIn browser.`);
      window.dispatchEvent(new Event('trevra:linkedin-companion-changed'));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to disconnect that computer.'));
    } finally {
      setBusy('');
    }
  };

  const online = status?.devices.find((device) => device.online) ?? null;
  return (
    <section className="page-panel li-companion-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>
            Run LinkedIn from your computer
            <Hint label="Why run LinkedIn from your computer">
              Recommended for hosted Trevra. LinkedIn opens in Chrome on your computer, on your own
              IP — Trevra keeps the queue and safety rules; your browser profile stays local.
            </Hint>
          </h3>
        </div>
        <Laptop size={20} className="li-heading-icon" />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="li-companion-status">
        <span className={`li-acct-state ${online ? 'li-acct-state-ok' : 'li-acct-state-off'}`}>
          <i
            className={`li-acct-dot ${online ? 'li-acct-dot-ok' : 'li-acct-dot-off'}`}
            aria-hidden="true"
          />
          {online ? `${online.label} online` : 'No paired computer online'}
        </span>
      </div>

      {status && status.devices.length > 0 ? (
        <div className="li-companion-devices">
          {status.devices.map((device) => (
            <div className="li-companion-device" key={device.id}>
              <div>
                <strong>{device.label}</strong>
                <small>
                  {device.online
                    ? 'Online now'
                    : device.lastSeenAt
                      ? `Last seen ${relativeTime(device.lastSeenAt)}`
                      : 'Never connected'}
                </small>
              </div>
              {status.canDisconnect && (
                <button
                  className="ghost-button danger"
                  type="button"
                  disabled={busy === device.id}
                  onClick={() => void revoke(device.id, device.label)}
                >
                  {busy === device.id ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Unplug size={13} />
                  )}{' '}
                  Disconnect
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-copy">
          Pair the computer whose browser and network you normally use for LinkedIn.
        </p>
      )}

      {!status?.canManage && (
        <p className="panel-note">
          Only the workspace owner can pair or replace a computer. Workspace members can keep the
          paired computer active and disconnect it.
        </p>
      )}

      {status?.canManage && pairing ? (
        <div className="li-companion-command">
          <div>
            <strong>Install once on this computer</strong>
            <p>
              Expires {relativeTime(pairing.expiresAt)}. Installs a background companion that starts
              at login and survives crashes; the device token is created only once this code is
              used, and is never shown in Trevra.
            </p>
          </div>
          <code>{pairing.command}</code>
          <button className="secondary-button" type="button" onClick={() => void copy()}>
            <Copy size={14} /> Copy command
          </button>
          {status.devices.length > 0 && (
            <p className="panel-note">
              Finishing this pairing replaces the currently paired computer. Trevra allows only one
              active LinkedIn companion per workspace.
            </p>
          )}
        </div>
      ) : status?.canManage ? (
        <button
          className="primary-button"
          type="button"
          disabled={busy === 'pair'}
          onClick={() => void pair()}
        >
          {busy === 'pair' ? <LoaderCircle className="spin" size={14} /> : <Laptop size={14} />}{' '}
          {status.devices.length > 0 ? 'Replace computer' : 'Connect this computer'}
        </button>
      ) : null}

      <p className="panel-note">
        <Hint label="How background mode works" trigger={<>How background mode works</>}>
          Starts at login and survives crashes — no terminal to keep open. Runs in background Chrome
          — no Trevra tab needs to stay open. A sign-in prompt, CAPTCHA, 2FA or device check pauses
          work and shows a reconnect alert — its command opens the profile visibly for that one
          step, then background mode resumes. Coming back online runs one bounded state catch-up,
          then returns to the normal schedule — missed ticks are never replayed.
        </Hint>
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * What this machine can and cannot do, said before anybody types a password.
 * ---------------------------------------------------------------------- */

export function WorkerNotice({ worker }: { worker: LinkedInWorkerStatus | null }) {
  if (!worker || worker.ready) return null;
  const blockers = Array.from(new Set(worker.blockers));

  /**
   * WHICH WALL THIS IS, read off the payload's own booleans instead of out of
   * its prose.
   *
   * These are the same three fields the server computes `ready` from
   * (`enabled && playwrightInstalled && (canLaunchHeaded || canLaunchHeadless)`),
   * so this panel cannot disagree with the flag that made it appear, and no
   * rewording of a blocker sentence can flip it. A HEADED browser counts, and
   * counting only the headless one is what had this wall appear on a machine
   * driving a real Chrome on an Xvfb display -- over the sentence explaining
   * that it declines to open an INVISIBLE browser. It also fixes the half of that guess
   * that was visible: the `npx playwright install` line is now printed under
   * exactly the condition the server emits that blocker under, rather than at
   * anybody whose blocker happened not to contain the word "hosted" -- which
   * included every operator who already has playwright.
   *
   * lc-debt: HOSTED-VERSUS-SWITCHED-OFF IS STILL NOT DISTINGUISHABLE HERE.
   * `linkedInOffReason` knows (`config.hosted`) and says so in its sentence,
   * but the status payload carries no flag for it. So the copy below claims
   * only what `enabled: false` proves -- automation is off on THIS server --
   * and leaves the server's own blocker, rendered verbatim underneath, to say
   * whether that is a deployment decision no setting can undo. Upgrade path:
   * add `hosted: boolean` to GET /api/linkedin/worker/status and branch the
   * first paragraph on it.
   */
  const off = !worker.enabled;
  const needsPlaywright = worker.enabled && !worker.playwrightInstalled;

  return (
    <Wall
      title={
        off
          ? 'LinkedIn automation is off on this server.'
          : needsPlaywright
            ? 'Nothing on this machine can open LinkedIn yet.'
            : 'This machine has Playwright but cannot open a browser.'
      }
    >
      <p>
        {off
          ? 'You can still add accounts here and set their hours and daily limits. Connecting one, and sending from it, happens on a Trevra with LinkedIn automation on — the reason it is off here is below, in the server’s own words.'
          : needsPlaywright
            ? 'Add accounts and set their limits now. Connecting one needs a browser this server can open, which is two commands and a switch.'
            : 'Add accounts and set their limits now. Connecting one needs a browser this server can open, and what is stopping it from opening one is below.'}
      </p>
      {needsPlaywright && (
        <p className="li-blocked-message">
          <code>npm i playwright &amp;&amp; npx playwright install chromium</code>
        </p>
      )}
      {blockers.length > 0 && (
        <ul className="li-blockers">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
    </Wall>
  );
}
