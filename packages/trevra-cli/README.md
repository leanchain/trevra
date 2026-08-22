# trevra

The official Trevra companion CLI.

For hosted LinkedIn execution, Trevra keeps campaigns, pacing and safety rules in the hosted platform while Chrome runs on your own computer. The installed service uses Chrome in background/headless mode for normal work, so no browser window needs to sit in front of your desktop. LinkedIn traffic therefore uses your computer's normal network/IP, and the persistent LinkedIn browser profile stays on your computer.

## Install once

Dev/self-host setup can preinstall the package and OS service definition without pairing:

```sh
trevra linkedin setup
```

`setup` is idempotent and leaves an unpaired service cleanly inactive. Use `--force` only when developing the Companion itself and you intentionally want to replace the same-version local package.

Then, in Trevra, open **Outreach → LinkedIn accounts → Connect this computer** and copy the generated command. It looks like:

```sh
npx --yes --package=https://github.com/leanchain/trevra/releases/download/companion-v0.2.2/trevra-0.2.2.tgz trevra linkedin install --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com
```

The command pairs the computer, ensures the exact Trevra companion version exists in the private per-user directory, registers the OS background service if needed, opens the dedicated LinkedIn Chrome profile visibly once for first sign-in, and starts the service. When `setup` already installed that exact version, pairing does not reinstall it. After onboarding, normal service-driven LinkedIn work uses that same persistent profile in headless/background Chrome.

After that **no terminal needs to stay open**. The service starts when you sign into the computer, reconnects after network interruptions, and is restarted by the OS if the process crashes. On Linux and macOS the installer also creates `~/.local/bin/trevra`, so service controls use the installed companion version instead of whatever version `npx` currently resolves.

The background companion also **auto-updates**. On reconnect, hosted Trevra advertises the required companion version before any browser work is accepted. If a newer version exists, the service installs that exact official GitHub release and exits with a restart code so the OS starts the new version. Pairing, the local LinkedIn profile and cookies are preserved. A failed update leaves the current working version in place and records `update_failed` in `trevra linkedin logs`.

Trevra supports:

```sh
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

`logs` shows the companion's owner-only local activity log. It records service starts/stops, server reconnects, Chrome open/reuse, and browser-relay sessions/errors. It does **not** record device tokens, cookies, passwords, raw CDP/browser traffic, or LinkedIn message contents. The log rotates locally at roughly 2 MB and keeps one previous file; `logs --follow` streams new entries.

Only one active companion computer is allowed per workspace. Pairing a replacement computer atomically revokes the previous device, and the relay also allows only one live control connection at a time.

`uninstall` removes only the background service and its private npm installation. It deliberately keeps `~/.trevra/companion.json` and the dedicated LinkedIn browser profile so reinstalling does not force a new LinkedIn device/session.

`trevra linkedin` remains available as a foreground/debug mode. Normal recovery is simpler: when the headless browser reaches an expired sign-in, CAPTCHA, 2FA or device check, Trevra holds LinkedIn work and shows an alert in Outreach. Run `trevra linkedin reconnect` (or `--seat <key>` for another LinkedIn account). The background service restarts into a one-time visible recovery window using the same persistent profile. Complete the human step and close that Trevra Chrome window; the OS service immediately restarts in headless/background mode. No LinkedIn password, CAPTCHA answer or 2FA code is sent through Trevra.

## OS integration

- Linux: a `systemd --user` service enabled for login, with `Restart=on-failure`.
- macOS: a per-user LaunchAgent with `RunAtLoad` and restart after unsuccessful exits.
- Windows: a per-user Task Scheduler job triggered at interactive logon with restart-on-failure settings.

No OS service definition contains the companion bearer token. The device token remains only in `~/.trevra/companion.json`, with owner-only permissions where POSIX modes apply.

## Presence and browser boundary

The background service being alive is intentionally **not** enough to run LinkedIn work. A signed-in Trevra browser tab must also be present. If either the local companion or all Trevra tabs go offline, Trevra leaves LinkedIn work queued. When both return, Trevra runs one ordinary bounded sitting and resumes its normal schedule; it does not replay missed timer ticks as a backlog burst.

LinkedIn cookies live under `~/.trevra/linkedin-companion/` and are not uploaded to Trevra. The companion Chrome profile is dedicated to LinkedIn; Trevra can control that window while connected, so do not use it for unrelated private sites.
