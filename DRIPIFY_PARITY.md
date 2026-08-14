# Dripify parity — Trevra LinkedIn outreach manager

Audited 2026-08-14, then closed. This file is the record of both: what was missing, and what now exists.

Verdict scale: **DONE** = works end to end from the UI · **PARTIAL** · **MISSING**.

---

## What was actually wrong

The schema and the pure logic were largely built and tested. **The runtime was not.** Four functions were imported in `src/server/app.ts` and never called (`importLeadCsv`, `startManagedCampaign`, `pauseManagedCampaign`, `completeManualTask`); nothing inserted manual tasks; nothing wrote `linkedin_actions.workflow_step_id`. So every lead list was permanently empty, every campaign sat in `draft` forever, and the analytics query filtered on a column no writer produced.

That is now closed. The list below is the current state.

---

## 1. LinkedIn integration

| Spec | State | Where |
|---|---|---|
| Connect a LinkedIn account | **DONE** | Per-account sign-in: credentials → login → OTP → challenge → detect, with the 202 "your own worker will pick this up" path. `LinkedInAccounts.tsx`; routes `app.ts` `/api/linkedin/seat*`, now all seat-scoped. |
| Without being blocked | **DONE** | Detection was already strong (`driver.ts` checkpoint + restriction regexes → release claim → cooldown → halt batch, manual resume). Prevention added: deterministic per-account userAgent/locale/timezone (`seatContextFingerprint`), per-account browser profile dir, optional per-account outbound proxy (`resolveSeatProxy`, hard-refuses rather than falling back to a direct connection), and human-cadence credential typing replacing instant `.fill()`. |
| Randomize + space actions | **DONE** | `pacing.ts`: even grid over the account's own window + seeded jitter + enforced minimum gap; send-time gap in the worker; per-click jitter in the driver. All PRNG seeded — replayable, never `Math.random()`. |

## 2. Workflow builder — **DONE**

All six actions execute. The new `src/server/linkedin/runner.ts` is the missing runtime: it advances `step_index`, honours each step's delay, plans `linkedin_actions` rows carrying `campaign_member_id` / `workflow_step_id` / `variant_id`, and creates manual tasks.

| Action | State | Notes |
|---|---|---|
| Connection request ± note | DONE | Renders the note through the merge fields; 300-char counter in the builder. |
| Withdraw if unaccepted after X days | DONE | `afterDays` now reaches `withdraw.ts` via `selectWithdrawalCandidates({olderThanDays, actionIds})`. A not-yet-stale invite holds the member on the step with `next_eligible_at` set to the moment it goes stale; an accepted one advances immediately. |
| Profile view | DONE | |
| Send message + A/B | DONE | `chooseMessageVariant` assigns from a `member:step` seed — stable across retries — and the choice is persisted in `assigned_variants` and stamped on the ledger row as `variant_id`. Weights are editable in the UI. |
| Manual message (stops the workflow) | DONE | Inserts a `linkedin_manual_tasks` row, member goes `manual`, nothing advances until `completeManualTask`. Routed at `POST /manager/tasks/:id/complete`, actionable from both the inbox and the campaign screen. |
| Follow | DONE | |
| Delay in hours or days | DONE | Every step, not just the first. `next_eligible_at = plannedFor + delayBefore(next step)`. |
| Variables first/last/company | DONE | Rendered at plan time; insert buttons + live preview against a sample lead in the builder; unsupported variables flagged before save. |

Builder UI rebuilt: numbered timeline with cumulative "Day 3, +2h", reorder (buttons + drag), per-action add, A/B weights with a split bar, merge-field insertion at the caret, character counters, starter templates, inline per-step validation. The step-id collision bug (remove-then-add regenerating a live id → server 400) is fixed.

## 3. Upload leads — **DONE**

| Path | State | Notes |
|---|---|---|
| Basic LinkedIn search link | DONE | Real Playwright walk with pagination and wall detection. |
| Sales Navigator link | DONE | New `salesNavigatorUrlFor` + `scrapeSalesNavigatorResults` over a shared result-list walker — its own selectors and page parameter, because it is a different product on the same host. |
| CSV upload | DONE | `POST /manager/lead-lists/:id/import` now persists through the same parser the preview uses. |

Field automatch was already complete (alias table, normalized headers, required-trio enforcement at both mapping and row level). What was missing was the UI: there is now a real column mapper — every field, the header automatch chose, a select to override it, live re-preview, and the rejected rows with reasons.

Scraped leads reach campaigns: `importLeadSourceContacts` materialises a walk into a `linkedin_lead_lists` + `linkedin_lead_contacts` list, scrubbed and name-split like the CSV path.

