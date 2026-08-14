# LinkedIn "unusual activity" — investigation, fixes, and hardening plan

2026-08-14. Workspace `ws_83ec3c45b0354615` (seat `owner`, tz Europe/Zurich,
auth_mode `manual`, posture **paused**). DB: `trevra-dev-postgres-1` / `trevra`.

---

# Part 1 — What actually happened

## 1.1 How much did Trevra do?

**Almost nothing. Volume is not the cause.**

`linkedin_actions`, every outbound action Trevra records:

| workspace | kind | status | n |
|---|---|---|---|
| ws_li_api_a | invite | sent/accepted/declined | 3 |
| ws_linkedin_actions_test | invite | planned | 1 |
| ws_linkedin_guard_test | invite | accepted | 1 |
| ws_linkedin_pacing_test | invite | sent | 18 |

All 23 rows are **test-suite fixtures** (frozen clocks: `2026-08-05 03:00:00`,
`2026-08-06 08:00/09:00`). `ws_83ec3c45b0354615` has **zero rows**.

- invites sent for real: **0**
- DMs sent: **0**
- **profile views: 0** — `profile_view` has never been written for any workspace
- follows / likes / endorses: **0**

`linkedin_lead_sources`, the only real traffic:

| requested_at (UTC) | finished_at | kind | result | note |
|---|---|---|---|---|
| 2026-08-05 15:49:03 | 16:10:55 | search | 98 leads | ~10 page loads over 22 min |
| 2026-08-05 18:32:51 | 18:32:59 | search | **0 leads, 8 s** | same URL as above |

`linkedin_leads`: 98 rows, all `2026-08-05`. Nothing since.

**Total real LinkedIn footprint: ~11 search-result page loads on Aug 5, plus
sign-ins.** The 18:32 run — identical URL, 0 cards, done in 8 seconds — is
LinkedIn already serving a restricted or empty search. The account was flagged
on Aug 5, before Trevra had sent a single invite.

Only other trace: `linkedin_seats.detected_at = 2026-08-13 10:49:25`,
`session_valid_at = 2026-08-13 13:50:03` → two sign-ins on Aug 13.

## 1.2 Where it is recorded

- `linkedin_actions` — one row per outbound action
- `linkedin_lead_sources` — one row per scrape run (url, status, result_count, failure_reason)
- `linkedin_leads` / `linkedin_lead_contacts` — harvested rows
- `linkedin_seats.detected_at` / `session_valid_at` — last successful sign-in
- `audit_events` — **no LinkedIn rows at all**

**Gap:** nothing records page navigations or login *attempts*. A scrape that
walks 10 pages writes one row; a login loop that re-authenticates 40 times writes
nothing. There was no ledger that could have shown the flag building.

## 1.3 The verdict

LinkedIn did not flag rate — Trevra sent nothing. It flagged **the client**: a
headless-shell browser whose user agent contradicted its own Client Hints on
every request, driven with no pointer or scroll telemetry, signing into the
account from a browser profile that was destroyed on every container rebuild.

The exit IP is **not** part of the problem: `188.154.121.34`, Sunrise GmbH,
Switzerland — residential, matching the seat's Europe/Zurich timezone, no proxy.
That is the single hardest thing for a competitor to buy, and it is already right.

---

# Part 2 — Root causes, ranked

### 2.1 The binary was `chrome-headless-shell`, not Chrome — loudest signal

