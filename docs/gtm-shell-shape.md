# The GTM shell: one loop, end to end

Implementation plan for the app shell. Written to be executed without reading the
conversation that produced it. Every claim carries a `file:line`.

The premise, from the founder, overrides any reading of the invoicing surface as
legacy: **the AR surface is the paid end of one loop, not a second product.** The
LinkedIn engine is the product; it is also the unpaid end of the same loop. The
shell's job is to make that one loop legible. This is not a visual redesign. The
incumbent world — `--green: #1f6f4a` (`src/client/styles.css:1-18`), the calm light
app, and the LinkedIn area's typed-confidence system — is preserved. The LinkedIn
area is the reference standard the rest of the shell is raised to, never the
reverse.

---

## 1. The loop, in the product's own language

The vocabulary already exists in `docs/founder-skills.md` §2, which names fourteen
skills as one repertoire: Source, Enrich, Score, Audit, Draft, Send, Reply,
Ladder, Guard, Position, Publish, Measure, Close, Collect. Six stages a founder
reads, mapped to that list and to the screen that owns each today.

| # | Stage | The skills under it | Screen that owns it today |
|---|---|---|---|
| 1 | **Find** — who is worth talking to | Source, Enrich, Score | Partial. Paste box + `POST /api/linkedin/targets/import` (`src/server/app.ts:1855`), driven from `LinkedInCampaignsScreen` (`src/client/LinkedInCampaigns.tsx:260`). Real lead sourcing exists server-side (`src/server/linkedin/leads.ts:326` `listLeads`, `migrations/030_linkedin_lead_sources.sql`) with **no HTTP route and no screen**. |
| 2 | **Reach** — what goes out, at what pace | Draft, Send, Guard | `LinkedInScreen` (`src/client/LinkedInScreen.tsx:110`), tabs `setup`/`safety`/`campaigns`/`plan`/`queue` (`:74`). The best-designed area in the codebase. |
| 3 | **Answer** — who wrote back | Reply | **none.** `migrations/031_linkedin_inbox.sql` creates `linkedin_threads`; `src/server/linkedin/inbox.ts` and `driver-inbox.ts` exist. No route in `src/server/app.ts`, no function in `src/client/api.ts`. The migration header states the stake: *"a reply is the only outcome in the whole funnel a human has to respond to… Reply detection is what turns the ledger from a send log into a funnel."* |
| 4 | **Deliver** — what was agreed and done | Ladder, Close | `ClientsView` (`src/client/App.tsx:2219`) and the Scope Ledger importer inside `IntegrationsView` (`src/client/App.tsx:2235`). |
| 5 | **Bill** — delivered, not yet invoiced | Collect | `unbilled_milestone` → `'Ready to invoice'` (`src/client/App.tsx:148`); the tile at `src/client/App.tsx:588`. |
| 6 | **Get paid** — and what didn't, and why | Collect | `overdue_invoice` → `'Payment collection'`, `stale_proposal` → `'Proposal follow-up'`, `scope_creep` → `'Scope protection'` (`src/client/App.tsx:146-149`); `revenueAtRisk` / `revenueCollected` (`src/shared/types.ts:54,56`). |

Cross-cutting, and each already half-built:

- **Evidence** — the run ledger. `agent_runs` + `agent_run_steps` (`migrations/017_agent_runs.sql:26,52`), `playbook_runs`, `skill_runs`. Rendered only by `RunInspector` (`src/client/App.tsx:1927`), reachable only from inside Activity. The landing page sells it as a headline (`src/client/MarketingScreen.tsx:291` "Complete run ledger") and the app never names it.
- **Guard** — the limits. `AutopilotView` (`src/client/App.tsx:2478`) for policy; `LinkedInSafetyScreen` (`src/client/LinkedInSafety.tsx:32`) for pacing. Two languages for one idea.
- **Cost** — `workspace_agent_budget` and `agent_model_calls` (`migrations/016_agent_budget.sql:10,28`), `usage_reported` (`migrations/020_agent_usage_reported.sql`). Surfaced only as a bar inside Setup (`src/client/App.tsx:1326-1329`).

**The design failure to fix is not that stage 6 exists. It is that nothing on
screen says stages 1 and 6 are the same loop.** Today `type View` (`src/client/App.tsx:127`)
has four members and none of them is the loop.

---

## 2. Navigation and hash routes

A sibling is adding `location.hash` routing and a `.mobile-tabbar` right now. These
are the routes that work implies.

### Primary nav — five items

`src/client/App.tsx:278-281` renders four `NavButton`s: Approvals, Activity,
LinkedIn, Setup. Replace with:

| Label | Hash | The one question it answers |
|---|---|---|
| **Loop** | `/loop` | What is the loop doing, and where is it stuck? |
| **Outreach** | `/outreach` | What goes out, at what pace, and is the seat safe? |
| **Money** | `/money` | What was agreed, delivered, billed and paid — and what wasn't, and why? |
| **Ledger** | `/ledger` | What did the agent actually do, with the evidence — and can I take it with me? |
| **Setup** | `/setup` | What can reach my workspace, what may it spend, what may it do? |