## 4. Data scrubber — **DONE**

All 33 spec tokens, whole-token and case-insensitive (so `Maya` and `Mason` survive), emoji via NFKC + `\p{Extended_Pictographic}`, `[.,?!]` stripped, apostrophes and hyphens kept.

The gap was placement, not coverage: it ran only on CSV import. `splitAndScrubName` is now exported and runs on every scraped lead too, on both the driver and the storage path. The mapper UI shows before/after pairs so `Dr. Jane Smith 🙂 → Jane Smith` is not a surprise.

## 5. Rules to protect the account — **DONE**

| Spec | State | Notes |
|---|---|---|
| Working days + hours | DONE | The planner ignored them and planned slots the gate then refused — a silent stall. `planPacing` now reads `workingDays`/`workStartMinute`/`workEndMinute` in the account's timezone, and planner and gate share one predicate (`weekdayVolumeFactor`) so they cannot disagree. A configured Saturday is no longer vetoed by `WEEKEND_FACTOR`. |
| Invites 30 (0–75) | DONE | DB CHECK + zod + `min(band.perDay, operatorLimit)` in the gate. |
| Messages 25 (0–75) | DONE | Pooled across dm/reply/inmail, as the gate counts them. |
| Profile views 25 (0–100) | DONE | |
| Follows 20 (0–50) | DONE | |
| Campaign warm-up 20/40/60/80/100 | DONE | Was correct code with zero callers. Now enforced twice: as a budget in the runner before anything is planned, and as a `campaign-warmup` check in the gate before anything is performed. The per-account weekly ramp still applies; the stricter of the two binds. |
| A lead in only 1 campaign | DONE | The partial unique index held, but contacts deduped per-list, so the same person in two lists got two ids and two campaigns. Migration 048 adds a workspace-wide unique index on `LOWER(profile_url)`, de-duplicating existing data oldest-wins and repointing campaign members first. |

## 6. Campaigns — **DONE**

| Spec | State |
|---|---|
| Lead list + workflow + name | DONE — guided create showing which account sends, how many leads enrol, and how long the sequence runs end to end. |
| Start / stop | DONE — Start, Pause, Resume, Stop, with Stop behind a confirm because it is terminal. |
| Connected to the LinkedIn inbox | DONE — real per-account sync. |
| Answer messages in the tool | DONE — replies queue and the UI now reports where each one is: waiting to send, due now, sending, delivered, or held back by a safety limit (message shown verbatim). Execution stays on the operator's own worker, which is the honest boundary. |
| Remove a lead | DONE |
| Pause **or continue** a lead | DONE — the route hardcoded `true`; it now takes the boolean and there is a resume control. |
| Manual tasks in the inbox | DONE — first-class inbox items with a composer, with "queue this message" and "mark as sent" kept separate so Trevra never claims to have sent bytes it did not send. |

Also: per-lead timeline (steps done / current / next fire time / assigned variant), member search + status filter + sort + paging, per-campaign progress by status, warm-up day, and a "Run now" that ticks the runner immediately.

## 7. Analytics — **DONE**

All five counters plus both percentages, and they now have a writer. Added campaign, account and time-window (7/30/90/all) filters — the endpoint always accepted them and the UI passed none. Acceptance is labelled "of invites sent" so it cannot be confused with the legacy screen's accepted-of-decided rate. A/B variants show bodies, reply rate and a leader, with an explicit "not enough data" state instead of implying significance from three sends.

## 8. Team / multi-account — **DONE**

Was schema-deep and runtime-shallow: the worker filtered `AND seat_key='owner'`, credentials had no seat dimension, one shared browser profile, and no UI to add a second account at all.

Now: per-account discovery/claim/batch/cooldown, per-account credentials (`linkedin_seat_credentials`, same AES-256-GCM custody, same unconditional hosted refusal, owner rows deliberately unmoved so nothing pre-existing can fail to resolve), per-account profile directory and browser handle, per-account inbox and limits. `LinkedInAccounts.tsx` adds, connects, switches, edits, pauses and disconnects accounts; `useActiveSeatKey` carries the active one across screens. Both worker loops iterate seats.

## 9. Leads from posts and comments — **DONE**

Was people-search only. Added a content-search path over `/search/results/content/`: keywords → matching posts → the author (`post`) and each commenter (`comment`), keeping the post URL and the interaction type per lead. Names are split into first/last and scrubbed. A workspace-wide **daily lead cap** (default 100, 0–1000, rolling 24h, counted from stored rows) stops a run cleanly rather than throwing.

