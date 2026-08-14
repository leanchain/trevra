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
| 9 | `package.json`, `Dockerfile.dev`, `loadLinkedInPlaywright` | **Patchright** added as an optional dependency and preferred over stock `playwright`, with fallback. Kills the `Runtime.enable` CDP side-channel and the `__pwInitScripts` / `__playwright__binding__` globals — none of which any launch option can reach. Which driver loaded is logged once. |
| 10 | `local-worker.ts` `alignClientHints` | `Emulation.setScrollbarsHidden({hidden:false})`. Dropping `--hide-scrollbars` from the args was **not** enough — the driver hides them over CDP too, and a probe of the launched browser proved it. |
| 11 | `jobs.ts` `runLinkedInSideTasks` | Refuses before opening a browser when the seat row is missing or its effective posture is `paused`. This function runs per seat, every tick, and each of its four jobs used to open Chrome *before* reading the posture and refusing. |
| 12 | dev database | Deleted the six leaked test-fixture workspaces (`ws_li_api_a`, `ws_li_credentials_test`, `ws_linkedin_guard_test`, `ws_linkedin_leads_test`, `ws_linkedin_pacing_test`, `ws_linkedin_withdraw_test`). `linkedin_seats` is now one row: the real account. |

`npx tsc --noEmit` clean. `npm test src/server/linkedin/ src/server/app.test.ts`: **808 passed**.

## 3.1 Verified against a live browser, not just asserted

A probe launched the real patched stack with the exact options `openBrowser` now
uses, and read back what a page sees. Before/after on the same machine:

| Signal | Before | After |
|---|---|---|
| Binary | `chrome-headless-shell` | full Chromium, `--headless=new` |
| `User-Agent` | `Windows NT 10.0 … Chrome/139` | `X11; Linux x86_64 … Chrome/149.0.0.0` |
| `Sec-CH-UA-Platform` | `"Linux"` (contradicting the UA) | `"Linux"` (agreeing) |
| `Sec-CH-UA` | Chromium brand list empty | `"Not;A=Brand";v="99", "Chromium";v="149", "Google Chrome";v="149"` |
| `navigator.platform` | `Linux x86_64` (contradicting) | `Linux x86_64` (agreeing) |
| `navigator.userAgentData.platform` | `Linux` (contradicting) | `Linux` (agreeing) |
| UA vs binary version | 139 claimed / 151 real | 149 / 149 |
| `Accept-Language` | absent | `de-CH,de;q=0.9` |
| `navigator.webdriver` | — | `false` |
| `navigator.plugins` / `mimeTypes` | 0 / 0 (headless shell) | 5 / 2 |
| Scrollbar width | 0 px | 15 px |
| `pointer: fine` / `hover: hover` | — | true / true |
| Playwright globals on `window` | `__pwInitScripts`, `__playwright__binding__` | **none** |
| Viewport | 1280×720, same for every seat | 1512×856, seeded per seat |

Two defects in the first cut of this work were caught by that probe and fixed:
the hand-written `acceptLanguage` produced the malformed `de-CH,de;q=0.9;q=0.9`
(Chromium appends its own q-values), and `ignoreDefaultArgs: ['--hide-scrollbars']`
did not actually restore scrollbars without the CDP call.

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

### 5.1 Run the worker on the host, headed — the biggest signal left

The last hard fingerprint the container cannot fix is the GPU:

    webglRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)
                    (0x0000C0DE)), SwiftShader driver)"

No consumer machine reports SwiftShader. It is one of the highest-signal, hardest
to fake values in browser fingerprinting, and the only fix is a real GPU. The
codebase already prefers headed and already ships the path: `npm run
linkedin:worker` on this machine, which has `DISPLAY=:0.0` and Chromium
installed. Do that and the seat gets a real GPU string, a real window, a real
display, and the operator can watch it and clear a checkpoint by hand.

The container path stays as the fallback it was designed to be.

### 5.2 Prefer real Google Chrome over Chromium

`channel: 'chromium'` fixed the headless-shell problem. `channel: 'chrome'` would
additionally give genuine Widevine and proprietary codecs — but it needs Google
Chrome installed in the image. One Dockerfile line.

