# LinkedIn outreach: what we have, what's true, what to build

Status: plan. Date: 2026-08-04.

---

## 0. TL;DR

- **We already have ~70% of the machinery.** LinkedIn is a registered channel (`prepare-only`) and a registered scout (`disabled`), with daily caps, cooldowns, self-promo ratio, approval gates, CRM write-back, agent scheduling, budget guard and BYOK secrets all shipped.
- **What we do not have is anything LinkedIn-specific about _pacing a human's own account_** — invites/day, warm-up ramp, acceptance-rate feedback, business-hours spread, weekend behaviour, per-seat (not per-workspace) limits.
- **No official LinkedIn API lets us send connection invites or DMs.** Not Marketing Developer Platform, not Sales Navigator, not Community Management. That is a hard fact, not a gating/approval problem. Anything that does it is either an aggregator proxying a cookie session or a browser extension.
- **The "don't get banned" engine is the product, and it is the part with zero exposure** — pacing is pure computation over our own ledger. It is also where we beat Dripify: Dripify ships per-day caps and randomized delays, but no cross-day variance smoothing, no warm-up ramp derived from account age, and no acceptance-rate throttle. Variance is what triggers enforcement (§1.3), not volume.
- **Recommendation: build the pacing brain, not the sending arm.** Trevra generates the sequence + the pacing schedule + the CSV; the user executes it in _their own_ Dripify/HeyReach/Expandi account. Keep `automation.mode: 'prepare-only'`. Optionally add an opt-in aggregator adapter (Unipile / HeyReach) later behind an explicit risk-acceptance flag.

> **Amended, 2026-08-05 — the arm gets built too.** The bullet above still
> describes the _default_ and the export path stays. What changed is the
> operator's own position: paying $39–79/user/mo for a tool that cannot
> personalise per lead (Dripify has no custom CSV variables) and cannot resolve
> a branch we defined, while Phase 4's local worker sits built and unwired, is
> not a trade worth continuing. **Campaign invites and DMs get queued and sent
> by the local worker.**
>
> This is not a reversal of §3's decision — option (c), shipping our own
> extension, stays rejected, and Trevra still never touches LinkedIn from its
> own infrastructure. It is finishing option (d)+Phase 4 as specified: the
> operator's machine, the operator's session, the operator's risk, zero
> credential custody. §3.1's rejection of storing a password stands unchanged.
>
> What it costs, recorded honestly: **selector maintenance forever** (most of
> what a $59/mo subscription actually buys), and **no answer yet for hosted**
> — `TREVRA_DEPLOYMENT_MODE=hosted` refuses in three places and should keep
> refusing until the signed local companion exists. See
> [core-product.md](./core-product.md) §3.5.

---

## 1. Verified constraints (the "verify API limits + blocking rules" ask)

### 1.1 Official APIs — HARD FACT

| API                                | Can it invite/DM?           | Gating                                                   |
| ---------------------------------- | --------------------------- | -------------------------------------------------------- |
| Marketing Developer Platform       | **No**                      | Ads + analytics only                                     |
| Sales Navigator                    | **No developer API at all** | Consumer product, $119.99–$159.99/seat/mo; CRM sync only |
| Community Management API           | **No**                      | Pages/events only, partner-gated                         |
| Share on LinkedIn / Sign In (OIDC) | **No**                      | OAuth consumer scope; posting is review-gated            |
| Lead Sync / Lead Gen Forms         | **No**                      | Vetted Partner Program only                              |
| Conversations / Messaging          | **Does not exist publicly** | —                                                        |

- InMail is capped at **50/month** per Sales Navigator seat. HARD FACT.
- Self-serve API tier baseline: **100k calls/day**, subject to per-app throttling. Exact per-endpoint numbers are not in public docs.
- API ToS §3.1 explicitly bans: automating posting, exceeding/circumventing call limits, and creating multiple apps for similar usage.

**Conclusion: there is no compliant API route to LinkedIn outreach. Stop looking for one.**

### 1.2 Explicitly forbidden — HARD FACT

User Agreement §8.2 prohibits developing, supporting **or using** "software, devices, scripts, robots or any other means or processes (such as crawlers, **browser plugins and add-ons** or any other technology) to scrape or copy" LinkedIn content.

That clause names browser extensions by category. Dripify, Expandi and Waalaxy are all in scope of it. So is anything we would ship ourselves.

§3.4 reserves the right to "restrict, suspend, or terminate your account."

**Legal state after hiQ (settled Nov 2022, $500k judgment against hiQ):** scraping _public_ data is not a CFAA violation, but LinkedIn's **breach-of-contract and trespass claims survive**. Fake accounts and detection-evasion remain actionable. So "it's legal to scrape" ≠ "we can ship it" — the exposure is contractual, and it lands on the _user's_ account.

### 1.3 Blocking mechanics — REPORTED (PhantomBuster, June 2026, n≈10mo telemetry)

Detection is **behavioural, not a volume threshold**:

- **"Slide and Spike"**: 5–10 days of declining activity (≈ −1.16 launches/day) followed by a **+120% surge within 24–48h** immediately precedes disconnection. Volatility is the signal, not the number.
- Day-over-day volume change **>50%** is a trigger.
- Sustained **acceptance rate <30%** over a week reads as spam.
- Disconnections cluster on **Tuesdays and Wednesdays** (enforcement scan cadence).
- Accounts **<3 months old** get materially less tolerance; IP/device churn is flagged.

Restriction tiers: temporary disconnect (24–48h, manual re-login) → visibility/reach demotion → permanent suspension.

**Design implication, and it is the important one: our pacing engine must optimise for _low variance_, not for a daily ceiling.** A hard cap of "20/day" that the user hits 20/20/20/0/0/0/20 is more dangerous than a smooth 12/day. Nobody else's tool models this. This is the differentiator.

### 1.4 Safe pacing numbers — REPORTED

| Metric               | New account (<3mo)      | Established (3–6mo, 500+ conns)                            |
| -------------------- | ----------------------- | ---------------------------------------------------------- |
| Invites/day          | 5–10                    | 10–20                                                      |
| Invites/week         | ≤25 for >40% acceptance | ~51 industry average; >100/wk → acceptance falls to 25–30% |
| DMs (1st degree)/day | 1–3                     | 5–15                                                       |
| InMail               | 50/month hard quota     | 50/month; pace 2–3/day                                     |
| Profile views/day    | ≤20                     | 20–50 (>100 flagged)                                       |

