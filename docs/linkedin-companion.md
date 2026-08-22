# LinkedIn companion

The LinkedIn companion is the recommended execution path for hosted Trevra when the member is willing to keep their computer on while outreach runs.

The hosted platform owns campaigns, due work, pacing, safety decisions, leases and the ledger. A tiny local CLI owns one thing: the dedicated Chrome process that is signed into LinkedIn. Normal background-service work runs headless; the same profile is opened visibly only for first sign-in or human-required recovery/debugging. LinkedIn therefore sees the member's own computer and normal network/IP rather than an Oracle or cloud-browser address.

## User journey

On dev and single-operator self-hosted installs, Trevra may preinstall/register the Companion before pairing (`npm run dev:setup` or `npm run selfhost:deploy`). Preinstall is pairing-independent: the OS service exits successfully while no device credential exists, so it cannot enter a crash loop or run browser work before authorization.

1. Open **Outreach → LinkedIn accounts** in Trevra.
2. Choose **Connect this computer**.
3. Run the generated one-time pairing/install command:

   ```bash
   npx --yes --package=https://github.com/leanchain/trevra/releases/download/companion-v0.2.2/trevra-0.2.2.tgz trevra linkedin install --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com
   ```

4. Trevra pairs the computer, ensures the exact private per-user companion package/service is installed, and starts it. When dev/self-host setup already installed that exact version, this step reuses it instead of reinstalling. Chrome opens with a Trevra-specific persistent profile; sign into LinkedIn there if it is not already signed in.
5. In Trevra choose **Check this account on LinkedIn**. Trevra verifies which LinkedIn account the local browser is using and records the seat identity.
6. The companion runs independently once paired: it works in the background as long as the paired computer is on, whether or not any Trevra tab is open. No terminal has to remain open.

The background companion also auto-updates on reconnect. Hosted Trevra advertises the required version before it offers any browser relay work. A newer version is installed from Trevra's official versioned GitHub release asset and the OS service restarts; pairing and the local Chrome profile are preserved. If an update cannot be installed, the existing working version stays in place and the failure is written to the local companion log.

Service controls are:

```bash
trevra linkedin setup
trevra linkedin status
trevra linkedin logs
trevra linkedin logs --follow
trevra linkedin reconnect
trevra linkedin start
trevra linkedin stop
trevra linkedin restart
trevra linkedin uninstall
```

`trevra linkedin logs` reads a small owner-only rolling activity log under `~/.trevra/logs/`; `--follow` streams it. The log records lifecycle/reconnect/browser/relay events only. It never records the device bearer token, LinkedIn cookies or passwords, raw CDP frames, or message contents.

`trevra linkedin reconnect` is the human-recovery path. When a headless session is signed out or hits a LinkedIn checkpoint, the worker records one reconnect-required seat transition and stops work for that account. Outreach shows the alert until a later successful session check proves the seat healthy. Hosted Trevra also emails the workspace owner for that unresolved session-attention transition and retries delivery from the worker's one-minute operational scan until it succeeds; when a later `session_reused`/`login` proves recovery, the matching recovery email is sent once. The reconnect command restarts the service into a one-time visible Chrome window using the same local profile; closing that window restarts the service in headless mode and triggers a fresh health verification even when no ordinary maintenance task is due. CAPTCHA/2FA answers stay entirely inside LinkedIn's page. `npx trevra linkedin` remains a foreground/debug mode. `uninstall` removes the OS service and its private npm tree but deliberately preserves the pairing config and dedicated LinkedIn browser profile.

A LinkedIn password never has to be stored in hosted Trevra for this path -- sign into the visible Chrome window by hand instead, and the persistent profile and its cookies stay under `~/.trevra/linkedin-companion/` on the member computer with nothing sent to Trevra. Saving a LinkedIn email and password in Trevra (Outreach -> LinkedIn accounts) is optional; if present, it is also used to sign the paired computer's browser in automatically whenever its session needs renewing, the same server-driven sign-in the headless/no-companion path already uses, instead of prompting a human to do it by hand in that window.

## Presence and backlog semantics

A companion workspace is eligible only while the paired background companion/WebSocket is online.

Closing the laptop or stopping the background companion therefore stops new LinkedIn work without rewriting campaign state. Trevra's web app is a status/config UI only -- closing every Trevra tab has no effect on whether background work runs.

Coming back online does **not** replay scheduler ticks that happened while the computer was away. Timer opportunities are not obligations. Trevra performs one ordinary bounded sitting using the same action budget, visit marker, working hours and rest windows as every other LinkedIn run, then returns to the normal cadence. Business work that is still relevant remains due and is reconsidered on later normal sittings.

The rule is:

> Catch up state, never catch up clock ticks.

The existing worker already enforces the bounded pieces underneath that rule:

- one seat lease at a time;
- one sitting action budget rather than drain-the-queue;
- a rest window between sittings;
- one side-task pass per natural LinkedIn visit;
- at most the bounded set of due side tasks for that visit;
- lead sourcing defaults to one source per unattended visit.

## Pairing security

The command shown by the website contains a **one-time pairing code**, not a reusable device credential.