Related, still open: `window.chrome` exists but `window.chrome.runtime` is
`undefined` (confirmed by the probe). Real desktop Chrome defines it. Patchright
deliberately avoids `addInitScript`, so patching this needs its route-injection
path rather than the obvious call.

### 5.3 A real activity ledger

Write `audit_events` rows for every navigation, login attempt, checkpoint and
wall. Without it there is no way to see a flag building, which is exactly the
position this investigation started from.

### 5.4 Interleaved noise and acceptance-rate throttle

`limits.ts` already has `MIN_ACCEPTANCE_RATE = 0.3` and the guard checks it.
The *within-action* half of this is now done — see Part 6. Still missing, and
both are scheduling decisions rather than driver behaviour:

- the multi-day HeyReach-style pre-connect sequence (view today → optional like
  → invite hours or a day later), which is `sequence.ts` and `campaigns.ts`,
  not the driver;
- randomizing the daily quota to 80–100% of the ceiling rather than running to
  it. `effectiveDailyCeiling` returns the cap; nothing draws below it.

---

# Part 6 — What an action LOOKS like, second pass (same day)

Part 3 fixed the CLIENT. This fixes the BEHAVIOUR, which was still machine-shaped
everywhere except the search walk.

**New file: `src/server/linkedin/human.ts`.** Four primitives, all seeded (no
`Math.random()` anywhere), all degrading to the previous behaviour when the page
object lacks the capability — which is why none of the 858 driver tests changed.

| primitive | replaces | why it matters |
|---|---|---|
| `settle(page, seed)` | `SETTLE_MS = 1_500` in **five** driver files | Five files agreeing on a millisecond value is a timer. Now a 900–4,200 ms band, seeded per URL+step, and never the same twice in one session. |
| `readPage(page, seed)` | nothing — pages were never scrolled outside the search walk | Pointer move + 3–6 wheel passes + a scroll-back-up. Also fixes lazy-loaded rows. |
| `hoverClick(page, locator, …)` | every `locator.click()` | Playwright's click *teleports*: `mousedown` fires on a control the pointer never travelled to. Now hover → pause 120–640 ms → click. LinkedIn listens for exactly those events. |
| `typeLike(page, locator, text, …)` | `fill()` for the invite note, the DM body, the inbox reply, the OTP | `fill()` sets `value` and fires **one** `input` event: no keydown, no per-character timing, in a stream (`li/track`) that batches typing events precisely because it collects them. Now typed in 3–10 char bursts, 45–160 ms/key, one pause in eight long, then a 0.4–2.3 s reread before Send. |

**Byte-exactness is preserved.** `typeLike` appends the caller's characters and
nothing else; any mid-way failure falls back to `fill(text)`, which sets the
approved string whole. There is no path that sends a partial note.

**The newline hazard is handled explicitly.** Enter can *send* in LinkedIn's
composer, so multi-line text is typed a line at a time with `Shift+Enter`
between lines. Text containing `\r`, or a page with no keyboard, takes the
`fill` path instead.

**Credentials deliberately still use `fill`.** `driver.ts`'s standing guarantee
is that no failure path can echo a password, and `fill` is the call whose error
text has been audited for it. The sign-in gets the human *pauses* (between
fields, before submit) but not the keystrokes. The OTP box does get typed —
six digits are not a stored credential, and a code box filled in one event at a
checkpoint is the worst possible place to look like a machine.

**Sessions now start on the feed.** `openBrowser` navigates to `/feed/`, settles
and scrolls it before the caller's first `goto`. Every session used to open with
a deep link to a stranger's profile or a search URL — no feed load in front of
it, no referer. One page load per browser open, not per action.

**Profiles are read before they are acted on.** `openProfile` (invite, DM, view),
`openAt` (follow, like, endorse), the inbox rail and the sent-invites list all
run `readPage` after the load. The invite path therefore now does: land → dwell
→ scroll → hover Connect → click → dwell → hover Add note → type the note like a
person → reread → hover Send. It used to be: land → wait exactly 1.500 s → click
→ wait exactly 1.500 s → paste → click.

### 5.5 The account itself

Keep the seat `paused` 7–14 days. Sign in by hand from normal Chrome on the same
residential IP, complete the profile, then rewarm from week-1 numbers (5/day) —
treat a reinstated account as brand new, which is the one piece of advice every
source agrees on.