## 10. UX

- **One product, one name.** Outreach is now Account · Find leads · Campaigns · Inbox, with the legacy sequence/approve/export path kept and marked as the deeper route. Two surfaces both called "campaigns" was how an afternoon got spent configuring the wrong one.
- **De-jargoned.** ledger, slot, payload hash, playbook run, paced kind, posture, band, seat, enforcement-scan day, and rendered `docs/*.md` paths are gone from user-facing copy — replaced with what each means for the operator's account. Every number, refusal and guarantee kept.
- **Onboarding rewritten** for the real path: connect an account → set hours and limits → build a lead list → build a workflow → create and start a campaign → answer replies. Steps with no detectable signal are shown as instructions rather than given an invented one.
- **The safety screen answers its own question**: per account, the single binding constraint right now and when it lifts, then the ceilings, then the evidence.

---

---

# Second pass — the parity that was claimed but not delivered

The table above was written after the first close. A four-way audit then read the
code against it — execution chain, lead pipeline, limits vs the brief's numbers,
and every control on every outreach screen — and found **47 defects**: places
where the feature existed, the tests passed, and the product still did not do
what the screen said it did. All 47 are fixed. What follows is what was wrong,
because a parity list nobody can check is a claim rather than a record.

## Execution — the ledger moved, the browser did not

- A gate-refused action was released but never deferred, and the claim orders by
  `planned_for ASC` — so the same row came back every iteration and one refusal
  burned an entire pass at 30-120s a turn. A campaign stopped sending with no
  error anywhere.
- `duplicate-target` matched on (workspace, seat, kind, target) and ignored
  `replay_scope`, which the runner had deliberately widened per `member:step`.
  Only the FIRST message of a multi-message sequence could ever send; the second
  was refused forever, and then livelocked the batch via the defect above.
- Nothing checked acceptance before a message step: the worker's branch parser
  required steps keyed `kind` while managed workflows write `action`, so it
  found no conditions and ran. The driver then found no Message button on a
  non-connection, called it selector drift, and halted the whole seat's batch —
  one lead who never accepted wedged everything, logged as a fake drift.
- Withdrawals ran with `seat_key='owner'` hardcoded: a paused secondary account
  kept withdrawing, and a limit wall on a secondary cooled the owner instead.
- The unattended sweep withdrew every pending invite at 21 days, whatever the
  workflow's `afterDays` said.
- The pre-send gate never received `campaignId` (the claim did not even select
  it), so the 20/40/60/80/100% campaign ramp always took the "no campaign was
  named" branch and passed. The ramp existed at plan time only.
- Replies filed under the `'legacy'` replay scope: one reply per (seat, target)
  for the life of the ledger, so a second reply in the same conversation was a
  permanent 409.
- `enqueueReply` resolved threads without a seat key, so a secondary account
  could answer into the owner's conversation.
- `override_warmup_ceiling` (migration 044) was a column whose own COMMENT
  described a feature no code read or wrote. It is now implemented as documented
  — reply-only, relaxes the warm-up ceiling alone, every other check still runs.

## The numbers the brief actually specifies

The brief's ceilings are 30 invites (0-75), 25 messages (0-75), 25 profile views
(0-100), 20 follows (0-50). Trevra's own researched bands are stricter — 18
invites, 12 DMs, 3 InMails — and silently `min()`'d the operator's number, so an
operator who set 30 got 18 and was never told. That is now an explicit choice:

- **`safety_band_override`** (migration 050, per account, off by default). Off,
  Trevra's researched band binds and the screen says so. On, the operator's own
  configured number binds — bounded by the brief's ranges, with both numbers
  stated at the point of decision. Both warm-up ramps still multiply whichever
  ceiling binds; the override lifts the band, never a ramp.
- The runner budgeted campaigns off the RAW operator limit while the gate ramped
  off `min(band, operator)` — it planned 30 invites the gate then refused at 18,
  and members stalled with no visible cause. Both now use one function.
- `planPacing` consulted no operator limit at all: `/api/linkedin/plan`
  scheduled 18 invites a day for an operator who had set 5.
- The messages ceiling is one POOL over dm+reply+inmail, but it was compared
  against a PER-KIND band, so an InMail collapsed the whole pool to 3: three DMs
  blocked every InMail that day. Pool and band are now two independent checks.
- `/api/linkedin/limits` reported a ceiling the pacer would not honour.
- A safety screen that recombined those numbers itself rendered band 18 +
  setting 5 as **1**.

## Campaigns