- pairing code lifetime: 10 minutes;
- pairing code stored by Trevra: SHA-256 hash only;
- pairing code: one successful exchange only;
- device bearer token: generated only after the exchange;
- device token stored by Trevra: SHA-256 hash only;
- device token stored locally: `~/.trevra/companion.json`, owner-only mode where the platform supports POSIX permissions;
- revoking a computer invalidates its token immediately;
- exactly one active companion device is allowed per workspace;
- exchanging a new pairing code atomically revokes the previous device; merely generating a replacement code does not interrupt it;
- the relay also permits only one live companion control socket per workspace, so two local processes cannot drive LinkedIn simultaneously.

The CLI never receives `DATABASE_URL`, a Trevra session cookie, `TREVRA_SECRETS_KEY`, a cloud-browser API key or another tenant's identifier.

## Browser and network boundary

The CLI starts Chrome with:

- a dedicated persistent `user-data-dir` per `(workspace, LinkedIn account)`;
- a loopback-only ephemeral DevTools port;
- no public listening socket;
- the LinkedIn feed as the initial page.

The laptop opens one authenticated outbound WebSocket to Trevra. When the hosted worker needs a browser, Trevra creates a private reverse-CDP channel over that existing socket. The hosted Playwright client speaks CDP through the relay to the loopback Chrome instance.

That means Trevra can control the **dedicated companion Chrome profile** while the relay is active; in normal service mode it has no visible window. The product and CLI therefore tell the user to keep unrelated private browsing out of that profile. The companion does not attach to the user's normal Chrome profile.

The companion provider deliberately differs from a cloud browser in three ways:

1. **No residential proxy is required or applied.** The point is to use the member computer's own network/IP.
2. **No `storageState` is restored from or exported to PostgreSQL.** Chrome's local persistent profile is the session.
3. **The existing persistent CDP context is used.** Trevra does not create a fresh cloud-style context for every sitting.

The reverse relay is in-memory on the API process. Oracle's current one-API-instance topology therefore needs no shared relay state. A future horizontally scaled API would need sticky companion WebSockets or a shared relay coordinator before this assumption changes.

## Server routes

Browser-session routes remain ordinary authenticated LinkedIn routes. Companion management adds:

```text
POST   /api/linkedin/companion/exchange       one-time CLI pairing exchange
GET    /api/linkedin/companion                devices + attention state
POST   /api/linkedin/companion/pair           owner-only pairing code
DELETE /api/linkedin/companion/devices/:id    owner-only revoke
```

WebSockets:

```text
/api/linkedin/companion/socket                 public outbound laptop connection
/api/linkedin/companion/browser/:workspace/:seat  private worker-side CDP connection
```

The private browser WebSocket uses a relay credential derived with HMAC from `TREVRA_SECRETS_KEY`; that credential is never sent to the laptop.

## Oracle configuration

The two-micro Oracle app Compose file sets:

```env
TREVRA_COMPANION_RELAY_URL=ws://trevra:8080
```

for the API and worker. This is a private Compose-network address. The user's CLI reaches `/api/linkedin/companion/socket` through the existing Cloudflare Tunnel and needs no inbound port on Oracle or the laptop.

## Background service

The install command pins the service to the exact companion version that performed the install and stores it under `~/.trevra/service/`. OS service definitions contain only the local Node executable path and the stable companion CLI path; the device token never appears in systemd, launchd or Task Scheduler configuration.

- Linux: `~/.config/systemd/user/trevra-linkedin.service`, enabled for user login with `Restart=on-failure`.
- macOS: `~/Library/LaunchAgents/com.trevra.linkedin.plist`, `RunAtLoad` with restart after unsuccessful exits.
- Windows: per-user **Trevra LinkedIn Companion** scheduled task, triggered at interactive logon with restart-on-failure settings.

The background service connects to Trevra immediately but does not open Chrome merely because the user logged into the computer. When Trevra actually requests a browser, the service opens/reuses the dedicated profile in Chrome headless mode, so no window is placed in front of the user. The initial `install` command opens that profile visibly once so the member can sign in; closing that onboarding window restarts the service into headless mode. Later login, CAPTCHA/2FA or device-check recovery uses `trevra linkedin reconnect`: the service temporarily opens the same profile visibly and automatically returns to background mode when that window closes.

A revoked device exits the background process cleanly rather than entering a crash-restart loop. Network interruptions stay inside the companion's bounded reconnect loop; genuine process crashes are restarted by the operating system. The API tracks the live control WebSocket separately from the database heartbeat, so a known socket close is reflected immediately instead of looking online for the rest of the 90-second lease. Hosted disconnect email waits through a five-minute blip grace and is scanned independently once a minute; `disconnect_notified_at` is written only after an owner email is actually delivered, so missing recipients or SMTP failure remain retryable rather than being recorded as a notification that never happened.

## npm package

The publishable package lives in `packages/trevra-cli` and owns the public `trevra` binary.

Release checks:

```bash
cd packages/trevra-cli
npm pack --dry-run
npm publish --access public
```

The intended command is:

```bash
npx trevra linkedin
```

The repository root remains `"private": true`; publishing must be performed from `packages/trevra-cli`, never from the application root.