---

# Part 7 — The shape of a day, and a critique of Part 6

## 7.1 What shipped

**`isLoggedIn` stopped fetching a profile page on every call.** It loaded
`/in/me/` on every worker tick, every batch and every UI sign-in check —
a client that opens a *profile* every minute or two and never scrolls a feed,
never opens a thread, never clicks a link to get there. It now reads the
signed-in nav off whatever page is open (the browser opens on the feed, so the
common case navigates nowhere) and falls back to `/feed/`, never a profile.
Pre-existing since `4e81c29`; the doc comment above it always claimed it did
not navigate.

**Sittings, not shifts** (`local-worker.ts`). A session is 3–8 actions, then the
seat is away 25–90 min and **its browser is closed**. Seeded per seat and
session index.

**Days differ** (`pacing.ts` `dayShapeFor`). Seeded from the seat and the
calendar date: edges move up to 45 min *inside* the configured window (so the
gate can never refuse a slot the planner made), ~12% of working days are left
empty, and each day draws 80–100% of its ceiling instead of running to it.
`FLAT_DAY_SHAPE` is injected by the tests that assert a ceiling.

## 7.2 Five defects found by challenging Part 6

1. **The `fill` fallback in `typeLike` pasted and sent with no pause.** Every
   page object without `pressSequentially` took that branch — the loudest
   composer signal survived for exactly the callers that could not type. Fixed:
   0.9–4.3 s before it returns.
2. **`hoverClick`'s pause lived inside the hover branch.** A control that could
   not be hovered went from "found it" to `mousedown` in the same frame — the
   teleporting click the function exists to prevent. Fixed: the pause is
   unconditional.
3. **`readPage` read every page identically** — one pointer move, then 3–6
   wheel ticks, forever. Varied enough to beat a constant, uniform enough to be
   its own signature. Fixed: glance / read / long-read drawn per page, the
   pointer drifts between passes, the correcting scroll-up is not every time.
4. **A gate-refused seat re-opened the browser every tick.** `executed > 0` set
   the break, so a seat whose work was due but refused (over ceiling, outside
   hours, throttled) loaded the feed once a minute for as long as the refusal
   lasted — worse than the actions it was refusing. Fixed: `blocked > 0` rests
   it too, and every reason the gate refuses for needs hours to change.
5. **Same seed → same millisecond, forever.** Opening a profile twice drew the
   same dwell twice; a restart replayed the morning's rhythm. Fixed with a
   session salt (seat + hour) mixed into every behavioural draw. Two counter
   designs were tried and reverted first — a global one makes every draw depend
   on program order, a per-seed one breaks the determinism `listPendingInvites`
   asserts. Recorded in `human.ts` so they are not tried a third time.

## 7.3 The biggest thing still wrong

**Every target is a full document load typed into the address bar.** A person
on LinkedIn clicks a link and the SPA routes client-side — no document load,
a `pageInstance` chain, a referer. Trevra `goto`s `/in/<handle>/` cold for
every action. Feed-first and scrolling narrow the gap; they do not close it.
The real fix is to reach profiles by clicking the search-result card that
already exists in the walk, which is a change to how a target is *addressed*,
not to how it is browsed. Nothing else on this list is close to it in size.

Unchanged and still #1 overall: the container reports `SwiftShader` as its
WebGL renderer. Run the worker headed on the host.

---

# Part 8 — Closing the list

**A link, not the address bar** (`driver.ts` `followLinkTo`). If the page the
browser is already on shows a link to the target — a search result, a feed
card, a connections row, an inbox thread's participant — the driver hovers and
clicks it and lets LinkedIn's SPA route: no document load, a referer, a view
chain. `page.goto` is now the fallback, and it is still what happens for a
target reached cold from a stored lead list. Honest limit: a cold list is the
common case for a campaign, so this fires on the inbox and search paths far
more often than on the invite path. Closing that properly means addressing
targets *from the page that found them*, which is a change to the campaign
model, not to the driver. `driver.test.ts` is new and covers all three
branches — the first page-level test the action driver has ever had.

**Noise** (`warmUpSession`). About 55% of sittings open My Network,
notifications or the feed again — the member's own surfaces, so nothing here
touches another member's profile or consumes a ceiling — and scroll them before
the sitting does what it came for. An account that only ever does outreach is a
robot with a job.