`Loop` is the default (`useState<View>('approvals')` at `src/client/App.tsx:166`
becomes the `/loop` route). The `StopBar` (§3.6) is shell chrome on every route
and is never a nav item.

This contradicts `docs/app-spec.md` §4 ("**Three nav items.** Not six."). That
table predates the LinkedIn engine and already lost the argument at
`src/client/App.tsx:280`. Update §4 in the same PR — see open question 1.

### Outreach sub-routes — the seven tabs, resolved

`src/client/LinkedInScreen.tsx:74` declares `type Tab = 'setup' | 'safety' |
'campaigns' | 'plan' | 'queue' | 'analytics' | 'exclusions'`. Seven becomes five,
two move out.

| Today's tab | Becomes | Why |
|---|---|---|
| `safety` (default, `:118`) | `/outreach` — renamed **Seat** | It is the operating dashboard, not a settings page. It is already the first thing an operator sees and should keep that position. |
| `campaigns` | `/outreach/campaigns` | Unchanged. |
| `plan` | `/outreach/plan` | Unchanged. Keeps its dry-run banner (`src/client/LinkedInCampaigns.tsx:1035`). |
| `queue` | `/outreach/queue` | Unchanged. |
| — | `/outreach/replies` | **New.** Blocked on backend — see §4, Wave C1. Do not ship as an empty tab. |
| `analytics` | **deleted as a tab** | Absorbed three ways: the funnel (`FunnelBars`, `src/client/LinkedInAnalyticsScreen.tsx`) moves to `/loop`; the per-campaign table moves under `/outreach/campaigns`; the daily volume chart is already drawn on Seat (`src/client/LinkedInSafety.tsx`, "Volume and its variance"). |
| `setup` | `/setup/seat` | Seat identity, credentials, worker status. Configured once. Its kill switch does **not** go with it — it goes to the shell (§3.6). |
| `exclusions` | `/setup/limits` | A set-once list. Its own copy admits it: *"There is no removal button: removing an entry is a database operation"* (`src/client/LinkedInScreen.tsx:914`). That is not a screen an operator returns to. |

Moving `setup` out of `LinkedInScreen` removes the reason its kill switch lived in
the tab shell. The rationale at `src/client/LinkedInScreen.tsx:60-72` — *"THE KILL
SWITCH IS ALWAYS REACHABLE. It sits in the shell, above the tab strip, not inside
Setup"* — is not abandoned. It is **promoted one level**, from the LinkedIn shell
to the app shell, which is what it was always arguing for.

### Setup sub-routes

| Hash | Contents | Moved from |
|---|---|---|
| `/setup/agent` | `AgentAccessPanel` + `HostedAgentPanel` | `src/client/App.tsx:1012` and inside `IntegrationsView` (`:2235`) |
| `/setup/data` | Connections, Nango connect, Scope Ledger import, CSV import | rest of `IntegrationsView` (`src/client/App.tsx:2235`) |
| `/setup/seat` | LinkedIn seat, credentials, local worker | `SetupTab` (`src/client/LinkedInScreen.tsx:285`) |
| `/setup/skills` | Shared skills, private skills, run-one-by-hand | `ModulesView` (`src/client/App.tsx:2164`) + the playbook launcher lifted out of `WorkView` |
| `/setup/limits` | Automation rules, hard limits, never-contact list | `AutopilotView` (`src/client/App.tsx:2478`) + `ExclusionsTab` (`src/client/LinkedInScreen.tsx:874`) |
| `/setup/spend` | Monthly cap editor and the spending switch | the `byok-block` at `src/client/App.tsx:1310-1340` |

### Loop sub-route

| Hash | Contents |
|---|---|
| `/loop/cost` | **What this cost, and what it produced.** §3.5. |

### Deep links to preserve

- `/ledger/run/:id` — replaces the `inspectAgentRunId` prop threading at
  `src/client/App.tsx:172` and `:2010`. A run started from `/setup/agent`
  navigates to its own URL instead of setting state two components up.
- `/outreach/campaigns/:id` — `openCampaign` (`src/client/LinkedInCampaigns.tsx`)
  already binds the builder to a campaign; give that binding a URL.
- `#get-started` — keep. `src/client/App.tsx:194` reads it on mount for the auth
  screen and marketing links to it.

---

## 3. Screen by screen

### 3.1 `/loop` — the home screen

Replaces `TodayView` (`src/client/App.tsx:539`). Rename the component `LoopView`.

**Purpose.** Answer one question: what is the loop doing, and where is it stuck.
Not "what am I owed."

**Primary action.** One button, in the block sentence, pointing at the single
stage that is stuck. One primary per screen (`docs/app-spec.md` §7 rule 3).

**Above the fold, in order.**

1. **The stage bar.** Six cells — Find · Reach · Answer · Deliver · Bill · Paid —
   each with a count and a unit, each a link to the screen that owns it. Exactly
   one cell carries the stuck state at a time. This replaces the three variants of
   `.hero-card` at `src/client/App.tsx:555`, `:565`, `:573`, and deletes
   `.hero-orbit` (`:581`) outright — a decorative offset circle rendering
   `openRecommendations` is a number the tiles already carry.
