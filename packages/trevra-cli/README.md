# trevra

The official Trevra companion CLI.

For hosted LinkedIn execution, Trevra keeps campaigns, pacing and safety rules in the hosted platform while Chrome runs on your own computer. LinkedIn traffic therefore uses your computer's normal network/IP, and the persistent LinkedIn browser profile stays on your computer.

## Install once

In Trevra, open **Outreach → LinkedIn accounts → Connect this computer** and copy the generated command. It looks like:

```sh
npx trevra linkedin install --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com
```

The command pairs the computer, installs the exact Trevra companion version into a private per-user directory, registers an OS background service, opens the dedicated LinkedIn Chrome profile for first sign-in, and starts the service.

After that **no terminal needs to stay open**. The service starts when you sign into the computer, reconnects after network interruptions, and is restarted by the OS if the process crashes.

Trevra supports:

```sh
npx trevra linkedin status
npx trevra linkedin logs
npx trevra linkedin logs --follow
npx trevra linkedin start
npx trevra linkedin stop
npx trevra linkedin restart
npx trevra linkedin uninstall
```

`logs` shows the companion's owner-only local activity log. It records service starts/stops, server reconnects, Chrome open/reuse, and browser-relay sessions/errors. It does **not** record device tokens, cookies, passwords, raw CDP/browser traffic, or LinkedIn message contents. The log rotates locally at roughly 2 MB and keeps one previous file; `logs --follow` streams new entries.

Only one active companion computer is allowed per workspace. Pairing a replacement computer atomically revokes the previous device, and the relay also allows only one live control connection at a time.

`uninstall` removes only the background service and its private npm installation. It deliberately keeps `~/.trevra/companion.json` and the dedicated LinkedIn browser profile so reinstalling does not force a new LinkedIn device/session.

`npx trevra linkedin` remains available as a foreground/debug mode.

## OS integration

- Linux: a `systemd --user` service enabled for login, with `Restart=on-failure`.
- macOS: a per-user LaunchAgent with `RunAtLoad` and restart after unsuccessful exits.
- Windows: a per-user Task Scheduler job triggered at interactive logon with restart-on-failure settings.

No OS service definition contains the companion bearer token. The device token remains only in `~/.trevra/companion.json`, with owner-only permissions where POSIX modes apply.

## Presence and browser boundary

The background service being alive is intentionally **not** enough to run LinkedIn work. A signed-in Trevra browser tab must also be present. If either the local companion or all Trevra tabs go offline, Trevra leaves LinkedIn work queued. When both return, Trevra runs one ordinary bounded sitting and resumes its normal schedule; it does not replay missed timer ticks as a backlog burst.

LinkedIn cookies live under `~/.trevra/linkedin-companion/` and are not uploaded to Trevra. The companion Chrome profile is dedicated to LinkedIn; Trevra can control that window while connected, so do not use it for unrelated private sites.
