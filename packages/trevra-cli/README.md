# trevra

The official Trevra companion CLI.

For hosted LinkedIn execution, Trevra keeps campaigns, pacing and safety rules in the hosted platform while Chrome runs on your own computer. LinkedIn traffic therefore uses your computer's normal network/IP, and the persistent LinkedIn browser profile stays on your computer.

## Use

In Trevra, open **Outreach → LinkedIn accounts → Connect this computer** and copy the generated command. It looks like:

```sh
npx trevra linkedin --pair XXXX-XXXX-XXXX --url https://app.usetrevra.com
```

After pairing once, future runs are simply:

```sh
npx trevra linkedin
```

Keep the command and a signed-in Trevra tab open. If either goes offline, Trevra leaves LinkedIn work queued. When both return, Trevra runs one ordinary bounded sitting and resumes its normal schedule; it does not replay missed timer ticks as a backlog burst.

The device token is stored at `~/.trevra/companion.json` with owner-only permissions. LinkedIn cookies live under `~/.trevra/linkedin-companion/` and are not uploaded to Trevra. The companion Chrome profile is dedicated to LinkedIn; Trevra can control that window while connected, so do not use it for unrelated private sites.