**Warm-up ramp** (REPORTED): wk1 passive only (views/likes, 0 invites) → wk2 5–10 light actions, 0–5 invites → wk3+ ramp to ~10/day, then tune on acceptance rate.

**Timing**: spread across 08:00–18:00 _recipient/user local_, randomised 30–120s gaps, never a 2-hour block. Weekends ≈50% of weekday rate or zero. Multi-seat: stagger accounts 2–4h apart.

Confidence note: every number in this table is practitioner-reported, not official. Encode them as **defaults with visible provenance**, never as guarantees.

---

## 2. What we already have (inventory)

### Present and reusable

| Concern                  | Where                                                                | Note                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| LinkedIn channel adapter | `src/server/channels/adapters/linkedin.ts`                           | `automation.mode: 'prepare-only'`, maxChars 3000, linkPenalty, honest `reason` string                                              |
| LinkedIn scout           | `src/server/outreach/scouts/linkedin.ts`                             | `availability() → {mode:'disabled', reason:'UA §8.2 …'}`; `search()` returns empty + warning                                       |
| Per-platform limits      | `src/server/outreach/config.ts` `PLATFORM_LIMITS.linkedin`           | `{maxPostsPerDay:5, minAccountAgeDays:0, minKarma:0, cooldownHours:48}`                                                            |
| Safety gate              | `src/server/outreach/safety.ts` `evaluateSafety()`                   | 7 checks, all run (no short-circuit): blacklist community/keyword, daily cap, account age, karma, cooldown, self-promo ratio ≤0.10 |
| Guard as a skill         | `outreachGuardSkill`                                                 | wired into playbook with `requireAllowed: true`                                                                                    |
| Post ledger              | `migrations/013_outreach.sql` → `outreach_posts`, `outreach_threads` | partial unique on `(workspace_id,payload_hash) WHERE status<>'failed'`; claim-before-call, only 4xx releases                       |
| Publish path             | `src/server/outreach/publish.ts`                                     | `REPLY_PUBLISHERS` map; `assertPostingWindow()` re-checks cap+cooldown pre-flight                                                  |
| CRM write-back           | `migrations/014_crm_activities.sql`, `src/server/crm/`               | HubSpot + Attio adapters via Nango; `recordOutreachInCrm()` auto-called post-publish                                               |
| Approvals                | `src/server/playbooks/engine.ts`                                     | approval bound to `canonicalPayloadHash(payload)`; drift after approval fails closed                                               |
| Policy                   | `src/server/control-plane/policy.ts`                                 | `allow` / `deny` / `require_approval` on action+payload                                                                            |
| Scheduling               | `migrations/018`, `src/server/agent/schedule.ts`                     | `next_run_at` lease, atomic `claimDueAgentSchedules()`, 15min–7d interval                                                          |
| Run ledger               | `migrations/017`, `021`, `src/server/agent/runs.ts`                  | `agent_runs` + `agent_run_steps`, stop-requested, stale reaping                                                                    |
| Budget guard             | `migrations/016`, `src/server/agent/budget.ts`                       | monthly cap cents, `assertAgentBudgetAvailable()` pre-flight                                                                       |
| BYOK secrets             | `migrations/015`, `src/server/secrets/`                              | AES-256-GCM, ciphertext in DB / key in env, rotation via `TREVRA_SECRETS_KEY_PREVIOUS`                                             |
| SSRF-safe fetch          | `src/server/skills/guard.ts` `createSsrfFetch()`                     | private-IP block, redirect revalidation, cross-origin auth stripping                                                               |
| Playbook                 | `gtm.community-outreach`                                             | scout → score → guard → draft → approval → action                                                                                  |

### Missing (the actual gap list)

1. **No notion of a LinkedIn _seat_.** Everything is workspace+platform scoped. LinkedIn limits are _per human account_. `countPostsToday(workspaceId, platform)` cannot express "Pankaj sent 12 invites today."
2. **No action taxonomy.** We model "post a reply." LinkedIn outreach is `invite | dm | inmail | profile_view | post_comment | follow` — different limits each.
3. **No pacing engine.** We have a _cap_ (`maxPostsPerDay`). We have no _schedule_: no ramp, no variance smoothing, no business-hours/timezone spread, no jitter, no weekend rule.
4. **No acceptance-rate feedback loop.** Nothing ingests outcomes, so nothing can throttle on the <30% signal.
5. **No account-age / warm-up state.** `minAccountAgeDays: 0` for LinkedIn — the field exists but is unused and unknowable via API.
6. **No LinkedIn contact identity.** `contact_identities` has email/github/mastodon; no `linkedin` kind, so a LinkedIn touch cannot resolve to a CRM contact.
7. **No export surface.** Nothing produces a Dripify/HeyReach/Expandi-shaped CSV or campaign spec.
8. **No aggregator adapter** (Unipile/HeyReach) and no risk-acceptance record if we ever add one.

---

## 3. Architecture decision

Four options, scored against Trevra's existing posture (honest automation modes, approval-bound payload hashes, fail-closed guards):

| Option                                                                    | Risk to user's account   | Our liability                         | Effort                                   | Verdict                            |
| ------------------------------------------------------------------------- | ------------------------ | ------------------------------------- | ---------------------------------------- | ---------------------------------- |
| (a) Official APIs only                                                    | none                     | none                                  | high, and **cannot deliver the feature** | rejected — no invite/DM API exists |
| (b) Aggregator API (Unipile / HeyReach)                                   | medium                   | **shared — we become the automation** | low (REST + webhooks)                    | Phase 4, opt-in only               |
| (c) Ship our own browser extension                                        | high                     | **directly named by §8.2**            | high                                     | **rejected**                       |
| (d) BYO-tool: we plan + pace + export, user executes in their own account | user's, and pre-existing | **none — we never touch LinkedIn**    | low–medium                               | **chosen for Phases 1–3**          |

**Decision: (d) now, (b) later behind explicit opt-in.** Seat model decided: **one seat = workspace owner** (see §7.1).

### 3.1 Two rejected shortcuts, recorded so they don't get re-proposed