2. **The block sentence.** One line naming the stuck stage and the one action that
   clears it. "42 invites are planned and the seat is paused — resume it, or lower
   the ceiling." Falls back to the existing all-clear copy when nothing is stuck:
   *"Nothing needs you right now."* (`src/client/App.tsx:568`), which is already
   correct and stays word for word.
3. **Four tiles** (below).
4. **What needs you** — the existing `.recommendations-panel` and
   `RecommendationCard` (`src/client/App.tsx:2622`), unchanged in markup, widened
   in scope: it now also lists playbook steps in `waiting_approval`
   (`GET /api/playbook-runs`, `src/server/app.ts:519`), which today are only
   visible if you happen to open Activity.
5. **Cost and yield strip** — three numbers and a link to `/loop/cost`. §3.5.

**The four tiles.** `src/client/App.tsx:586-591` renders At risk / Ready to invoice
/ Collected / Connected tools. Every one is a result or a config count; none is a
queue with an owner. Replace, keeping the `Metric` component
(`src/client/App.tsx:2617`) and `.metrics-grid-four` (`src/client/styles.css:68`)
exactly as they are:

| Tile | Value | Detail line | Source, all of which exist |
|---|---|---|---|
| **Going out this week** | planned + exported actions, next 7 days | "of *N* the seat may send" | `GET /api/linkedin/actions` (`src/server/app.ts:1424`) + `GET /api/linkedin/limits` (`:1399`) |
| **Waiting on a reply** | sent, not yet answered | "*N* answered · *X*%" | `GET /api/linkedin/analytics` (`src/server/app.ts:1897`), `total.sent/accepted/replied` |
| **Waiting on you** | `openRecommendations` + waiting approvals | `money(revenueAtRisk)` "is waiting on your decision" | `src/shared/types.ts:58`, `GET /api/playbook-runs` |
| **Waiting to be paid** | `readyToInvoice + revenueAtRisk` | "*€X* billed and unpaid, *€Y* delivered and unbilled" | `src/shared/types.ts:54,57` |

Every tile is a queue someone owns. `revenueCollected` (`src/shared/types.ts:56`)
demotes to `/money` — it is a trophy, not a bottleneck. `connectedSources`
(`:61`) demotes to `/setup/data`; the workspace already surfaces it twice more, in
`.sidebar-bottom` (`src/client/App.tsx:284`) and the `.setup-banner` (`:594`).

**Deleted.** `.hero-orbit`; the "Your clients" aside (`.client-panel`, already
hidden under 980px at `src/client/styles.css:196`, which means it was never load-
bearing) — its content is the whole of `/money`.

**Kept verbatim.** `OnboardingChecklist` (`src/client/App.tsx:457`) and its
derived-from-data mechanism (`:449-455`), rebuilt in §3.7.

---

### 3.2 `/outreach` — the engine, promoted

**Purpose.** Run the seat: what may go out today, why that number, and where the
variance is.

**Primary action.** None on the Seat screen — it is a read, like Activity
(`docs/app-spec.md` §5). The primary action lives on `/outreach/campaigns`.

**Above the fold.** Unchanged from `LinkedInSafetyScreen`
(`src/client/LinkedInSafety.tsx:32`), which is already right:

1. The honesty panel — *"Exactly N number on this screen is a HARD FACT. Every
   other one is REPORTED."* (`src/client/LinkedInSafety.tsx`, `.li-honesty`).
2. Where this seat stands, with `PostureBadge` (`src/client/LinkedInSafety.tsx:PostureBadge`).
3. The four `LiStat`s: invites left, warm-up week, acceptance rate, day-over-day clamp.
4. Volume and its variance — `VolumeChart` with the band.

**What moves in.** Nothing. This screen sets the standard; it does not absorb.

**What moves out.** `KillSwitch` (`src/client/LinkedInScreen.tsx:225-283`) is
deleted from this file — see §3.6. The `.li-tabs` strip
(`src/client/LinkedInScreen.tsx:157-166`) is deleted and replaced by hash sub-
routing; the refresh button on it (`:164`) survives as a `.topbar` icon button
next to the existing Search and Notifications (`src/client/App.tsx:291-293`).

**The empty state, which is currently a lie.** With no seat,
`inviteDay` is `undefined` and the screen renders four `—` tiles plus a warm-up
ramp for `seat.warmupWeek` of a seat that does not exist. Replace: when
`limits.seat.configured === false`, render one panel — the heading, the sentence
already written for it (*"No seat is configured, so nothing can be paced."*), and
a button to `/setup/seat`. Render nothing else. Delete the `—` fallbacks for that
case.

---

### 3.3 `/money` — the paid end, named as part of the loop

**Purpose.** What was agreed, delivered, billed and paid — and what wasn't, and why.

**Primary action.** Review a prepared action → approve or reject. Unchanged:
`ActionDrawer` (`src/client/App.tsx`) and its hash-pinned approval banner stay
exactly as written.

**Above the fold.**