Live process at the time of investigation:
`/root/.cache/ms-playwright/chromium_headless_shell-1234/…/chrome-headless-shell`.
Chrome 132 removed old-headless from the main binary; it now exists only as this
separate product ([Chrome for Developers](https://developer.chrome.com/blog/removing-headless-old-from-chrome)).
It ships without the PDF viewer, with an empty `navigator.plugins`/`mimeTypes`,
with a sparse `window.chrome`, with SwiftShader as the WebGL renderer, and
without Widevine — every one of them a documented detection check
([Castle](https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/),
[cside](https://cside.com/blog/headless-browser-detection)).

Playwright also passes `--hide-scrollbars` by default, which zeroes scrollbar
width — measurable in one line ([puppeteer#4747](https://github.com/puppeteer/puppeteer/issues/4747)).

> **Correction to the first draft of this document.** I initially read
> Playwright's `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`
> as "claims to be a touch device." That is wrong: in Blink's enums `HoverType=2`
> is *hover available* and `PointerType=4` is *fine pointer*, i.e. Playwright is
> forcing correct **desktop** behaviour. Not a defect. Independent research could
> not corroborate the touch-device reading either.

### 2.2 UA said Windows, Client Hints said Linux

`seatContextFingerprint` handed Playwright e.g.
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/139.0.0.0`. Playwright's
`userAgent` context option rewrites **only the UA string**; nothing in
`src/server/linkedin/**` set `extraHTTPHeaders`, `addInitScript` or any
Client-Hint override. So every request carried:

- `Sec-CH-UA-Platform: "Linux"`, `navigator.userAgentData.platform === 'Linux'`
- `navigator.platform === 'Linux x86_64'`
- `User-Agent: … Windows NT 10.0 …`

This is a known Playwright trap: its internal `calculateUserAgentMetadata()`
hardcodes `architecture: 'x64'` and `platform: 'Windows'` regardless of the UA
you pass ([playwright#36184](https://github.com/microsoft/playwright/issues/36184)),
and `navigator.userAgentData.brands` comes back empty
([playwright#14361](https://github.com/microsoft/playwright/issues/14361)).

On top of that, the UA claimed Chrome **138/139** while the installed binary is
**151.0.7922.34** — a 12-major skew.

### 2.3 The real seat's browser profile was not persisted

`compose.dev.yml` mounted `trevra-linkedin-profile:/root/.trevra/linkedin-profile`,
but `resolveProfileDir` returns `/root/.trevra/linkedin-<workspace>-profile`
(migration 045, multi-seat). Inside the container:

    362M  /root/.trevra/linkedin-profile                      <- the volume, untouched since Aug 5 15:54
     16M  /root/.trevra/linkedin-ws_83ec3c45b0354615-profile  <- live seat, EPHEMERAL container layer

The compose file never followed the code. The real account's cookies, `li_at`,
`bcookie` device id and "remember this browser" standing lived on the writable
container layer — **every rebuild was a brand-new device signing into the same
account**. That is precisely the input to LinkedIn's published login-risk model,
which scores source IP, geolocation, browser/OS configuration and time-of-day per
login and steps up verification on outliers — 89% recall at 10% FPR
([LinkedIn Engineering, *Who Are You?*](https://engineering.linkedin.com/blog/2016/01/who-are-you--a-statistical-approach-to-protecting-linkedin-login)).

### 2.4 No viewport in headless

`viewport: null` was applied only when headed, so every headless session was
Playwright's 1280×720 — an automation default, and identical for every seat.

### 2.5 Zero human motion during the scrape

`walkResultList` navigated `?page=N` directly, waited a **fixed 1500 ms**, then
read every card by selector. No scroll, no mouse, no hover, no lazy-load, no
variable dwell, no click-through from the previous page.

LinkedIn's telemetry sink `li/track` batches mouse, click and typing events; a
session producing none is an outlier in a stream it already scores
([Linked Helper reverse-engineering study, 2026](https://www.linkedhelper.com/blog/linkedin-automation-security-study/)).
LinkedIn has published that it runs sequence models over raw member-activity
streams, and that its **first production use case was logged-in profile-scraping
detection** ([LinkedIn Engineering](https://www.linkedin.com/blog/engineering/trust-and-safety/using-deep-learning-to-detect-abusive-sequences-of-member-activi)).

### 2.6 Seven leaked browsers, six of them for test-fixture accounts

Seven `chrome-headless-shell` instances were alive, one per row in
`linkedin_seats` — six of which are test fixtures that leaked into the dev DB
(`ws_li_api_a`, `ws_li_credentials_test`, `ws_linkedin_guard_test`,
`ws_linkedin_leads_test`, `ws_linkedin_pacing_test`, `ws_linkedin_withdraw_test`).
They sit on `about:blank`, so no LinkedIn traffic — but they are never closed and
they write real profile dirs under `/root/.trevra`.

---

# Part 3 — What was changed

| # | File | Change |
|---|---|---|
| 1 | `compose.dev.yml` | Mount `trevra-browser-profiles:/root/.trevra` (the whole base) instead of the dead `linkedin-profile` path. Every seat's session and device trust now survives a rebuild; the Reddit profile rides along. |
| 2 | `local-worker.ts` `openBrowser` | `channel: 'chromium'` → the full Chromium build running `--headless=new`, never `chrome-headless-shell`. |
| 3 | `local-worker.ts` `openBrowser` | `ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars']`. |
| 4 | `local-worker.ts` `openBrowser` | Explicit per-seat desktop `viewport` in headless (was Playwright's 1280×720). |
| 5 | `local-worker.ts` `SEAT_USER_AGENTS` | Deleted. One Linux template built from the real Chrome major, because the host IS Linux. Per-seat variation now comes from locale, timezone, cookie jar and (optional) proxy — none of which lie about the machine. |
| 6 | `local-worker.ts` `alignClientHints` | New. After launch and before any navigation, reads `Browser.getVersion` over CDP and issues `Emulation.setUserAgentOverride` with a full `userAgentMetadata` block, so UA, `Sec-CH-UA`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Full-Version-List`, `navigator.userAgentData` and `navigator.platform` all agree, on the binary's real version. Degrades silently on a context with no CDP (every test fake). |
| 7 | `driver-scrape.ts` `settleMs` | Fixed 1500 ms post-load dwell replaced with a seeded 900–4200 ms draw, at all six call sites. |
| 8 | `driver-scrape.ts` `browseList` | New. Seeded mouse move + 3–6 wheel scrolls with jittered pauses + one corrective scroll back up, before cards are read. Applied to search walks, content search and post opens. Optional on the page object, so test fakes are unaffected. |

`npx tsc --noEmit` clean. `local-worker.test.ts` + `driver-scrape.test.ts`: 83 passed.

## 3.1 Required operator step — do this before recreating the container

The volume remount will replace the container's ephemeral `/root/.trevra`. Save
the existing profiles first or the seat signs in as a new device one last time:

```bash
docker cp trevra-dev-trevra-1:/root/.trevra /tmp/trevra-profiles
docker compose -f compose.dev.yml up -d --force-recreate trevra
docker cp /tmp/trevra-profiles/. trevra-dev-trevra-1:/root/.trevra
```

---

# Part 4 — Everything that can trigger a restriction

Sourced from LinkedIn's own help centre and engineering blog where possible;
community numbers are marked. **🔵 = LinkedIn-official. ⚪ = vendor/community folklore.**

## 4.1 The restriction states

| State | Trigger | Clears |
|---|---|---|
| Automated-activity restriction 🔵 | Detected bot/extension/scraper | Auto at the time in the notice; repeats escalate to permanent ([help](https://www.linkedin.com/help/linkedin/answer/a1340567)) |
| Invitation restriction 🔵 | Many invites fast, many ignored/pending/spam-marked, or suspected automation | First: hours. Several in a day: days. Outstanding-invite restriction: **up to 1 month**. Most clear within a week ([help](https://www.linkedin.com/help/linkedin/answer/a551012/types-of-restrictions-for-sending-invitations)) |
| Commercial Use Limit 🔵 (threshold ⚪) | Search/browse volume, free tier | 1st of the month. ⚪ ~250–350 searches/mo |
| Content/identity restriction 🔵 | Profile content policy | Persona ID verification, hours to days ([help](https://www.linkedin.com/help/linkedin/answer/a1342692)) |
| ATO / compromise lock 🔵 | LinkedIn believes the account was taken over | Step-up auth |
| Permanent ban 🔵 | Repeat automation suspensions, fraud | Appeal only |

## 4.2 Hard limits

| Limit | Value | |
|---|---|---|
| Weekly connection invites | ~100/week (cut from ~700 in 2021) | ⚪ universal, never officially published |
| Max 1st-degree connections | 30,000 | 🔵 |
| Re-invite after withdrawal | locked ~3 weeks | 🔵 |
| Sales Navigator InMail | 50/mo, accrues to 150 | 🔵-adjacent |
| Skill endorsements given | 150 / 24h | 🔵-adjacent |
| Profile views/day | Premium ~150, Sales Nav ~600–800, Recruiter Lite ~2,000 | existence 🔵, numbers ⚪ |
| Acceptance-rate floor | ~30% before limits tighten | ⚪ |

LinkedIn's pattern: it confirms a limit *exists* and never states the number.

## 4.3 Non-volume triggers

1. **New device / new location sign-in.** The published login model scores IP,
   geolocation, browser/OS config and time-of-day per login. This is the one
   Trevra was hitting every rebuild.
2. **Cookie replay from a second IP.** Two live sessions on two IPs with no entry
   in LinkedIn's own "active sessions" UI. Rated a guaranteed tell — and the
   reason fresh login beats `li_at` replay. Trevra already logs in properly.
3. **Datacenter ASN.** Independent IP testing of 7 cloud vendors found Skylead
   and We-Connect accounts on shared, fraud-scored datacenter IPs despite
   "dedicated residential IP" marketing ([study](https://www.linkedhelper.com/blog/linkedin-automation-security-study/)).
4. **Client-side fingerprint.** LinkedIn runs an Active Extension Detection scan
   (~4,934 known extension IDs probed by silent `chrome-extension://` fetches),
   a DOM "Spectroscopy" scan for the literal `chrome-extension://` substring, and
   an encrypted 48-signal **APFC/DNA** device fingerprint (canvas, WebGL, audio,
   fonts, WebRTC local IP, automation flags) attached to Voyager requests. Plus a
   HUMAN Security script from `li.protechts.net` that checks for patched
   prototypes and modified `toString()` output.
5. **Behavioural stream.** `li/track` batches ≤29 mouse/click/typing events per
   POST. Bursts ("slide and spike", >3× your own 7-day baseline) matter more than
   absolute counts.
6. **Request shape.** An enrichment call after every profile view with no matching
   UI action is detectable server-side regardless of how clean the client is.
7. **Account age / completeness.** ⚪ <3-month accounts capped nearer 50–80
   invites/week. LinkedIn does officially recommend a complete profile + photo as
   mitigation 🔵.

LinkedIn's published defences: fake-account ML at registration
([2018](https://engineering.linkedin.com/blog/2018/09/automated-fake-account-detection-at-linkedin)),
real-time abuse scoring at >4M transactions/sec with >5B transient velocity
counters keyed on user ID and IP
([2018](https://www.linkedin.com/blog/engineering/trust-and-safety/defending-against-abuse-at-linkedins-scale)),
Isolation Forest for label-scarce abuse
([open-sourced](https://www.linkedin.com/blog/engineering/data-management/isolation-forest)),
and the activity-sequence deep-learning model above. *There is no publicly
documented LinkedIn system called "Ares"* — that name appears to be folklore.

## 4.4 What the industry does — and where Trevra already wins

Consensus safe limits for a warmed account (median of Expandi, HeyReach, Dripify,
Waalaxy, Lemlist, Dux-Soup, Octopus, We-Connect, PhantomBuster defaults):

| Action | Daily | Weekly | wk1 | wk2 | wk3 | wk4 |
|---|---|---|---|---|---|---|
| Connection requests | 15–25 | ~100 | 5/d | 8–11/d | 15–20/d | 20–25/d |
| Messages (1st-degree) | 50–100 | — | 2–3/d | 5–10/d | 15–20/d | 25–35/d |
| Profile visits | 80–150 | — | 10–20/d | 20–40/d | 40–70/d | 70–100/d |
| Follows / likes | 40–80 | — | ramps with the above | | | |
| **Total actions/day** | 150–250 | — | | | | |

Behavioural rulebook everyone implements: jitter every delay (15–20% is the
typical band; Waalaxy uses ±20% on a 1–2.5 min base); gate to working hours in the
account's timezone; throttle or skip weekends; randomize the *daily quota itself*
(Waalaxy draws 80–100% of the configured max); never burst one action type —
interleave a profile view and an optional like before a connect (HeyReach's
prescribed noise sequence); forced micro-pauses (Dux-Soup: 5 min every 20 visits,
random 25–125 profiles/hr); withdraw stale invites; hard-stop on a checkpoint.

**What Trevra gets for free that cloud vendors pay for and often get wrong:** a
real residential IP with real ISP history matching the account's login history;
no `chrome-extension://` footprint at all (not an extension, so AED and
Spectroscopy find nothing); no cookie-replay two-sessions tell, because the
browser *is* the session; LinkedIn's own "active sessions" list stays accurate.

**What it still has to earn:** the CDP-level automation tells (§5.1), synthesized
pointer/scroll/typing realism (now partly done), interleaved noise actions,
acceptance-rate auto-throttle, and per-seat isolation if a second account ever runs.

---

# Part 5 — Remaining work, in priority order

### 5.1 The `Runtime.enable` CDP leak — biggest single remaining signal

Playwright calls `Runtime.enable` to get execution-context ids. That makes
Chromium emit `Runtime.consoleAPICalled`, and because V8 formats `Error.stack`
lazily, a page detects an attached CDP client in five lines. DataDome published
the technique and states it is used by all major anti-bot vendors
([DataDome](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)).
Vanilla Playwright also injects `window.__pwInitScripts` and
`window.__playwright__binding__` on every page ([Castle](https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/)).

**None of this is fixable with launch options.** The fix is a patched driver:
[`rebrowser-playwright`](https://github.com/rebrowser/rebrowser-patches) (drop-in,
disables automatic `Runtime.enable`, uses isolated worlds) or
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (more aggressive:
also kills the Console API and injects init scripts via network routes).
**This is a production dependency swap and needs a decision.**

### 5.2 Prefer real Google Chrome over Chromium

`channel: 'chromium'` fixed the headless-shell problem. `channel: 'chrome'` would
additionally give genuine Widevine, proprietary codecs and a real GPU WebGL vendor
string instead of SwiftShader — but it needs Google Chrome installed in the image.
One Dockerfile line; worth doing.

### 5.3 Never open a browser for a seat that has no work

Six test-fixture seats in the dev DB each got a real Chromium. Two things: purge
the fixture workspaces from the dev database (**destructive — needs your
confirmation**), and refuse to open a browser for a `paused` seat or one with no
due work and no pending detect request.

### 5.4 A real activity ledger

Write `audit_events` rows for every navigation, login attempt, checkpoint and
wall. Without it there is no way to see a flag building, which is exactly the
position this investigation started from.

### 5.5 Interleaved noise and acceptance-rate throttle

`limits.ts` already has `MIN_ACCEPTANCE_RATE = 0.3` and the guard checks it. Still
missing: the HeyReach-style pre-connect sequence (view → dwell → optional like →
hours of delay → invite), and randomizing the daily quota to 80–100% of the
ceiling rather than running to it.

### 5.6 The account itself

Keep the seat `paused` 7–14 days. Sign in by hand from normal Chrome on the same
residential IP, complete the profile, then rewarm from week-1 numbers (5/day) —
treat a reinstated account as brand new, which is the one piece of advice every
source agrees on.