**The GPU is now said out loud.** Running headless in a container logs, once per
process, that WebGL reports SwiftShader and that only a real display fixes it.
It was true before and buried in this document; now it is on the operator's
screen at the moment it starts mattering.

Suite after all of Parts 6-8: **915 passing, `tsc` clean.**

---

# Part 9 — The rest of the list

| # | Item | State |
|---|---|---|
| 1 | **Event ledger** — `linkedin_seat_events` (migration 061) | done. Browser opens, sittings, sign-ins, session reuse, challenges and detects are recorded, with 45-day retention swept once a tick. This is what was missing when the flag arrived: the timeline had to be rebuilt from Chrome's history DB and cookie timestamps because Trevra recorded only *actions*. |
| 2 | **Breaks survive a restart** — `linkedin_seats.resting_until` | done. Was an in-process Map, forgotten exactly when a restart was most likely: right after something went wrong. Both are consulted; the later wins. |
| 3 | **The gate enforces the day shape** | done. Rest days, the 80–100% draw and the moved window edges bound only the *planner*, so a manual send, an ad-hoc API call or a reply bypassed all three. `LinkedInSafetyOptions.dayShape` puts it on the one path every route goes through. |
| 4 | **Google Chrome preferred over Chromium** | done. `BROWSER_CHANNELS = ['chrome', 'chromium']`, silent fallback when Chrome is absent; `Dockerfile.dev` installs it. Chromium's `window.chrome` has no `runtime` — a one-line headless check — and no Widevine or proprietary codecs. |
| 5 | **`readSeat` stops loading the connections list** | done. It loaded `/mynetwork/invite-connect/connections/` on *every* detect for one number that moves by a handful a week. Skipped when the stored count is under a week old; the read returns null and the stored number is left alone. |
| 6 | **Tests for the primitives** | done. `human.test.ts` (17) covers typing, hover, scroll variety, the salt, and both defects the review found; `guard.test.ts` gains three for the enforced day shape; `local-worker.test.ts` gains the sitting budget and break. `resetLinkedInSessionRhythm()` exists because sittings are process state and the tests share a process. |
| 7 | **Leaked fixture profiles** | done. Six removed from the container. `/root/.trevra/linkedin-profile` is the dead pre-fix mount and cannot be removed while the current container holds it; it goes on the next `--force-recreate`. |

**The last cold load is gone too.** `LocalWorkerStore.sourcePageFor` looks up
the page a lead was harvested from (`linkedin_leads` → `linkedin_lead_sources`),
and the sitting opens it once, reads it, and clicks each person's card from
there — so `followLinkTo` finally has a page with links on it. The arithmetic is
better than it first looks: **one** list load per sitting replaces **N** cold
profile loads, and every action after the first is a client-side route rather
than a document load. Guarded to `linkedin.com` over https, skipped when the
browser is already there, and swallowed on any failure — an unopenable source
page just means the driver navigates the way it always did. A target nobody
sourced (manual add, import, reply) returns null and is unchanged.

**Unchanged:** the container's WebGL renderer. Run the worker headed on the host.

Suite: **944 passing across 33 files**, `tsc` clean.

---

# Part 10 — The thing that was actually doing it

Everything in Parts 6–9 made the *actions* look human. None of it touched the
reason the flag arrived, because the flag did not come from actions. Trevra sent
nothing between 2026-08-10 and 2026-08-15 and the account was restricted anyway.

## 10.1 Six page loads a minute, forever

`runLinkedInSideTasks` runs once per worker tick — `AUTOMATION_INTERVAL_MS`,
**60 seconds** — and ran all five of its jobs on every tick, unconditionally.
Not one of them asked when it last ran. For one seat, with an empty inbox, an
empty queue and nothing scheduled, a single tick was:

| Navigation | Why |
|---|---|
| `/in/me/` | `confirmSeatAccount`, from the inbox sync |
| `/mynetwork/invite-connect/connections/` | `readSeat` loads it by default |
| `/messaging/` | the conversation rail |
| `/mynetwork/invitation-manager/sent/` | the pending-invite list |
| `/in/me/` | `confirmSeatAccount` **again**, from acceptance detection |
| `/mynetwork/invite-connect/connections/` | and again |