1. **Three columns, one per loop stage,** replacing the flat recommendation list:
   **Delivered, not billed** (`unbilled_milestone`), **Billed, not paid**
   (`overdue_invoice`), **Not agreed** (`scope_creep`, `stale_proposal`).
2. **Collected** — `money(revenueCollected)`, the one trophy number, with the copy
   it already has: *"Paid after Trevra chased it"* (`src/client/App.tsx:590`).
3. `ClientsView` (`src/client/App.tsx:2219`), moved here from Activity.

**What moves in.** `ClientsView` from Activity (`src/client/App.tsx:2219`); the
`Collected` tile from `TodayView` (`:590`).

**What is explicitly not touched.** `recommendationLabels`
(`src/client/App.tsx:145-150`) and `RecommendationType` keep every string and
every enum member. `stale_proposal` / `scope_creep` / `unbilled_milestone` /
`overdue_invoice` are the paid end of the loop, not drift. Only their **grouping**
on screen changes. No rename, no migration, no server change. `iconFor`
(`src/client/App.tsx:2676`) and `automationDescription` (`:2684`) are untouched.

---

### 3.4 `/ledger` — the thing the landing page sells

**Purpose.** Every run the workspace has performed, with the evidence, and a way
to take it with you.

**Primary action.** Export.

**Above the fold.**

1. **Title: "Run ledger."** The exact phrase the landing page uses
   (`src/client/MarketingScreen.tsx:291`). Today the app has no screen by that name.
2. **Take your ledger with you** — the export panel. §3.7 below.
3. **One list, newest first** — the existing merged `ActivityRow` computation
   (`src/client/App.tsx`, inside `WorkView` at `:2010`), which already unifies
   playbook runs and agent runs on the correct principle: *"A job Trevra ran and a
   run by Trevra's own agent are the same thing to the person reading it: work
   that happened."* Keep that comment and that `useMemo`.
4. **Filters** — status, actor, date. Reuse `.li-filter-row`
   (`src/client/LinkedInScreen.tsx:790`), the pattern the LinkedIn area already
   uses, rather than inventing a second filter language.

**What moves in.** The "Recent jobs" section of `WorkView`
(`src/client/App.tsx:2010`) with `RunInspector` (`:1927`) and every one of its
`RunSection` / `FactGrid` / `SignedNote` renderers (`:1815`, `:1819`, `:1797`),
unchanged.

**What moves out.** The playbook launcher — the `.playbook-launch-grid` and
`SchemaForm` block inside `WorkView` — goes to `/setup/skills` under "Run one by
hand." `docs/app-spec.md` §4 already ruled on this: *"The agent starts jobs. A
human doing it by hand is the exception, not the front door."*

**Deleted.** The `.work-hero` at `src/client/App.tsx:2094-2096` — *"Put a job on
autopilot — and keep the final say"* is a marketing sentence on an internal
screen, and its `work-hero-count` duplicates the "Waiting on you" tile.

---

### 3.5 `/loop/cost` — the one combined spend surface

The founder's only real question — *what did this cost me and what did it
produce* — currently has no screen. Two half-surfaces exist:

- **Agent spend:** `.byok-meter` at `src/client/App.tsx:1326-1329`, inside
  `HostedAgentPanel` (`:1012`), inside Setup. Data: `workspace_agent_budget`
  (`monthly_cap_cents`, `spent_cents`, `period_start`, `enabled` —
  `migrations/016_agent_budget.sql:10`) and `agent_model_calls` (`model`,
  `prompt_tokens`, `completion_tokens`, `cost_cents` — `:28`, plus
  `usage_reported` from `migrations/020_agent_usage_reported.sql`). Routes
  `GET /api/agent-setup` (`src/server/app.ts:706`), `PUT /api/agent-setup/budget` (`:770`).
- **Outreach volume:** `GET /api/linkedin/limits` (`src/server/app.ts:1399`) and
  `GET /api/linkedin/analytics` (`:1897`).

Nothing joins them.

**Purpose.** One screen, three rows, one period selector (this month / last month
/ 90 days), reusing the `.li-range` selector at
`src/client/LinkedInAnalyticsScreen.tsx` rather than a new control.

| Row | Contents | Provenance treatment |
|---|---|---|
| **Spent** | `usd(spentCents)` of `usd(monthlyCapCents)` using the existing `usd()` helper (`src/client/App.tsx:141`) and the existing `.byok-meter` bar; broken out by model from `agent_model_calls` | **Each line carries a `ConfidenceTag`** (`src/client/LinkedInViz.tsx:ConfidenceTag`): `usage_reported = true` → `HARD FACT` (the provider measured it); `false` or `NULL` → `REPORTED` (Trevra estimated it). This is the single highest-value extension of the LinkedIn epistemics into the rest of the shell, and it costs one column that already exists. |
| **Sent** | actions by kind from `analytics.total`; agent runs from `GET /api/agent-runs` (`src/server/app.ts:790`) | plain counts |
| **Produced** | accepted, replied; then `readyToInvoice` and `revenueCollected` (`src/shared/types.ts:56-57`) | **Labelled not-attributed, in words on screen.** No join exists from a model call or a LinkedIn action to an invoice. Saying "this outreach produced this revenue" would be the exact class of unearned number `src/client/LinkedInSafety.tsx`'s honesty panel exists to forbid. Write: "These are the same period, not the same causal chain. Trevra does not claim one produced the other." |