**Trevra storing the user's LinkedIn password — rejected.** It inverts the liability the rest of this plan is built to avoid: we become the automation operator under §8.2 rather than the planner. It is the specific conduct the hiQ settlement preserved LinkedIn's CFAA claim for ("direct access to password-protected pages"). It breaks on any 2FA-enabled account unless we also intercept codes, which is worse. And `secrets/crypto.ts` is scoped for revocable API keys — a password to a primary professional identity is not revocable-by-scope, so an env-key leak escalates from "rotate a key" to full identity takeover. Server-side login also presents a novel IP/device fingerprint, the exact signal in §1.3.

_Not_ rejected: the user entering their own credentials **into Dripify**. That is their account, their tool, their ToS relationship, and it is precisely how the export path is meant to terminate. Trevra never sees it.

**Nango + LinkedIn OAuth — does not work, for a structural reason.** Nango is a token broker; it can only vend scopes the provider publishes. LinkedIn publishes Sign In (OIDC), Share on LinkedIn, and Marketing/Ads. **There is no invite scope and no messaging scope in existence.** No OAuth grant — brokered or direct — can send a connection request or a DM, so Nango cannot reach this use case no matter how it is configured. This is not an approval or partner-tier problem that persistence solves; the endpoint does not exist. Our HubSpot/Attio Nango integration does not generalize here. Nango remains correct for the CRM write-back leg (§4 Phase 3).

Rationale: the value we add is the _pacing brain_ — variance-smoothed, warm-up-aware, acceptance-rate-driven scheduling that no existing tool models — plus the sequence copy and the CRM system-of-record. The sending arm is the commoditised, liability-bearing, ToS-violating part. Let Dripify be the arm. `automation.mode` stays `prepare-only`, and its `reason` string stays true.

This is also consistent with what the codebase already asserts in `scouts/linkedin.ts`. We are not reversing a policy; we are building the compliant half properly.

---

## 4. Build plan

### Phase 1 — Seats + action taxonomy (foundation)

**`migrations/022_linkedin_seats.sql`**

```
linkedin_seats
  (workspace_id, seat_key) PK
  label              text not null          -- "Pankaj (founder)"
  profile_url        text                   -- entered by user, never scraped
  account_opened_on  date                   -- user-declared; drives warm-up week
  connections_count  int                    -- user-declared, refreshed manually
  timezone           text not null          -- IANA, drives business-hours window
  posture            text not null          -- 'warmup' | 'steady' | 'paused' | 'cooldown'
  paused_reason      text
  created_at, updated_at

linkedin_actions                             -- the per-seat ledger
  id PK
  workspace_id, seat_key
  kind               text not null          -- invite|dm|inmail|profile_view|comment|follow
  target_ref         text                   -- opaque user-supplied handle/url
  campaign_id        text
  status             text not null          -- planned|exported|sent|accepted|replied|declined|skipped
  planned_for        timestamptz            -- the paced slot
  recorded_at        timestamptz
  source             text not null          -- 'export' | 'manual' | 'aggregator'
  payload_hash       text
  created_at

unique (workspace_id, seat_key, kind, target_ref) where status <> 'skipped'
index  (workspace_id, seat_key, kind, recorded_at desc)   -- rolling-window counts
index  (workspace_id, seat_key, planned_for) where status = 'planned'
```

Follow the house pattern: partial unique index as replay guard, `status<>'failed'`-style exclusion, one logical change per migration.

**`src/server/linkedin/seats.ts`** — `listSeats`, `upsertSeat`, `pauseSeat`, `resumeSeat`, `getSeatPosture`.
**`src/server/linkedin/actions.ts`** — `recordAction`, `countActionsInWindow(seat, kind, sinceHours)`, `acceptanceRate(seat, days)`.

Tests: `src/server/linkedin/seats.test.ts`, `actions.test.ts` (mirror `outreach/safety.test.ts` shape).

### Phase 2 — The pacing engine (the actual product)

**`src/server/linkedin/limits.ts`** — limits as _code, in a diff-reviewable table_, matching `config.ts` convention:

```ts
export const LINKEDIN_LIMITS = {
  invite: { warmup: { perDay: 5, perWeek: 20 }, steady: { perDay: 18, perWeek: 90 } },
  dm: { warmup: { perDay: 2, perWeek: 10 }, steady: { perDay: 12, perWeek: 60 } },
  inmail: { warmup: { perDay: 1, perMonth: 50 }, steady: { perDay: 3, perMonth: 50 } },
  profile_view: { warmup: { perDay: 15 }, steady: { perDay: 45 } }
} as const;

export const MAX_DAY_OVER_DAY_DELTA = 0.35; // < the 0.5 reported trigger
export const MIN_ACCEPTANCE_RATE = 0.3; // below → auto-throttle
export const BUSINESS_HOURS = { start: 8, end: 18 };
export const ACTION_GAP_SECONDS = { min: 30, max: 120 };
export const WEEKEND_FACTOR = 0.0;
```

Each constant carries a comment naming its source and confidence (HARD FACT vs REPORTED), same discipline as `PLATFORM_LIMITS`.

**`src/server/linkedin/pacing.ts`** — `planPacing(db, {workspaceId, seatKey, kind, targets[], horizonDays}, now) → PacingPlan`

Algorithm:

