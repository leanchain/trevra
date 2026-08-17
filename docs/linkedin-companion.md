# LinkedIn companion

The LinkedIn companion is the recommended execution path for hosted Trevra when the member is willing to keep their computer and Trevra open while outreach runs.

The hosted platform owns campaigns, due work, pacing, safety decisions, leases and the ledger. A tiny local CLI owns one thing: the visible Chrome process that is signed into LinkedIn. LinkedIn therefore sees the member's own computer and normal network/IP rather than an Oracle or cloud-browser address.

## User journey

1. Open **Outreach → LinkedIn accounts** in hosted Trevra.
2. Choose **Connect this computer**.
3. Run the generated one-time install command:

   ```bash
   npx --yes --package=https://github.com/leanchain/trevra/releases/download/companion-v0.2.0/trevra-0.2.0.tgz trevra linkedin install --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com
   ```

4. Trevra pairs the computer, installs a private per-user companion package and registers the operating system's background service. Chrome opens with a Trevra-specific persistent profile; sign into LinkedIn there if it is not already signed in.
5. In Trevra choose **Check this account on LinkedIn**. Trevra verifies which LinkedIn account the local browser is using and records the seat identity.
6. Keep a signed-in Trevra tab open while LinkedIn work should be eligible. The companion itself runs in the background; no terminal has to remain open.

The background companion also auto-updates on reconnect. Hosted Trevra advertises the required version before it offers any browser relay work. A newer version is installed from Trevra's official versioned GitHub release asset and the OS service restarts; pairing and the local Chrome profile are preserved. If an update cannot be installed, the existing working version stays in place and the failure is written to the local companion log.

Service controls are:

```bash
trevra linkedin status
trevra linkedin logs
trevra linkedin logs --follow
trevra linkedin start
trevra linkedin stop
trevra linkedin restart
trevra linkedin uninstall
```

`trevra linkedin logs` reads a small owner-only rolling activity log under `~/.trevra/logs/`; `--follow` streams it. The log records lifecycle/reconnect/browser/relay events only. It never records the device bearer token, LinkedIn cookies or passwords, raw CDP frames, or message contents.

`npx trevra linkedin` remains a foreground/debug mode. `uninstall` removes the OS service and its private npm tree but deliberately preserves the pairing config and dedicated LinkedIn browser profile.

No LinkedIn password has to be stored in hosted Trevra for this path. The persistent Chrome profile and its cookies stay under `~/.trevra/linkedin-companion/` on the member computer.

## Presence and backlog semantics

A companion workspace is eligible only while **both** of these leases are fresh:

- the paired background companion/WebSocket is online;
- a signed-in Trevra website tab is refreshing the website-presence lease.

Closing the laptop, stopping the background companion or closing every Trevra tab therefore stops new LinkedIn work without rewriting campaign state.

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

That means Trevra can control the **dedicated companion Chrome window** while the relay is active. The product and CLI therefore tell the user to keep unrelated private browsing out of that profile. The companion does not attach to the user's normal Chrome profile.

The companion provider deliberately differs from a cloud browser in three ways:

1. **No residential proxy is required or applied.** The point is to use the member computer's own network/IP.
2. **No `storageState` is restored from or exported to PostgreSQL.** Chrome's local persistent profile is the session.
3. **The existing persistent CDP context is used.** Trevra does not create a fresh cloud-style context for every sitting.

The reverse relay is in-memory on the API process. Oracle's current one-API-instance topology therefore needs no shared relay state. A future horizontally scaled API would need sticky companion WebSockets or a shared relay coordinator before this assumption changes.

## Server routes

Browser-session routes remain ordinary authenticated LinkedIn routes. Companion management adds:

```text
POST   /api/linkedin/companion/exchange       one-time CLI pairing exchange
GET    /api/linkedin/companion                devices + website presence
POST   /api/linkedin/companion/pair           owner-only pairing code
DELETE /api/linkedin/companion/devices/:id    owner-only revoke
POST   /api/linkedin/companion/presence       signed-in website heartbeat
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

The background service connects to Trevra immediately but does not open Chrome merely because the user logged into the computer. Chrome is opened/reused when Trevra actually requests a browser. The initial `install` command opens the dedicated profile once so the member can sign in.

A revoked device exits the background process cleanly rather than entering a crash-restart loop. Network interruptions stay inside the companion's bounded reconnect loop; genuine process crashes are restarted by the operating system.

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