Six navigations × 1,440 ticks = **~8,600 page loads per day**, round the clock,
including 03:00. ~2,900 of them the connections page — the single surface
LinkedIn most associates with prospecting — and ~2,900 more the profile page.

Under the code the restricted account actually ran it was worse: `isLoggedIn`
navigated to `/in/me/` on *every* call (fixed in `098c13d`), adding one profile
load per job per tick — about **11 navigations a tick, ~15,800 a day**.

That is precisely "accessing an unusually large amount of LinkedIn profile data
over time", and it was Trevra, unprompted, with nothing queued and nothing sent.

## 10.2 What changed

| Fix | Effect |
|---|---|
| `confirmSeatAccount` passes `skipConnections: true` | It only ever read `profileUrl`. Removes the connections page from the tick entirely — ~2,900 loads/day → 0. |
| One session and one identity check per pass | Each job called `openLinkedInSession` itself and two confirmed the account themselves. The page is now threaded down; a job handed a page opens no browser and re-asks nothing. `/in/me/` goes from 2 per tick to 1 per *pass*. |
| **The visit model** (`linkedin_side_task_runs`, migration 071) | See 10.3. This is the one that matters. |
| Break gate | `resting_until` now stops the reads too. A client that stops sending but keeps polling its inbox through a 25–90 minute break has not gone anywhere. |

## 10.3 A visit, not an interval

The first attempt at this was a per-task interval — inbox every 22–55 minutes,
acceptance every 5–9 hours, and so on. That was **still a polling loop**. It
just polled more slowly, and it produced a perfectly flat access graph that no
human has ever generated: ~15 inbox reads a day, evenly spaced, forever.

What a person actually does — the operator's own description — is open LinkedIn
**2–5 times a day for a few minutes**, glance at the feed, look at messages,
click something, and leave. So that is what the model is now:

| | |
|---|---|
| **Visits** | 2–5 per working day, drawn per seat per date. One slot per visit, start jittered inside the first 60% of its slot — which spreads them and guarantees ~48 minutes between consecutive visits. A clump after a long silence is a worse signal than a flat line. |
| **Length** | 2–5 minutes. Outside a visit the tick costs two SQL reads and stops. |
| **Arrival** | The feed, via the same `warmUpSession` the sending sittings use — plus notifications or My Network about half the time. A person lands on the feed, not on `/mynetwork/invitation-manager/sent/`. |
| **Work** | At most **two** of the five jobs per visit, most-overdue first. Three minutes is not enough to walk an inbox, reconcile a sent list, open profiles, drain a queue *and* harvest a source — and an account that appears to is a batch job. |
| **One pass per visit** | A visit spans 2–5 ticks. Without a marker the second tick finds the first tick's jobs freshly stamped, picks the next two, warms up again and reloads `/in/me/` — and the cap of two per visit silently becomes two per *minute*. The visit's start instant is stamped **before** the browser opens, so a visit that dies half way through is a visit that happened. |
| **Departure** | `about:blank`. A tab parked on `/messaging/` holds a realtime connection and reports the member present 22 hours a day with four minutes of activity — a stranger shape than the polling it replaced. |
| **Day shape** | Visits are drawn inside the seat's own drawn window from the same `dayShapeFor` the sender uses, and there are none on a rest day. The reads and the sends are one presence, not two actors sharing a cookie. |

## 10.4 Measured, not asserted

`scripts/linkedin-side-task-load.ts` replays a week of 60-second ticks through
the real functions:

```
One idle seat, 7 days of 60s ticks, Mon-Fri 08:00-18:00 UTC

  visits scheduled             : 16  (3.2 per working day)
  visits that did any work     : 16
  minutes with LinkedIn open   : 47  (9.4 per working day)
  /in/me/ identity loads       : 16
  connections-page loads       : 0
  TOTAL navigations            : 58  (8.3/day)

  before this change           : 60480 navigations (8640/day)
  reduction                    : 99.90%
```

**8,640 → 8.3 navigations a day**, in three short bursts instead of 1,440
identical ones, none at 03:00, none on the connections page.

## 10.5 What it does not change

Nothing about what is *sent*. Every ceiling, gate, posture and warm-up rule is
untouched — this is only about how often the browser goes and looks.