- **Pause did not pause.** It touched only the campaign row; every action
  already scheduled for the coming days stayed claimable and still went out.
  Unclaimed rows are now parked as `held` and restored on resume, same ids, same
  slots (migration 051).
- Completing a manual message ignored the next step's delay, so "manual message
  → wait 3 days → follow-up" fired the follow-up on the next tick. It could also
  mark the task done while the member never left the manual state — the task
  vanished and the lead stopped forever.
- An invite still sitting in the queue was dated by `planned_for`, so its member
  advanced PAST the withdraw step without withdrawing anything.
- Contacts imported into a running campaign's lead list were never enrolled.
- The runner loaded the workflow LIVE, so editing a workflow rewrote the
  sequence of every campaign already running on it — while the screen said the
  opposite in so many words. Campaigns now execute the snapshot they were
  started with; an edit reaches them on restart, and the screen says which
  version each is running.
- Analytics had no follows and no withdrawals column: two of the six workflow
  actions reported zero forever.

## Leads

- Deleting a lead cascaded away their campaign membership but left their planned
  invite to fire at them anyway.
- The scrubber stripped `.,?!` BEFORE tokenising, so `Ph.D.` became `Ph D` and
  matched nothing — the screen promised PhD/MBA/MSc were removed while the row
  stored "Chen Ph D". Flag emoji survived for the same class of reason.
- It also ran the 33-token table over dedicated name columns, so it emptied real
  surnames — `Anh Do`, `Yo-Yo Ma`, anyone named Ba, Bs, Sr or Lion — and then
  rejected the row as missing a last name. A scrub can no longer empty a name.
- Scrape paths stored names raw under a comment claiming every path was
  scrubbed. Post and comment leads had `company: null` hardcoded (the brief
  requires it), and post reactors carried no interaction type at all.
- A lead could only be in one LIST — the brief constrains one CAMPAIGN. Importing
  500 into a new list when 200 already sat in an older one silently produced a
  300-row list. Membership is now its own table (migration 052).
- Email-only leads deduped per list, so the same person in two lists was two
  contact ids and the one-active-campaign index saw two different people.
- The daily lead cap read-then-wrote with no reservation and overshot under
  concurrency; it now holds under an advisory lock.
- Email, phone and country were parsed, stored, displayed — and reachable by no
  merge field. They are now fields, alongside camelCase aliases for the three
  the legacy path documents.

## Approvals and the send path

- `approvedCampaignPayload` checked that an approval payload EXISTED. A step
  sitting at `waiting_approval`, and a step a founder had REJECTED, both carry
  one — so a campaign nobody decided on could be exported and, once the worker
  route landed, queued as real planned rows. It now requires the step to have
  completed AND an `approve` decision for that exact payload hash.
- `POST /api/linkedin/campaigns/:id/queue` had no client function at all: the
  self-hosted worker this product ships was unreachable from the UI, and a
  campaign could only be exported to a competitor's tool.

## What the screens claimed

Roughly forty controls were dead, wrong or lying: an account switcher that
changed nothing anywhere; "Queue this message" permanently grey on every manual
task; five of the six actions unable to be a workflow's first step; a volume
chart counting replies three times; an A/B panel resolving step ids across
workflows and rendering another campaign's copy; a resume drawer demanding a
reason no route accepted; an export format that overrode the one approved;
selection counts beside a Save that ignored them; "The first 1,000 are shown"
over a 1,500-row list; hardcoded 75/100/50 ranges, a hardcoded 50-a-month
InMail quota, and a client-side re-implementation of the warm-up ramp that
showed 6 invites where 3 would go out. Every number a screen now prints comes
from the server that enforces it.

---

## Known limits

- Replies still execute on the operator's own machine via the local worker. That is the product's position, not a gap: a hosted server driving a browser signed into someone's account makes Trevra the automation operator under LinkedIn's User Agreement 8.2.
- Lead sourcing remains a separate opt-in, off by default and unavailable hosted, for the same reason.
- Trevra's researched bands remain the DEFAULT ceiling, stricter than the brief's numbers. `safety_band_override` makes the brief's numbers reachable per account, as an informed choice with both figures on screen; it is off until an operator turns it on.
- Inbox conversations page at a stated ceiling rather than a true count — the thread route returns rows and no total, so the screen states the ceiling instead of inventing "200 of N".
- The campaign-member status histogram is still one detail read per campaign (`lc-debt` marked; a server-side aggregate is the upgrade).
- Deleting a lead LIST has no route, and `linkedin_lead_contacts.list_id` still cascades — migration 052 documents what such a route would have to repoint first.