**Controls stay in Setup.** `/loop/cost` is a read plus one switch: the spending
toggle, because `src/client/App.tsx:1113-1116` already argues that *"an off switch
that needs a second click to take effect is not an off switch."* The cap editor and
the Save button stay at `/setup/spend`.

**Blocked on backend.** Needs `GET /api/loop/cost?window=30` returning the three
rows in one payload. No new table: `agent_model_calls.run_id → agent_runs.id`
already exists, and `linkedin_actions` already carries `campaign_id`. See Wave B1.

---

### 3.6 The single incident surface — `StopBar`

**What exists today.**

| | `AgentStopControl` | `KillSwitch` |
|---|---|---|
| Defined | `src/client/App.tsx:1892` | `src/client/LinkedInScreen.tsx:225` |
| Rendered | inside `RunInspector` (`:1927`) and on each running agent card in the run list | once, in the LinkedIn shell above the tab strip (`src/client/LinkedInScreen.tsx:154`) |
| Route | `POST /api/agent-runs/stop` (`src/server/app.ts:855`) | `POST /api/linkedin/seat/pause` (`:1173`), `/resume` (`:1180`) |
| Semantics | **cooperative** — *"the run ends when it reaches the end of the step it is already in the middle of"* (`src/client/App.tsx:1892` doc) | **immediate** — *"Ceilings drop to zero, the worker halts within one tick"* (`src/client/LinkedInScreen.tsx:262`) |
| Colour | amber, deliberately: *"nothing has gone wrong here, and a run still doing what it was asked to do must not be dressed as a failure"* (`src/client/styles.css:490-505`) | `.li-killswitch` / `.is-paused` (`src/client/styles.css:561-562`), red |
| Reason | **none** | **mandatory** — *"Say why. This is the note you will read three weeks from now."* (`src/client/LinkedInScreen.tsx:238`) |
| Mentions the other | no | no |

**The replacement.** One `StopBar`, in the app shell, rendered between
`<header className="topbar">` (`src/client/App.tsx:288`) and the view outlet, on
every route. Three states:

- **Idle** — one muted line in the topbar row: "Nothing is running." No button, no
  colour. This also retires the current dead-end copy *"No seat is configured yet,
  so there is nothing to pause."* (`src/client/LinkedInScreen.tsx:263`).
- **Live** — names each live actor with its own control:
  `Outreach seat · sending` → **Pause everything** (`li-danger-button`, red,
  reason required) · `Agent · step 4 of 12` → **Ask it to stop** (`ghost-button
  danger` on amber, reason required as of this change) · and one **Stop
  everything** that fires both.
- **Stopped** — which actor is stopped, when, and the reason string, with a
  per-actor resume. `PostureBadge` (`src/client/LinkedInSafety.tsx`) renders the
  seat half; the agent half reuses the existing "Stop asked for" copy verbatim.

**Rules carried over, not invented.**

1. Amber for the agent, red for a paused seat. Two colours because they are two
   facts, and `src/client/styles.css:490-505` already argues why.
2. Verb per actor: **"Ask it to stop"** (cooperative) vs **"Pause everything"**
   (immediate). Never one verb over both.
3. **The reason field extends to the agent.** `src/client/LinkedInScreen.tsx:238`'s
   argument is not LinkedIn-specific. Needs `stop_reason TEXT` alongside
   `stop_requested_at` (`migrations/021_agent_run_stop.sql`) — the smallest
   possible schema change. See open question 5.
4. **Stop everything reports each call independently.** `POST /api/agent-runs/stop`
   404s on builds without the hosted agent; `agentSetupMessage`
   (`src/client/App.tsx:agentSetupMessage`) already writes the sentence for that
   case. Never claim both stopped when one did.
5. Secondary and destructive-styled, never primary — the constraint at
   `src/client/App.tsx:1892` doc, now true on every screen rather than two.

**Deleted.** `KillSwitch` (`src/client/LinkedInScreen.tsx:225-283`) and its call
site (`:154-159`). Both `AgentStopControl` render sites. `AgentStopControl`'s copy
strings move into `StopBar` unchanged.

**Responsive.** `.sidebar` is hidden below 760px (`src/client/styles.css:203`).
`StopBar` must not be — it collapses to a single sticky row above the content, and
its live state takes the first slot of the incoming `.mobile-tabbar`.

---

### 3.7 The unearned export claim, earned

**The claim.** `src/client/MarketingScreen.tsx:341` —
`<li><Check /> Exportable ledger and evidence</li>`, the headline self-hosting
benefit; repeated verbatim at `index.html:62`.

**What exists.** Exactly one export route in the entire server:
`GET /api/linkedin/campaigns/:id/export/:exportId` (`src/server/app.ts:1725`), with
`Content-Disposition: attachment` (`:1734-1735`) and `Cache-Control: no-store`
(`:1737`, so PII is not cached). Nothing else. No ledger export, no evidence
export, no CSV, no JSON dump.