1. Resolve seat posture; derive warm-up week from `account_opened_on`.
2. Base daily volume = posture band ceiling × warm-up multiplier (wk1 0, wk2 0.4, wk3 0.7, wk4+ 1.0) — **for active kinds only** (`invite`, `dm`, `inmail`). **Passive kinds (`profile_view`, later `follow`/`like`/`comment`) bypass the warm-up multiplier entirely** and run at their normal posture band from week 1. Rationale: §1.4 defines week 1 as "passive only (views/likes, 0 invites)" — the passive actions _are_ the warm-up. Zeroing them too would leave the account dormant for seven days and then active, which is precisely the §1.3 Slide-and-Spike shape the engine exists to prevent. Passive kinds remain subject to every other check (rolling caps, variance clamp, business hours, weekend factor, posture).
3. **Variance smoothing** — clamp each day to ±`MAX_DAY_OVER_DAY_DELTA` of the previous day's _actual_ count from `linkedin_actions`. This is the anti-"Slide and Spike" rule and the core IP.
4. Acceptance-rate feedback: if 7-day acceptance < `MIN_ACCEPTANCE_RATE`, multiply volume by 0.5 and emit a `throttled` reason.
5. Weekend factor; skip Tue/Wed peak-scan uplift (never schedule a day's max on Tue/Wed).
6. Distribute within `BUSINESS_HOURS` in the seat's timezone with deterministic-seeded jitter (seed = `payload_hash`, so plans are reproducible and approval hashes stay stable — **no `Math.random()`**).
7. Emit `PacingPlan { seatKey, slots: [{plannedFor, kind, targetRef}], reasons[], ceilingsApplied[] }`.

**`src/server/linkedin/guard.ts`** — `evaluateLinkedInSafety()`, mirroring `evaluateSafety()`: **all checks always run**, returns every blocker at once. Checks: seat paused, warm-up week ceiling, rolling 24h/7d/30d caps, day-over-day delta, acceptance rate, business-hours window, weekend rule, InMail monthly quota, duplicate target.

Register as `linkedinPacingSkill` (`gtm.linkedin-pace`) and `linkedinGuardSkill` (`gtm.linkedin-guard`) in `src/server/skills/registry.ts`, `sideEffect: 'none'`.

Tests: `src/server/linkedin/pacing.test.ts` — assert ramp shape, assert a 0/0/0/20 burst is rejected, assert plan determinism for a fixed seed, assert acceptance-rate throttle fires.

### Phase 3 — Sequence generation + export (the deliverable)

**`src/server/linkedin/sequence.ts`** — `linkedinSequenceSkill` (`gtm.linkedin-sequence`), `sideEffect: 'none'`. Input: ICP, offer, target list, tone. Output: `{steps: [{day, kind, template, variables[]}], antiSlopNotes[]}`. Reuse the `draftReplySkill` anti-slop critique pass verbatim — do not fork it.

**`src/server/linkedin/export.ts`** — `exportCampaign(plan, sequence, format)`:

- `dripify` — CSV: `profile_url, first_name, last_name, company, note, day_1_message, day_3_message, …`
- `heyreach` — CSV/JSON per their list import shape
- `expandi` — CSV
- `generic` — plan + copy + explicit per-day send counts, human-readable

Every export embeds a header block: the pacing schedule, the ceilings applied, the warm-up week, and a one-line statement that **the user executes this in their own account and owns the ToS relationship**.

On export, write `linkedin_actions` rows with `status='exported'`, `source='export'` — that is what makes the pacing engine's day-over-day math real rather than theoretical on the next run.

**Playbook `gtm.linkedin-outreach`** in `src/server/playbooks/registry.ts`:
`sequence → pace → guard(requireAllowed:true) → approval → action:linkedin.export`

Action type `linkedin.export` in `src/server/control-plane/execution.ts` (matches `/^[a-z][a-z0-9_.-]{2,119}$/`). Approval binds the payload hash, so an edited plan re-approves — consistent with existing engine behaviour.

**`migrations/023_linkedin_identity.sql`** — allow `kind='linkedin'` in `contact_identities` so a LinkedIn touch resolves to a CRM contact; then `recordOutreachInCrm()` works unchanged with `activity_type='linkedin_touch'`, `source_type='linkedin_action'`.

**Outcome ingest**: minimal UI/API to mark actions `accepted | replied | declined` (paste-back or CSV re-import from Dripify's export). Without this the acceptance-rate loop is dead — do not skip it.

### Phase 4 — Local Playwright worker (self-hosted only) — RESPEC'D

Supersedes the earlier "rent an aggregator" spec. Trevra is open-source and self-hosted, which changes the economics and removes the two expensive frictions:

- **No per-account IP cost.** A self-hoster runs on their own network — the same residential IP they already browse LinkedIn from. That was most of the ~$290/mo.
- **No browser farm.** One operator, one session, one machine. Not N headless Chromes multi-tenant.
- **Operator = self-hoster.** Whoever runs the instance uses their own account. Standard OSS posture; nothing is distributed to third parties.

#### 4.1 The credential design — one path now — REVISED, then REMOVED

> **Amended, 2026-08-06 — Path A is gone.** The zero-custody "log in by hand in
> a headed window, Trevra holds nothing" path described below shipped, then was
> removed at the operator's own request: it was dead weight on this project's
> deployment shape specifically (self-hosted in a container, no display, so
> Path A could never actually run there) and confusing next to the credentials
> path that was the one actually in use. `SeatAuthMode`, `setSeatAuthMode`,
> `npm run linkedin:login`, and the "Or connect without storing a password" UI
> disclosure are gone from the codebase. Trevra now has exactly one way into
> LinkedIn: **the operator hands Trevra their own email and password, and
> Trevra signs in.**

**There is no credential-free path any more.** Playwright with a persistent `user-data-dir` still holds the session, so a live login is still reused before anything re-authenticates — that part is unchanged. But every seat now signs itself in with its own stored email and password; nothing attaches to a profile a human logged into out of band.

Profile path is config, not DB: `TREVRA_LINKEDIN_PROFILE_DIR`, default `~/.trevra/linkedin-profile` — still where the persistent browser context lives, headed or headless, regardless of mode.

**Credentials — because a headless Chromium can type a password but cannot show a human a window.** §4.9 is the honest statement of the problem: inside Docker there is no `DISPLAY`, no browser binary a human could watch. A self-hoster automating **their own account** hands Trevra their own LinkedIn email and password, and Trevra signs in for them — exactly what Dripify, the product §4A measures against, has always done.

The risk posture is **better than Dripify's**, and the difference is where the login comes from. Dripify signs in from their datacenter, which is why they sell a dedicated-proxy add-on to make that survivable. This signs in from the operator's own machine and own IP — the same place their real browser sits.

Rules, and every one of them is enforced in code rather than promised here:

| Rule                                                                                                                                                                                         | Where                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Sealed with the **existing** AES-256-GCM store; no second crypto path, no second table                                                                                                       | `workspace_secrets` kinds `linkedin.email` / `linkedin.password`, migration 015 |
| **`TREVRA_DEPLOYMENT_MODE=hosted` refuses custody outright**, on the write path _and_ the read path                                                                                          | `secrets/linkedin.ts`, and again at the route                                   |
| Write-only over the wire: no route, serializer, log line or error message returns the password                                                                                               | `secrets/linkedin.ts` has no function that could; there is no reveal endpoint   |
| Nothing plaintext-derived stored in the clear — `last4` is `''` for both kinds                                                                                                               | `KIND_DISPLAY` in `secrets/store.ts`                                            |
| Reads return `hasCredentials` and the masked email (`p•••@domain.com`) only, with **no decryption on any read path** — the mask is computed once on write and stored as the secret's `label` | `describeLinkedInCredentials`                                                   |
| Decrypted only at the moment of use, handed straight to `page.fill()`, never held on a long-lived object                                                                                     | `loginLinkedInSeat`                                                             |
| No `detail` string in `driver.ts` is built from an argument, so no failure path can echo either value                                                                                        | file header rule, asserted by `credentials.test.ts`                             |

**A LIVE SESSION IS ALWAYS PREFERRED TO A FRESH LOGIN, and this is a safety rule, not an optimisation.** `driver.isLoggedIn()` runs before every sign-in, on both paths. A persistent `user-data-dir` holds LinkedIn's cookies for weeks; re-authenticating anyway would be slower on every run _and_ a much stronger ban signal — §1.3's "Slide and Spike" is about a surge in automated activity, and a login burst is precisely that shape. So the password is not even **read** on the normal path: it is opened only when the stored session has actually expired. `linkedin_seats.session_valid_at` (migration 028) records the last time a live session was _confirmed_, and is written only where that was observed — never on an attempt.

**2FA is a step, not a failure.** `loginWithCredentials` distinguishes four answers: signed in; `needsOtp` (LinkedIn sent a code — ask the operator and call again with it); `challenge` (a captcha or device verification, which **only a person at a browser window can finish**, and the message says exactly that); and a rejected pair. The code box is read **before** `detectWall`, because `SELECTORS.challengeForm` matches `input[name="pin"]` and a two-factor prompt read as a wall would tell an operator to go and find a human when they only had to type six digits.

The six-kind `failureKind` vocabulary is **not** widened for this. A rejected pair reports `not_found`, which already means exactly what is true here: definite, and no retry with the same input will change it. A seventh kind would have to mean something to the batch loop, and no action ever returns it.

#### 4.2 Distinguish this from rejected option (c)

§3 rejects "ship our own browser extension." This is not that. An extension is _distributed software_ that automates _other people's_ accounts — the thing §8.2 names, with liability flowing to us. A self-hosted worker is the operator automating their own account on their own machine, with no distribution and no custody. The ban risk is real and lands on the self-hoster; the _legal_ exposure does not transfer to the project. Ship it default-off, with §1.3/§1.4 numbers visible in the UI at enable time.

#### 4.3 Deployment-mode gate (build day one, not later) — REVISED

> **SUPERSEDED IN PART — see `docs/hosted-execution.md`.** The "hosted ⇒ off,
> always" rule below was never really about custody: a hosted container has no
> display, no Chromium and no browser profile belonging to the person whose
> account it is, so the only browser it could have driven was nobody's. A
> **remote browser provider** (`TREVRA_BROWSER_PROVIDER=remote`) supplies that
> missing piece, and hosted execution is now allowed — for a workspace that has
> recorded an explicit authorisation, on a seat with its own residential proxy,
> behind every gate below unchanged. A hosted deployment with no provider
> refuses exactly as this section describes, with the same sentence. The
> expression in 4.3 and the production validator have both been updated; the
> paragraphs that follow are kept as the record of what the rule was and why.

A **hosted** Trevra instance must never be able to enable this — that would reintroduce multi-tenant custody and put the rest of the product behind the same exposure. That half is unchanged and unconditional: `TREVRA_DEPLOYMENT_MODE=hosted` forces it off and no other variable can undo that.

**The same gate, unconditionally, on credential custody (§4.1 Path B).** Hosted refuses to _store_ a LinkedIn password and refuses to _open_ one it somehow inherited. One operator holding their own password is a small, informed, self-inflicted risk they have already accepted by using the product. A multi-tenant service holding many humans' LinkedIn passwords is a different product with a different threat model, and the answer is one sentence that ends the conversation rather than a switch to go and look for.

The _other_ half — "and off by default everywhere else" — was wrong, and has been inverted. `TREVRA_LINKEDIN_LOCAL` was specified as opt-in on the theory that an operator should have to ask for browser automation. But the gate above already means the only deployment that can run it at all is a self-hoster automating **their own account on their own machine**, with no credential in Trevra at any point (§4.1). An opt-in flag therefore protected nobody: it was a checklist step between a self-hoster and a feature that was already theirs, and — worse — the UI's advice to set it pointed at a container path where nothing could ever work (§4.9).

Current rule, in `src/server/config.ts`:

```ts
// AS SPECIFIED (superseded):
enabled: env.TREVRA_DEPLOYMENT_MODE !== 'hosted' && env.TREVRA_LINKEDIN_LOCAL !== 'false';

// AS SHIPPED (docs/hosted-execution.md): a hosted deployment with a remote
// browser has something to drive. Per-workspace authorisation is a separate
// gate (`hostedExecutionGate`) enforced at the credential store and at the
// runner, because it is a per-tenant fact and config.ts reads only the env.
enabled: (env.TREVRA_DEPLOYMENT_MODE !== 'hosted' || remoteBrowserConfigured(env)) &&
  env.TREVRA_LINKEDIN_LOCAL !== 'false';
```

Hosted ⇒ off, always. Otherwise on, unless a self-hoster explicitly sets `false`. `hosted` is carried alongside `enabled` so a refusal can say _which_ kind of off it is: "switched off" has a fix, "hosted" does not, and telling someone to go and find a switch that does not exist is the dead end this removes.

The production validator still refuses `TREVRA_LINKEDIN_LOCAL=true` together with `TREVRA_DEPLOYMENT_MODE=hosted` out loud, rather than silently ignoring it — an operator who set both meant something by it.

#### 4.4 Dependency handling

`playwright` is **not** currently a dependency, and a hard dep adds ~400MB to the Oracle image and breaks the Cloudflare marketing build. Add it as an **optional dependency**, loaded by dynamic `import()` inside the worker only. If absent, the worker logs a single actionable line (`playwright not installed; run npm i -D playwright && npx playwright install chromium`) and stays disabled — it must not crash the process.

#### 4.5 Files

- **`src/server/linkedin/driver.ts`** — Playwright routines, one per action kind: `sendInvite(page, target, note?)`, `sendDm(page, target, body)`, `viewProfile(page, target)`. Each returns `{ok, externalRef?, failureKind}` where `failureKind ∈ 'not_found'|'already_connected'|'limit_wall'|'challenge'|'selector_drift'|'unknown'`. **`limit_wall` and `challenge` immediately set seat posture to `cooldown` and halt the batch** — those are LinkedIn telling us to stop, and continuing past them is what escalates a temporary restriction into a permanent one.
- **`src/server/linkedin/local-worker.ts`** — the loop: claim due `linkedin_actions` where `status='planned' AND planned_for <= now`, re-run `evaluateLinkedInSafety()` **per action immediately before execution** (never trust the plan alone — same discipline as `assertPostingWindow()` in `publish.ts`), execute via driver, record outcome. Claim-before-act, only definite failures release, matching the `outreach_posts` idempotency pattern.
- Wire into `src/worker/index.ts` behind the §4.3 gate.
- **`migrations/024_linkedin_local_worker.sql`** — add `stop_requested_at` to a `linkedin_batches` table (mirror `021_agent_run_stop.sql`), plus `failure_kind` on `linkedin_actions`.
- **`src/server/secrets/linkedin.ts`** — §4.1 Path B: `putLinkedInCredentials`, `describeLinkedInCredentials`, `deleteLinkedInCredentials`, `readLinkedInCredentials`, `maskEmail`. The hosted gate and the write-only rule live here, not in the routes.
- **`migrations/028_linkedin_seat_credentials.sql`** — added `linkedin_seats.auth_mode` (`'manual'|'credentials'`, CHECK-constrained, default `'manual'`) and `linkedin_seats.session_valid_at`. **No password column, and there must never be one.** `auth_mode` itself is now vestigial (§4.1 amendment, 2026-08-06): the app no longer reads or writes it, and every seat behaves as `'credentials'` regardless of what the column says.
- **`Dockerfile.dev`** — `npx playwright install --with-deps chromium`. Chromium only: firefox and webkit would add ~700MB to an image that will never drive either. Without this line the container can plan, pace and gate but perform nothing, and every detect is queued for a host worker.

#### 4.6 Guard invariants

- The worker **cannot bypass pacing.** `evaluateLinkedInSafety()` runs per action, not per batch.
- Kill switch: seat posture `paused` stops the loop within one tick; `stop_requested_at` mirrors the existing `stopRunningAgentRuns()` pattern.
- Human approval: a batch enters `planned` only through the `gtm.linkedin-outreach` playbook approval step, payload-hash-bound as in §4 Phase 3. The worker executes approved bytes only.
- Randomized inter-action delay from `ACTION_GAP_SECONDS`, seeded deterministically (§4 Phase 2 step 6) — still no `Math.random()`.

#### 4.7 Bonus: closes the outcome-ingest gap

In local mode the worker can read invite/reply state directly, so `linkedin_actions.status` advances to `accepted`/`replied` **automatically**. That feeds the acceptance-rate throttle with no paste-back and no CSV re-import — which resolves open question §7.2 for self-hosted users and makes the §1.3 `MIN_ACCEPTANCE_RATE` loop actually closed-loop.

#### 4.8 Deferred

Aggregator adapters (Unipile / HeyReach) are **dropped**, not deferred — they solve a hosted-SaaS problem this project does not have. Revisit only if a hosted Trevra offering ships.

#### 4.9 Where the browser actually runs — the container/host split

**The blocker this section exists for.** Trevra's dev and self-host stacks run in Docker (`compose.dev.yml`, service `trevra`). Inside that container `DISPLAY` is empty, `~/.cache/ms-playwright` does not exist, and `resolveProfileDir()` returns `/root/.trevra/linkedin-profile` — a path on a filesystem the operator never sees. §4.1 requires a **headed** Chrome that a human logs into by hand. None of that can happen in the container, ever. Telling the operator to "log in at `/root/.trevra/linkedin-profile`" was advice with no ending.

The fix is not to put a browser in the container. It is to accept that **the API and the browser run on different machines**, and to make that split explicit, detectable, and short to explain.

**The probe.** `linkedInBrowserReadiness(config)` in `local-worker.ts` answers "could this process open a headed Chrome?" without opening one — because it feeds a status endpoint, and a status endpoint that launches Chrome is a status endpoint that hangs. It checks, in order: the deployment gate; whether `playwright` resolves; whether a Chromium build exists in Playwright's registry directory (derived from `PLAYWRIGHT_BROWSERS_PATH` or the platform cache, never by importing playwright); and, on Linux, whether `DISPLAY` or `WAYLAND_DISPLAY` is set — the decisive signal. Containerisation (`/.dockerenv`, or docker/containerd in `/proc/1/cgroup`) is **context, not a verdict**: it is emitted alongside a real blocker because it is the fact that explains the others, and a container with a forwarded display can genuinely run this. Fails closed: anything undetermined is not ready.

Every entry point consults it before touching the database, so the containerised worker costs nothing and — critically — never claims work away from the machine that could do it.

**The one host-side command.**

| Command                   | What it does                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run linkedin:worker` | Runs the same loop `src/worker/index.ts` runs (`runPendingSeatDetectRequests`, then `runDueLinkedInActions`) on the host, against `DATABASE_URL`. No second implementation of pacing, claiming or the safety gate — only a different place to run, useful whenever a display is available: headed wins over headless whenever it can. |

It refuses to start rather than looping uselessly, and names `npx playwright install chromium` when that is what is missing. `DATABASE_URL` points at the Postgres the stack already publishes on `${TREVRA_DB_PORT:-45432}`.

**The headless probe, and why the split can now close.** `linkedInHeadlessReadiness(config)` is the same probe minus the display check, because that is the entire difference: a headless browser needs a binary and nothing to draw on. With `npx playwright install --with-deps chromium` in `Dockerfile.dev`, the container's headed answer is still no and its headless answer is yes.

**Every seat can use it.** Since every seat signs itself in with stored credentials (§4.1 amendment, 2026-08-06), a headless browser is usable by any workspace's seat, not a subset — it opens its own session and shows no human a login form because none is needed. `runPendingSeatDetectRequests` still keeps its headed-only gate, so the detect queue stays exclusively the host worker's.

**Detection across the split.** `POST /api/linkedin/seat/detect` used to call `detectLinkedInSeat` in-process. It now branches on the probe:

- **Can launch headed** → in-process detect, exactly as before; `200 {status:'detected', …}`.
- **Cannot launch headed, seat has credentials, headless available** → in-process detect **anyway**, headlessly, signing in first if the stored session has expired. `200`. _No host-side worker, no second machine, nothing for the operator to run — they typed an email and a password once and have done nothing since._
- **Cannot launch headed, no credentials yet (or headless unavailable)** → the request is _queued_ for the host worker and answered `202 {status:'pending', requestedAt, message}`. The client keeps polling `GET /api/linkedin/seat`, which now also returns `detectRequest` — so a detect that **failed** reaches the operator instead of leaving the screen spinning.
- **Hosted or switched off** → `409`, one sentence.

The queue is `linkedin_seat_detect_requests` (migration 027), with the same claim-before-act shape as `linkedin_batches` and a **partial unique index on `(workspace_id, seat_key) WHERE status='pending'`** as the replay guard — pressing Connect five times produces one request, enforced by the database rather than remembered by a route. One difference from an invite, and it is deliberate: the claim here is **reclaimable after ten minutes**, because a detect is a pure read. Re-running one duplicates nothing in anybody's notifications, so the failure to protect against is a wedged setup screen, not a duplicate invite.

**Message register.** Server-side LinkedIn refusals are **one imperative sentence, plus at most one command**. The explanation lives here, in this document, not in an error string, and no user-facing string names `TREVRA_LINKEDIN_LOCAL` — it defaults correctly now, and naming it is noise between the operator and the thing they have to do.

> Connect your computer with the LinkedIn companion and sign in in the dedicated Chrome profile.
> On hosted Trevra, LinkedIn browser work runs through that paired computer; without a companion or an explicitly configured execution home, new browser work stays queued.

---

## 4A. Feature diff vs Dripify / Waalaxy / Expandi

What "complete solution" actually requires. Phases 1–4 cover the engine; this table is the honest remainder.

| Capability                                            | Dripify / Waalaxy / Expandi     | Trevra after Ph.1–4            | Gap → phase                   |
| ----------------------------------------------------- | ------------------------------- | ------------------------------ | ----------------------------- |
| Per-day action caps                                   | yes                             | yes                            | —                             |
| Randomized delays                                     | yes                             | yes (seeded, reproducible)     | —                             |
| **Cross-day variance smoothing**                      | **no**                          | **yes**                        | _we win_                      |
| **Warm-up ramp from account age**                     | partial (manual)                | **yes, automatic**             | _we win_                      |
| **Acceptance-rate auto-throttle**                     | no                              | yes                            | _we win_                      |
| **AI sequence/copy generation**                       | templates + spintax only        | yes (anti-slop pass)           | _we win_                      |
| **Native CRM write-back**                             | Zapier/webhook only             | yes (HubSpot/Attio)            | _we win_                      |
| Campaign builder w/ branching                         | yes (if accepted → X, else → Y) | no                             | **Ph.6**                      |
| Lead import: CSV                                      | yes                             | no                             | **Ph.5**                      |
| Lead import: LinkedIn/Sales Nav search URL            | yes                             | no                             | **Ph.7** †                    |
| Lead import: post likers / commenters / group members | yes                             | no                             | **Ph.7** †                    |
| Unified inbox / conversation view                     | yes                             | no                             | **Ph.7**                      |
| Analytics funnel (sent → accepted → replied)          | yes                             | data exists, no view           | **Ph.6**                      |
| **Withdraw pending invites**                          | yes                             | no                             | **Ph.7** — matters, see below |
| Exclusion / blacklist list                            | yes                             | no                             | **Ph.5**                      |
| Spintax + A/B template testing                        | yes                             | no                             | **Ph.6**                      |
| Extra actions: endorse, follow, like                  | yes                             | driver has invite/dm/view only | **Ph.7**                      |
| Working-hours + timezone config                       | yes                             | in `limits.ts`, not editable   | **Ph.6**                      |
| Team / multi-seat                                     | yes                             | deferred (§7.1)                | later                         |

† **Note the posture shift.** Sending is _automation_ under §8.2. Lead import from a search URL or a post's engagers is _scraping_ — a separate, more specifically-named clause, and the one hiQ litigated. Self-hosted operator posture still applies, but it is a distinct risk from sending and should be a distinct opt-in toggle, not bundled.

**Invite withdrawal is worth prioritising.** Pending invites count against the weekly cap. Without withdrawal, a low-acceptance campaign silently consumes the operator's entire invite budget with dead requests — and low acceptance is itself the §1.3 ban signal. Auto-withdraw after N days (default 21) is both a capacity feature and a safety feature.

---

## 5. HTTP API surface (Phase 5) — the missing layer

Phases 1–4 expose skills, playbooks and a worker. **No REST routes exist**, so no UI can drive them. All routes mount in `src/server/app.ts`, workspace-scoped, following the existing auth + error conventions there.

```
GET    /api/linkedin/seat                  → seat + posture + warm-up week + today's counts + auth block
PUT    /api/linkedin/seat                  → upsert (timezone, account_opened_on, connections_count)
POST   /api/linkedin/seat/pause            → {reason} kill switch
POST   /api/linkedin/seat/resume
POST   /api/linkedin/seat/detect           → {timezone}; read the seat out of the live session
POST   /api/linkedin/seat/credentials      → {email, password} → {hasCredentials, maskedEmail}. NEVER echoes the password.
DELETE /api/linkedin/seat/credentials      → wipes stored credentials; nothing can sign this seat in until new ones are saved
POST   /api/linkedin/seat/login            → {otp?} → {status:'ok'|'otp_required'|'challenge'|'failed', message}

GET    /api/linkedin/limits                → effective ceilings + which rule bound each (provenance)
(POST   /api/linkedin/plan removed — the Plan-preview screen it served is gone)
GET    /api/linkedin/actions               → filter by status/kind/date; the queue view
POST   /api/linkedin/actions/:id/skip
POST   /api/linkedin/actions/outcome       → manual outcome ingest (resolves §7.2 for export mode)

GET    /api/linkedin/campaigns
POST   /api/linkedin/campaigns             → runs gtm.linkedin-outreach playbook
GET    /api/linkedin/campaigns/:id
POST   /api/linkedin/campaigns/:id/export  → {format} → CSV download
POST   /api/linkedin/campaigns/:id/stop    → sets stop_requested_at

(POST   /api/linkedin/targets/import removed — the Target-accounts screen it served is gone)
GET    /api/linkedin/exclusions            → blacklist
POST   /api/linkedin/exclusions

GET    /api/linkedin/analytics             → funnel: planned→sent→accepted→replied, by campaign + 30d series
GET    /api/linkedin/worker/status         → local worker enabled? playwright present? profile logged in?
```

Plus **`migrations/025_linkedin_campaigns.sql`**: `linkedin_campaigns` (id, workspace_id, name, status, sequence_json, created_at) and `linkedin_exclusions` (workspace_id, target_ref, reason) with the usual partial-unique replay guards.

**Invariant: no route may write `linkedin_actions.status='sent'` directly.** Only the worker or an explicit outcome-ingest call may. The API plans and approves; it never sends.

**Invariant: the LinkedIn password is write-only over the wire.** `POST /api/linkedin/seat/credentials` takes it and answers `{hasCredentials, maskedEmail}`; `GET /api/linkedin/seat` carries `auth: {hasCredentials, maskedEmail, sessionValidAt}` and nothing more. There is no reveal route, for anyone, at any privilege level — the same rule the model key has had since day one (`docs/byok-and-hosted-agent.md` §3). `POST /api/linkedin/seat/login` answers 200 for all four statuses, because a client distinguishing "needs a code" from "wrong password" should read a field, not a status code; `otp_required` means _ask the operator for the code and call this again with it_.

---

## 6. UI (Phase 6)

New `LinkedInScreen` in `src/client/`, following the existing `App.tsx` / `styles.css` patterns (no new UI framework; `lucide-react` is already a dep).

1. **Setup** — seat: timezone, account-opened date, connection count, posture badge. Local-worker status: playwright present, headless Chromium available, signed-in check. Big red pause switch, always visible.
2. **Safety** — the differentiator, make it the loudest screen. Today's ceilings and _which rule bound each_, warm-up week N of `WARMUP_WEEKS` (**3** — wk1/wk2/wk3 are the ramp, wk4+ is full band; the UI must render the server constant, not a hardcoded number) with the ramp curve, 30-day actual-volume chart with the ±35% variance band drawn on it, live acceptance rate against the 30% throttle line. Every number links to its §1.3/§1.4 source and confidence tag.
3. **Campaigns** — list + detail. Sequence editor (day, action kind, template, variables), branching on accepted/replied, spintax + A/B variants. "Generate with AI" calls `gtm.linkedin-sequence`.
4. **Plan preview** — calendar of the next N days showing exact slots before approval. This is the approval payload; approving binds its hash (§4 Phase 3).
5. **Queue** — `linkedin_actions` table, filterable, per-row skip, manual outcome marking for export mode.
6. **Analytics** — funnel + per-campaign acceptance/reply, 30-day series.
7. **Exclusions** — blacklist management.

**UI honesty rule, consistent with `channels/adapters/*.ts`:** wherever a limit is shown, show its confidence tag. The InMail 50/month is HARD FACT; every other number is REPORTED practitioner consensus. Never render a REPORTED number as a guarantee — the operator is betting their account on it and deserves to know which is which.

---

## 6A. Phase 7 (later) — parity remainder

Invite withdrawal (auto after 21d), unified inbox, endorse/follow/like driver actions, lead import from search URL / post engagers / group members. The import items carry the §4A † scraping posture and need their own opt-in toggle separate from sending.

---

## 5B. Dripify specifically — do we need it?

**We do not integrate it. We target it as an export format** — and, per the
§0 amendment, we now also replace it for our own operator. Export stays for
users who already pay for a tool; it stops being the only way to send.

- Dripify is a browser extension driving the user's own LinkedIn session, $49–$149/mo/account. No public API, limited white-label. There is nothing for us to call.
- Its value to a Trevra user is the sending arm; ours is the plan. Export CSV → they run it → they paste outcomes back.
- Same treatment for Expandi ($99–$299/mo, dedicated IP per account, agency white-label) and Waalaxy. HeyReach and Unipile are the only two with a real API, which is why they are the Phase 4 candidates and Dripify is not.

**What you need to actually do this:** nothing purchased. Users bring their own tool and their own LinkedIn account. Our cost is engineering only.

---

## 6. Sequencing and effort

| Phase | Deliverable                                                                                       | Est.  |
| ----- | ------------------------------------------------------------------------------------------------- | ----- |
| 1     | `022` migration, `seats.ts`, `actions.ts` + tests                                                 | 1–2 d |
| 2     | `limits.ts`, `pacing.ts`, `guard.ts`, 2 skills + tests                                            | 3–4 d |
| 3     | `sequence.ts`, `export.ts`, playbook, `023` migration, outcome ingest                             | 3–4 d |
| 4     | local Playwright worker: `driver.ts`, `local-worker.ts`, `024` migration, mode gate, optional dep | 4–6 d |
| 5     | HTTP routes in `app.ts`, `025` migration (campaigns + exclusions), CSV import                     | 2–3 d |
| 6     | `LinkedInScreen`: setup, safety, campaigns, plan preview, queue, analytics                        | 4–5 d |
| 7     | parity remainder: withdrawal, inbox, extra actions, lead import                                   | 5–7 d |

Phases 1–3 ship a complete, defensible product with zero LinkedIn ToS exposure for Trevra.

---

## 7. Open questions

1. ~~Seat model scope~~ — **DECIDED: one seat = workspace owner.** `linkedin_seats` is keyed by `workspace_id` alone; no cross-seat staggering in `pacing.ts`. The agency/N-seat case (2–4h multi-account gap rule) is deferred; keep `seat_key` in `linkedin_actions` so the ledger does not need a rewrite if it arrives.
2. **Outcome ingest UX** — paste-back, CSV re-import, or both? Determines whether the acceptance-rate loop is realistically fed. **Only applies to export mode**; Phase 4 local worker reads outcomes directly (§4.7).
3. **Do we surface the reported-vs-official confidence in the UI?** Recommend yes — it is consistent with the honest `automation.reason` pattern and it is a trust asset.