**The control that earns it.** A panel on `/ledger` titled **"Take your ledger
with you"**, modelled directly on the LinkedIn export that already works end to
end:

- Client pattern to copy: `linkedInExportDownloadPath()`
  (`src/client/api.ts:962-965`), the render button (`src/client/LinkedInCampaigns.tsx:612`,
  "Render export"), and the download anchor (`:647`,
  `<a className="li-link" href={linkedInExportDownloadPath(...)}>Download</a>`).
- New routes: `POST /api/ledger/exports` `{ window, include: ['runs','steps','evidence','approvals','actions'] }`
  → renders and stores bytes; `GET /api/ledger/exports/:id` → serves them with the
  same three headers as `src/server/app.ts:1734-1737`.
- Format: **NDJSON per table plus a `manifest.json`** carrying row counts and the
  sha256 of each file, zipped. Not CSV — the ledger is nested (steps, evidence,
  `policyDecision`, `approvalPayloadHash`) and flattening it discards the evidence,
  which is the thing being claimed. The sha256 manifest is the same promise
  `SignedNote` (`src/client/App.tsx:1797`) already makes about approvals.
- Above the fold: what the file will contain, the exact row counts, one button.

**Do not ship a disabled button.** Until the routes land, either hold the panel
entirely, or ship the honest subset — a client-side download of the runs currently
loaded on screen, labelled "the *N* runs on this screen", never "your ledger."
Recommended: hold. See §4 Wave B2 and open question 7.

---

### 3.8 `/setup/skills` — modules are mostly skills

**What exists.** 20 entries in `public/catalog/modules.json`, every one
`"sourceType": "builtin"`, `"runtime": "builtin"`, publisher `trevra`. Fields:
`sideEffect` (`none` | `network-read` | `external-write`), `requiresApproval`,
`trust`, `popularity`. **No visibility or scope field anywhere.** 20 skills
registered flat in `src/server/skills/registry.ts:119-141`; `SkillManifest`
(`src/server/skills/types.ts`) has `sideEffect` and `requiresApproval` and no
scope. 5 playbooks in `src/server/playbooks/registry.ts`.

`ModulesView` (`src/client/App.tsx:2164`) shows all of them in one grid. Its
install button only renders when `module.sourceType === 'community'`
(`src/client/App.tsx:2210`) — so **on today's catalog not a single card has a
button.** It is a wall of read-only cards with a run counter.

**The IA.** One screen, two named groups, three verbs.

**Group 1 — Shared skills.** `sourceType: 'builtin' | 'community'`. What
`GET /api/public/modules` (`src/server/public-site.ts:131`) already serves and what
the marketing catalog links to. For `builtin`, replace the missing button with the
fact: "Always available." For `community`, keep the existing install toggle.

**Group 2 — Your skills.** `sourceType: 'workspace'` — private to the workspace,
written by the founder or their agent, never published. **Blocked**: this value
does not exist. See Wave C2. Until it does, ship group 1 alone under one heading;
do not render an empty private group.

Publishing stays out of the app — signing key, signed manifest, a build. The
existing note is correct and stays: *"Publishing needs a signing key on your
machine, so it lives in the terminal: `npm run module -- help`"*
(`src/client/App.tsx:2215`), consistent with `docs/app-spec.md` §4 ("Publisher /
SBOM / Ed25519 → Out of the app").

**Install** — `POST /api/registry/modules/:id/install` (`src/server/app.ts:631`).
Unchanged.

**Inspect** — new drawer, reusing the `RunInspector` section vocabulary
(`RunSection` `src/client/App.tsx:1815`, `FactGrid` `:1819`) so the shell has one
way of showing a contract:
- what it takes in / gives back, from the published schemas, rendered by the
  existing `SchemaForm` renderer in read-only mode (`src/client/App.tsx:SchemaForm`)
  — no raw JSON, per `docs/app-spec.md` §7 rule 1;
- what it can do, in the plain words the codebase already wrote for exactly these
  three values at `src/client/App.tsx:2377-2381`: *"Sends or changes something
  outside your business"* / *"Reads something from outside"* / *"Thinks only,
  nothing leaves Trevra"*;
- whether it needs approval — the existing string *"Needs your approval"* /
  *"Runs on its own"* (`src/client/App.tsx:2208`);
- its last 10 runs, from `GET /api/skill-runs?skillId=` (`src/server/app.ts:484`)
  — **this route exists and the client has never called it.**

**Revoke** — `DELETE /api/registry/modules/:id/install` (`src/server/app.ts:645`).
Relabel from "Uninstall" to **"Revoke access"** when `sideEffect ===
'external-write'`, with a confirm that names what it could do. Uninstalling a
thinking-only scorer and revoking a thing that can send mail are not the same act
and should not read the same.

**Also on this screen.** "Run one by hand" — the playbook launcher lifted out of
`WorkView` (`src/client/App.tsx:2010`), collapsed by default.

---

### 3.9 Onboarding — first run for an outreach signup

**What happens today.** `useState<View>('approvals')` (`src/client/App.tsx:166`)
lands on the approvals screen; `useState<Tab>('safety')`
(`src/client/LinkedInScreen.tsx:118`) lands the LinkedIn click on the Safety tab.
Someone who signed up to send LinkedIn outreach therefore sees, in order: a hero
saying *"Let's find the money you're owed"* (`src/client/App.tsx:557`), a checklist
whose four steps are about email and accounting (`src/client/App.tsx:466-497`),
and — one click later — four `—` tiles and a warm-up ramp for a seat that does not
exist.

**The mechanism to keep.** `OnboardingChecklist` (`src/client/App.tsx:457`) derives
every step from real data, and the comment at `:449-455` explains why: *"There is
no `onboarding_completed` flag to get out of sync with reality."* That rule
survives intact.

**The outreach path, in order.**

| # | Step | Done when | Lands on |
|---|---|---|---|
| 1 | **Name your seat** | `GET /api/linkedin/seat` returns a non-null `seat` | `/setup/seat` |
| 2 | **Connect the seat** | `auth.hasCredentials`, or worker `loggedIn` | `/setup/seat` — `POST /api/linkedin/seat/login` (`src/server/app.ts:1274`) |
| 3 | **Read what you are betting** | acknowledged once | `/outreach` — the honesty panel (`src/client/LinkedInSafety.tsx`, `.li-honesty`) is the one thing an operator must read before risking their account, and today nothing puts it in front of them |
| 4 | **Build one campaign** | `GET /api/linkedin/campaigns` non-empty | `/outreach/campaigns` |
| 5 | **Preview the plan** | a `POST /api/linkedin/plan` has returned slots | `/outreach/plan` — writes nothing (`src/client/LinkedInCampaigns.tsx:1035`) |
| 6 | **Approve and send** | first `linkedin_actions` row leaves `planned` | `/outreach/queue` |

**The money path** keeps today's four steps unchanged
(`src/client/App.tsx:466-497`), including its correct ordering rationale: *"the
agent comes first because nothing else works until one can reach the workspace"*
(`:463-464`).

**Which path shows.** Derived, never stored, per the existing rule: a seat exists →
outreach; a connection or client exists → money; neither → show both headings with
outreach first, since the LinkedIn engine is the product. No flag, no column.

**They land on `/loop`, not `/outreach`.** A seat-less Seat screen is four `—`
tiles; the checklist is the only honest content a brand-new workspace has, and
`/loop` is where it lives.

---

## 4. Migration order

### Wave A — ships independently, no backend work

Each item is releasable on its own.

- **A1.** Hash routing + the five nav items + `.mobile-tabbar`. Replace `type View`
  (`src/client/App.tsx:127`) with the route union; replace the four `NavButton`s
  (`:278-281`); rewrite `viewTitle` (`:2669`). Coordinate with the sibling already
  adding `location.hash`.
- **A2.** Split `LinkedInScreen` (`src/client/LinkedInScreen.tsx:110`) into
  `/outreach/*` sub-routes; move `SetupTab` (`:285`) → `/setup/seat`;
  `ExclusionsTab` (`:874`) → `/setup/limits`; delete `.li-tabs` (`:157-166`);
  delete the `analytics` tab, distributing its three panels per §2.
- **A3.** `StopBar`. Delete `KillSwitch` (`src/client/LinkedInScreen.tsx:225-283`)
  and both `AgentStopControl` (`src/client/App.tsx:1892`) render sites.
  *Depends on A1 for the shell slot; the reason-on-agent-stop half is B0 below.*
- **A4.** `LoopView` replacing `TodayView` (`src/client/App.tsx:539`): stage bar,
  block sentence, four new tiles. Every tile reads a route that already exists.
- **A5.** `/ledger`: lift the run list + `RunInspector` (`:1927`) out of `WorkView`
  (`:2010`); move the launcher to `/setup/skills`; delete `.work-hero` (`:2094`).
- **A6.** `/setup/skills`: shared group only, with Inspect (wired to the unused
  `GET /api/skill-runs`, `src/server/app.ts:484`) and the Revoke relabel.
- **A7.** Onboarding branch + the seat-less `/outreach` empty state.

Recommended order: A1 → A2 → A3 → A4 → A5 → A6 → A7. A4 reads better once A2 has
freed the Outreach data; A3 needs A1's shell slot.

### Wave B — must ship together, because half of each lies

- **B0.** `stop_reason TEXT` on `agent_runs` (next to `stop_requested_at`,
  `migrations/021_agent_run_stop.sql`) + `POST /api/agent-runs/stop` accepting it +
  the field in `StopBar`. All three, or the agent stop keeps no note while the seat
  stop demands one.
- **B1.** `GET /api/loop/cost` + the `/loop/cost` screen + demoting
  `src/client/App.tsx:1310-1340` to a cap editor. Ship the screen without the route
  and there are two spend surfaces again; ship the route without the screen and
  nothing changed.
- **B2.** `POST /api/ledger/exports` + `GET /api/ledger/exports/:id` + the
  `/ledger` panel. All three. A disabled Export button under a landing page that
  promises *"Exportable ledger and evidence"* (`src/client/MarketingScreen.tsx:341`)
  is worse than no button.

### Wave C — blocked on backend that does not exist

- **C1. Replies.** `migrations/031_linkedin_inbox.sql` creates `linkedin_threads`;
  `src/server/linkedin/inbox.ts` and `driver-inbox.ts` are written. Grepping
  `src/server/app.ts` for `linkedin/inbox` or `linkedin/threads` returns **nothing**,
  and `src/client/api.ts` has no matching function. Needs `GET /api/linkedin/threads`,
  `GET /api/linkedin/threads/:id`, and a reply path that files an ordinary `dm` into
  `linkedin_actions` — the migration header forbids an outbox in so many words:
  *"an outbox is exactly the shape a 'just send this one quickly' path grows out
  of."* Until the routes land, `/outreach/replies` must not exist. The **Answer**
  cell on the stage bar renders as "not connected yet," never as zero.
- **C2. Private skills.** No `sourceType: 'workspace'`; `SkillManifest`
  (`src/server/skills/types.ts`) has no scope field; `public/catalog/modules.json`
  has no visibility field. Until one exists, ship the shared group alone.
- **C3. Lead sourcing (the Find stage).** `src/server/linkedin/leads.ts:326` and
  `migrations/030_linkedin_lead_sources.sql` exist; no route. The migration header
  also gates it: it *"refuses to run unless `leadSourcingEnabled()` says so — a
  separate opt-in from the automation switch, off by default, and unconditionally
  off on a hosted deployment."* So **Find** has no honest UI beyond the paste box
  and CSV import on hosted. Draw the stage; do not draw it as available on a hosted
  workspace.
- **C4. Cost attribution.** Nothing joins a model call or a LinkedIn action to an
  invoice. `/loop/cost`'s Produced row must say so in words rather than imply a
  causal chain.

---

## 5. Open questions, each with a default so nothing blocks

1. **Five nav items contradicts `docs/app-spec.md` §4 ("Three nav items. Not six").**
   *Default:* ship five and amend §4's table in the same PR. The spec predates the
   LinkedIn engine and already lost the argument at `src/client/App.tsx:280`; the
   three-job framing described an AR product, and the founder says this is one loop
   with two ends.

2. **Does the nav item say "Money" or "Approvals"?**
   *Default:* "Money" in the nav, and keep the string `viewTitle` already returns —
   *"What needs you"* (`src/client/App.tsx:2670`) — as the heading of the approvals
   panel inside it. Both sentences are true and neither is redundant.

3. **Should `RecommendationType` be renamed to loop vocabulary?**
   *Default:* **no.** No enum change, no string change, no migration. `stale_proposal`
   / `scope_creep` / `unbilled_milestone` / `overdue_invoice`
   (`src/client/App.tsx:145-150`) are the paid end of the loop. Only their grouping
   on `/money` changes.

4. **One stop button or three?**
   *Default:* three — Agent, Seat, Everything. They have different semantics and the
   codebase already argues both sides at `src/client/App.tsx:1892` (cooperative) and
   `src/client/LinkedInScreen.tsx:262` (immediate). Collapsing them into one button
   would make the UI claim a stop it cannot vouch for.

5. **Is a reason field justified on an urgent agent-stop control?**
   *Default:* yes, and pre-fill nothing.
   `src/client/LinkedInScreen.tsx:238` — *"Say why. This is the note you will read
   three weeks from now"* — is not LinkedIn-specific reasoning. Cost: one nullable
   `stop_reason TEXT` column (B0).

6. **Ledger export format.**
   *Default:* NDJSON per table + `manifest.json` with per-file sha256, zipped. Not
   CSV. The ledger is nested and flattening drops the evidence, which is the thing
   the landing page is claiming.

7. **Does `src/client/MarketingScreen.tsx:341` stay while Wave B2 is in flight?**
   Not this plan's call — a sibling agent owns the marketing surface.
   *Default:* leave the copy; B2 is two routes and one panel and should land in the
   same cycle. If it slips a cycle, the honest interim is a per-screen download
   labelled "the *N* runs on this screen," never "your ledger."

8. **No `PRODUCT.md` exists.** `.claude/skills/impeccable/scripts/context.mjs`
   reports `NO_PRODUCT_MD` and `BUILD_INIT_REQUIRED`, and this plan was produced
   without the founder interview that step normally requires.
   *Default:* treat `docs/app-spec.md` §1–§4, `docs/founder-skills.md` §2, and this
   document as product truth for the implementation, and run `/impeccable init`
   before the next visual-world decision. No item in Wave A depends on the answer.

9. **Does the stage bar show "Find" on hosted workspaces?**
   *Default:* show the cell, render it as "Import a list" rather than a count, and
   link it to the CSV import at `POST /api/linkedin/targets/import`
   (`src/server/app.ts:1855`). Lead sourcing is unconditionally off on hosted
   (`migrations/030_linkedin_lead_sources.sql` header), and a stage cell reading `0`
   would blame the operator for a switch they cannot reach.
