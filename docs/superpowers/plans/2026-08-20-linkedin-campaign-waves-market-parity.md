# LinkedIn Campaign Waves + Market Parity Implementation Plan

> **Status:** implemented and regression-tested; four explicitly optional/conditional product items remain deferred
> **Research date:** 2026-08-20
> **Implementation audit:** 2026-08-20 — mandatory checklist items are backed by executable code/UI and the LinkedIn regression suite. Native LinkedIn voice notes remain deliberately unavailable because no verified desktop upload surface exists; that checklist item is complete as a feasibility/safety decision, not as a fake send path.
> **Scope:** Trevra Managed Campaigns / Managed Workflows, campaign admission, execution queues, waves, branching, market-parity campaign actions, campaign UX, analytics, and integrations.
> **Supersedes for future work:** the assumption in `DRIPIFY_PARITY.md` that campaign parity is mainly a linear per-lead sequence problem. That file remains useful as historical implementation evidence.

## Goal

Build Trevra's LinkedIn outreach manager around the model the mature market actually uses:

```text
CAMPAIGN AUDIENCE
      |
      v
PENDING / NOT YET ADMITTED
      |
      v
ADMISSION CONTROLLER
      |
      +------ Wave 1 / cohort
      +------ Wave 2 / cohort
      +------ Wave 3 / cohort
      |
      v
PER-LEAD WORKFLOW STATE
      |
      +------ warm-up queue
      +------ connection queue
      +------ monitor / condition queue
      +------ message / follow-up queue
      +------ fallback queue
      |
      v
DOWNSTREAM-PRIORITY SCHEDULER
      |
      v
SEAT DAILY BUDGETS + CAMPAIGN RAMP
      |
      v
LINKEDIN VISITS / LOCAL-WORKER BATCHES
```

The workflow defines **what one lead should experience**. Waves define **which cohort is admitted into the workflow**. Queues define **which step each lead is currently due for**. Browser batches / visits define **what is physically executed during one LinkedIn sitting**.

These concepts must stay separate in the data model and UI.

---

# 0. Current Trevra baseline to preserve

Do not rebuild functionality that already works.

## Managed Workflow primitives already present

- [x] Profile view.
- [x] Connection request with optional note.
- [x] Message step.
- [x] Up to four deterministic A/B message variants.
- [x] Manual message checkpoint.
- [x] Follow profile.
- [x] Withdraw stale pending invite.
- [x] Per-step delays in hours or days.
- [x] `requiresAcceptedConnection` special-case behavior for messages.
- [x] Stop a campaign member when an inbound reply is detected.
- [x] Workflow validation and stable per-step IDs.
- [x] Reusable workflow library and starter templates.
- [x] Campaign snapshots a workflow version so later workflow edits do not silently mutate a running campaign.

Primary code:

- `src/server/linkedin/workflows.ts`
- `src/client/LinkedInManagerWorkflowConfig.tsx`
- `src/server/linkedin/runner.ts`
- `src/server/linkedin/managed-campaigns.ts`

## Pacing / batching primitives already present

- [x] Per-kind seat ceilings.
- [x] Campaign warm-up ramp.
- [x] Working days / hours.
- [x] Per-seat pacing.
- [x] 2-3 modeled LinkedIn visits / sittings per day.
- [x] Actions distributed across visits rather than one continuous all-day metronome.
- [x] Local-worker `linkedin_batches` as physical execution passes.
- [x] Campaign runner processes due members in bounded planning batches (`MEMBER_BATCH`).
- [x] Action rows carry `campaign_member_id` and `workflow_step_id`.
- [x] Pause holds already-planned work instead of allowing the worker to keep sending.

Primary code:

- `src/server/linkedin/pacing.ts`
- `src/server/linkedin/limits.ts`
- `src/server/linkedin/runner.ts`
- `src/server/linkedin/local-worker.ts`
- `migrations/024_linkedin_local_worker.sql`

## Existing engagement capability to reuse

Trevra already has browser execution for:

- [x] Follow.
- [x] Like recent post.
- [x] Endorse skills.

Primary code:

- `src/server/linkedin/engagement.ts`
- `src/server/linkedin/driver-engage.ts`

Managed Workflows currently expose Follow but not Like or Endorse. Do not write duplicate drivers for those two actions; wire the existing execution path into the managed workflow system.

## Existing generalized branch engine to reuse / converge

Trevra already has a branch vocabulary in `src/server/linkedin/branching.ts`:

- `accepted`
- `replied`
- `not_accepted`
- `not_replied`
- `always`

It validates earlier-step references and result-bearing step types. Managed Workflows do not currently expose the same general branch model; they special-case accepted-connection messages instead.

**Direction:** converge these models rather than inventing a third condition representation.

---

# 1. Market findings that define parity

The market does not treat campaigns as "finish Lead A's whole sequence, then start Lead B." Mature products combine a per-lead workflow with queues, admission limits, branches, and execution batches.

## HeyReach

Current public behavior relevant to Trevra:

- Pending leads have not entered the sequence yet; they gradually become "In Sequence" as capacity allows.
- Connection requests create Accepted and Not Accepted Yet branches.
- Actions include Connection Request, Message, InMail, View Profile, Follow, Like Post, Find Email.
- Conditions include If Connection and If Open Profile.
- Can hand leads to Smartlead, Instantly, or EmailBison.
- Supports multiple LinkedIn senders in one campaign.
- Has exclusion lists / filters to avoid cross-campaign or cross-sender duplicate outreach.
- Daily limits are per sender and shared across campaigns and repeated action steps.
- Campaign schedule has start/end date, working hours, timezone, and days.
- Campaign progress exposes Pending / In Sequence / Finished / Failed.

Sources:

- https://help.heyreach.io/en/articles/9877952-how-to-launch-your-first-campaign-in-heyreach
- https://help.heyreach.io/en/articles/10493916-what-kind-of-action-steps-can-be-used-in-heyreach-sequence
- https://help.heyreach.io/en/articles/9892903-how-to-configure-my-sending-limits
- https://help.heyreach.io/en/articles/9935919-why-are-my-leads-pending-in-sequence-failed-finished

## Dripify

- Visual sequence composed of actions, delays, and conditions.
- Actions include connection request, message, endorse, view, follow, like, email.
- Conditions include If Connected, If Viewed Message, If Email Available, If Open Profile.
- Email action automatically depends on email availability.
- Supports email enrichment and InMail flows.
- Public help center explicitly discusses lead queues and sequence bottlenecks.

Sources:

- https://help.dripify.io/en/articles/5028711-what-actions-can-be-added-to-your-sequence
- https://help.dripify.io/en/articles/6788403-how-to-use-conditions
- https://help.dripify.io/en/articles/5028684-step-3-how-to-create-a-sequence

## Waalaxy

- Campaigns are action + delay + condition pipelines executed through queues.
- Connection acceptance is a gate before post-connect messages.
- No-reply conditions govern later messages.
- The queue prioritizes later-stage campaign actions over new first-stage actions so due follow-ups do not get starved by constant new lead admission.

Source:

- https://blog.waalaxy.com/en/conditions-in-a-waalaxy-campaign/

## Linked Helper

- Explicitly processes workflow actions **by bunches**.
- Each action can have `Bunch size` and `Timeout between bunches`.
- Campaign runner rotates between action queues as one action enters timeout or has no work.
- Templates cover warm-up, invite + follow-up, message chains with reply checks, InMail, event and group messaging, company invitations, endorsements, likes/comments, following, and LinkedIn -> Snov.io email fallback.

Sources:

- https://support.linkedhelper.com/hc/en-us/articles/360016470720-Workflow
- https://support.linkedhelper.com/hc/en-us/articles/360016509999-Campaigns-runner
- https://support.linkedhelper.com/hc/articles/360015357459
- https://support.linkedhelper.com/hc/en-us/articles/360015754700-How-to-create-a-new-campaign-in-Linked-Helper

## Salesflow Dynamic Outreach

- Actions: connection request, follow-up, InMail, email, profile visit, like post, withdraw, Wait, Monitor.
- Conditions: If Connected, If Open Profile, If Email Available, If Email Opened.
- Important distinction: **Wait** means do nothing until a timer expires; **Monitor** continuously checks a condition and routes immediately when it becomes true, otherwise routes to NO at timeout.
- Automatically wraps some unsafe actions with connection/open-profile conditions.

Sources:

- https://intercom.help/salesflow/en/articles/13430604-dynamic-outreach
- https://intercom.help/salesflow/en/articles/13673020-dynamic-outreach-faq

## Expandi

- Conditional campaign builder with LinkedIn + email.
- Actions include visit, follow profile, follow company, invite to follow company, endorse, connection request, mobile connection request, follow-up message, InMail, email, like post, webhook, tags.
- Conditions include connected, followed, visited your profile, email exists/opened/clicked/bounced, open InMail, post liked, and custom conditions / ICP filters.
- Supports signal-triggered entry from profile visits and post engagement.
- Supports campaign priority management.

Sources:

- https://expandi.io/lead-generation/
- https://expandi.io/blog/linkedin-outreach-for-leadgen-agencies/
- https://expandi.io/blog/how-to-create-a-campaign-on-linkedin/

## We-Connect

- Smart Sequences expose different actions before and after connection acceptance.
- Pre-connect actions include Follow, Invite, Like Post, Visit Profile, Unfollow, InMail, Disconnect, Email.
- Accepted branch includes Endorse and Follow-up Message with attachment, voice message, or GIF.
- Not-accepted branch includes Withdraw, Like, Visit, Email, Unfollow.
- Lead Engine exposes Queued / In Progress / Accepted / Replied / Paused / Completed / Excluded / Failed.
- Newer Lead Engine examples branch from connection status -> accepted -> open profile -> InMail credit checks.

Sources:

- https://support.we-connect.io/en/articles/9980625-how-to-create-and-manage-a-smart-sequence-campaign
- https://support.we-connect.io/en/articles/15332507-linkedin-lead-engine-campaign-overview
- https://support.we-connect.io/en/articles/15439360-building-a-post-engagement-prospecting-workflow

## Snov.io / La Growth Machine

- Snov.io exposes LinkedIn actions including view/follow/like/connect/message/InMail/endorse within a broader automation product.
- La Growth Machine emphasizes coordinated LinkedIn + email (and higher-touch channels) with conditional channel switching and stop-on-reply across the campaign.

Sources:

- https://snov.io/knowledgebase/how-to-use-snov-io-linkedin-automation/
- https://lagrowthmachine.com/build-multi-channel-sales-sequence-linkedin-email/

---

# 2. Product principles for Trevra

- [x] **Sequence is not Wave.** Never label a workflow step group as a wave if it is actually only a per-lead sequence stage.
- [x] **Wave is not Browser Batch.** A cohort admitted on Monday can be worked across many local-worker batches and several days.
- [x] **Pending must mean truly not admitted.** Do not call every campaign member `active` the moment the campaign starts if they cannot realistically receive their first action yet.
- [x] **Drain before fill.** Keep existing leads on schedule before admitting more new leads.
- [x] **Protect downstream SLA first.** A due follow-up or acceptance-triggered message should generally beat a brand-new profile view.
- [x] **Safety ceilings remain authoritative.** Wave admission can reduce work; it must never manufacture capacity beyond the seat/campaign guard.
- [x] **One queue state per lead.** A lead must not be eligible for two mutually exclusive workflow branches at once.
- [x] **Reply stops automation globally.** Once a real inbound reply is known, no later automated branch should continue unless the operator explicitly re-enrolls the lead.
- [x] **Snapshot semantics stay.** Running campaigns execute a chosen workflow version, not an arbitrarily mutated live definition.
- [x] **Campaign creation remains simple.** Keep Leads + Workflow + Preview + Create/Start. Put sophistication in the workflow editor and campaign operations screen, not in a giant mandatory setup wizard.
- [x] **Progressive disclosure.** Simple templates should be one-click; advanced conditions should be available without forcing every operator to understand graph theory.

---

# 3. P0 — Introduce real campaign admission and Waves

This is the most important correction to the current model.

## 3.1 Keep new campaign members Pending until admitted

Current behavior promotes all `pending` campaign members to `active` on campaign start. Replace that meaning.

- [x] Campaign start changes the campaign to `running` but leaves unadmitted members `pending`.
- [x] A dedicated admission pass chooses which pending members enter the workflow.
- [x] Only admitted members receive `active` / `waiting` workflow states.
- [x] Add an explicit `admitted_at` timestamp.
- [x] Preserve per-lead pause separately from campaign-level pause.
- [x] Continue enrolling contacts added to a live list, but enroll them as `pending`, not immediately active.
- [x] Never re-admit a removed lead because derived member IDs retain removal identity.

Likely files:

- `src/server/linkedin/managed-campaigns.ts`
- `src/server/linkedin/runner.ts`
- additive migration for campaign-member admission metadata

Tests:

- [x] Start 1,000-member campaign -> 1,000 pending, 0 active before admission pass.
- [x] Admission promotes only selected cohort.
- [x] New contact added to running campaign appears pending first.
- [x] Paused campaign does not admit.
- [x] Resuming campaign does not accidentally unpause individually paused members.

## 3.2 First-class campaign waves / cohorts

Add a durable concept for the cohort that was admitted together.

Recommended data model:

```text
linkedin_campaign_waves
- id
- workspace_id
- campaign_id
- ordinal
- admitted_at
- member_count
- admission_reason / capacity snapshot JSON
- created_at
```

Campaign member:

```text
wave_id nullable
admitted_at nullable
```

- [x] A wave represents **campaign admission**, not one local-worker batch.
- [x] Wave ordinal is monotonic per campaign.
- [x] Each admitted member receives exactly one wave ID for that campaign.
- [x] Do not rewrite wave membership as the member advances through steps.
- [x] Store enough capacity context to explain later why a wave contained N leads.
- [x] Keep `linkedin_batches` unchanged as execution-session history.

Tests:

- [x] Wave IDs are stable across runner ticks.
- [x] Browser batches never mutate wave assignment.
- [x] Newly imported leads can form a later wave.
- [x] No member appears in two waves in the same campaign.

## 3.3 Admission controller

Create one pure/domain function that decides how many new leads can enter.

Inputs should include:

- campaign workflow snapshot;
- current pending count;
- current active/waiting/manual populations by step;
- seat ceilings by action kind;
- campaign warm-up fraction;
- already planned/sent rolling-window usage;
- expected downstream demand;
- configurable minimum/maximum cohort sizes;
- optional operator cap.

Outputs:

```ts
interface AdmissionDecision {
  admit: number;
  limitingKind: 'profile_view' | 'invite' | 'dm' | 'follow' | 'like' | 'endorse' | null;
  reasons: string[];
  capacitySnapshot: Record<string, number>;
}
```

- [x] Zero admission when the seat has no usable future slots.
- [x] Zero admission when downstream backlog is already beyond target.
- [x] Admission should be conservative when acceptance/reply rates are unknown.
- [x] Once enough campaign history exists, optionally use observed acceptance rate to forecast how many connection requests will become messages.
- [x] Always clamp by hard safety ceilings; forecasting may never override a hard ceiling.
- [x] Make the decision deterministic for the same inputs so tests and UI preview agree.

## 3.4 Configurable wave policy without forcing configuration

Default should be automatic.

Operator-facing advanced options:

- [x] `Automatic (recommended)` — Trevra sizes cohorts from downstream capacity.
- [x] Optional maximum new leads/day.
- [x] Optional maximum wave size.
- [x] Optional minimum interval between new-wave admissions.
- [x] Optional campaign end date / stop admitting after date.
- [x] Never make the operator type a wave size just to launch a normal campaign.

---

# 4. P0 — Downstream-priority queue scheduler: Drain before Fill

The current member query orders by `next_eligible_at`, which is useful but does not explicitly encode campaign-stage priority.

Create a scheduler policy that distinguishes **continuation work** from **new-entry work**.

## 4.1 Priority classes

Suggested default order:

```text
1. inbound/reply reconciliation and stop decisions
2. human/manual checkpoints already due
3. monitor conditions whose answer arrived
4. overdue post-connect messages / follow-ups
5. accepted-connection first message
6. stale-invite withdrawal cleanup
7. already-admitted connection requests
8. already-admitted warm-up actions
9. NEW lead admission / first action
```

Exact order can differ by workflow semantics, but the invariant is:

> Do not starve a lead already mid-sequence because there is an unlimited supply of untouched leads.

- [x] Add a computed priority to due-member selection or stage work through separate queues.
- [x] Sort by priority first, due time second, deterministic member ID third.
- [x] Define overdue escalation so a follow-up two days late outranks one due one minute ago.
- [x] Add fairness so one campaign cannot permanently starve every other campaign on the same seat.
- [x] Preserve seat-wide ledger floor so campaigns cannot independently oversubscribe the same browser time.

## 4.2 Campaign priority

Market feature (Expandi and others): allow campaign-level priority.

- [x] Campaign priority: Low / Normal / High or numeric weight.
- [x] Priority affects allocation of remaining seat capacity, not safety ceilings.
- [x] Existing due continuation work should still have a starvation guard.
- [x] UI must explain that priority does not increase LinkedIn limits.

## 4.3 Repeated action bottlenecks

HeyReach explicitly warns that repeating the same action type splits the same daily capacity.

- [x] Preview workflow bottlenecks by action kind.
- [x] Warn when a workflow contains repeated expensive actions (e.g. Like twice, DM four times) and the configured ceiling means later stages will lag.
- [x] Campaign preview estimates sustainable new-lead admission rate from the bottleneck, not just first-step capacity.

---

# 5. P0 — Unify Managed Workflows with generalized branching

Do not keep `requiresAcceptedConnection` as the long-term only condition model.

## 5.1 Canonical workflow control nodes

Add three control concepts:

- [x] **Wait** — timer only, no condition polling.
- [x] **Monitor** — wait up to X while repeatedly checking a condition; route YES immediately, route NO at timeout.
- [x] **Condition** — one-time evaluation now; route YES/NO.
- [x] **End** — explicit branch terminator.

Keep existing `delayBefore` for simple linear workflows, but support explicit nodes in advanced mode.

## 5.2 P0 conditions

Implement first:

- [x] If already connected.
- [x] If connection request accepted.
- [x] If connection request not accepted by timeout.
- [x] If replied.
- [x] If not replied by timeout.

These cover the core LinkedIn campaign lifecycle.

## 5.3 Reuse branch validation

- [x] Extend or adapt `src/server/linkedin/branching.ts` so Managed Workflow steps can use the same semantic rules.
- [x] Conditions may reference only earlier result-bearing steps where appropriate.
- [x] No cycles.
- [x] No branch can depend on an action that cannot produce the queried result.
- [x] Graph must terminate on every reachable path.
- [x] Validate unreachable nodes and orphan branches.

## 5.4 Replace special cases gradually

Migration strategy:

- [x] Existing `message.requiresAcceptedConnection = true` remains readable.
- [x] At load time, normalize it to the new accepted-connection monitor/gate representation or keep a compatibility adapter.
- [x] Existing stored campaigns keep executing their snapshots unchanged.
- [x] Newly saved workflows use the canonical branch model after migration.

---

# 6. P0 — Explicit Wait vs Monitor semantics

This is a meaningful market feature, not cosmetic terminology.

## Wait

Example:

```text
Message
-> Wait 3 days
-> If replied?
```

Nothing is checked until the wait finishes.

## Monitor

Example:

```text
Connection request
-> Monitor "connected" for 10 days
     YES immediately -> Message
     NO at day 10     -> fallback / withdraw
```

Implementation:

- [x] Monitor state has `started_at`, `deadline_at`, condition, yes target, no target.
- [x] Runner wakes monitors on reconciliation events and periodic ticks.
- [x] If condition becomes true early, advance immediately.
- [x] If deadline expires unresolved, advance to NO branch.
- [x] Monitor should not create repeated outbound actions while waiting.
- [x] UI must visibly distinguish a passive Wait from an active Monitor.

---

# 7. P1 — Core market-parity LinkedIn action catalog

## 7.1 Like recent post — wire existing Trevra execution into Managed Workflows

- [x] Add `like_post` workflow action.
- [x] Reuse `driver-engage.ts`.
- [x] Add pacing / budget mapping.
- [x] Add preview label and analytics counter.
- [x] Handle "no recent post" as deterministic skip, not seat-wide selector drift.

## 7.2 Endorse skills — wire existing Trevra execution into Managed Workflows

- [x] Add `endorse_skills` workflow action.
- [x] Reuse `driver-engage.ts`.
- [x] Configurable maximum skills per touch within existing safe driver bounds.
- [x] Only offer in branches where the target is eligible.
- [x] Treat no endorsable skills as a skip.

## 7.3 Connection request A/B variants

Managed messages already support deterministic variants; connection notes should reach parity.

- [x] Convert connection request copy to one-or-more variants.
- [x] Keep empty-note variant valid.
- [x] Deterministic assignment by member + step.
- [x] Store `variant_id` in ledger rows, same as DMs.
- [x] Analytics: sent, accepted, replied, acceptance rate by invite-note variant.
- [x] At least a minimum sample before declaring a winner.

## 7.4 Unfollow

Market feature in We-Connect / broader automation tools.

- [x] Add only if there is a reliable reversible driver.
- [x] Make it a low-priority cleanup action, not a default outreach template step.
- [x] Explicitly distinguish profile follow from connection state.

## 7.5 Disconnect / remove connection

Market feature but potentially destructive.

- [x] Do **not** make this a default campaign action.
- [x] If implemented, require explicit advanced-mode warning and strong eligibility checks.
- [x] Never auto-insert it into templates.

## 7.6 Comment on post

Trevra's action taxonomy already names `comment`, but it is not currently a safe managed execution primitive.

- [x] Treat as future/manual-first until a reliable driver exists.
- [x] Prefer a manual checkpoint that suggests a comment before automated commenting.
- [x] If later automated, require selected target post and previewed approved text.

---

# 8. P1 — Connection lifecycle branches

## 8.1 Initial connection-state gate

Most sophisticated builders support mixed audiences.

Default shape:

```text
If already connected?
  YES -> message path
  NO  -> warm-up / connection request path
```

- [x] Add condition to workflow builder.
- [x] Resolve current connection state before wasting an invite action.
- [x] `already_connected` from the driver should advance the correct branch, not be treated only as a failed/skipped invite.

## 8.2 Accepted vs not accepted branch

- [x] Connection Request automatically offers Accepted / Not Accepted paths in simple mode.
- [x] Operator chooses the monitoring timeout.
- [x] Accepted path can message immediately or after delay.
- [x] Not Accepted path can View, Like, Follow, Find Email, Email, InMail, Withdraw, Manual, or End as those features become available.
- [x] Once a lead exits through timed-out Not Accepted, define whether late acceptance can rejoin the accepted path. Default: **no automatic cross-branch jump after the negative timeout**, matching deterministic campaign history. A later follow-up campaign can handle late acceptances.

## 8.3 Reply / no-reply branch

Current runner already stops on reply; expose it visually.

- [x] Message can be followed by `Monitor reply for N days`.
- [x] Replied -> End / Human handoff.
- [x] No reply -> next follow-up / channel fallback.
- [x] Preserve global stop-on-reply even when no explicit reply monitor node is present.

---

# 9. P1 — Campaign creation and operations UX

Keep creation simple but show the wave consequences.

## 9.1 Create Campaign screen

Keep:

- Leads card picker / inline CSV upload.
- Workflow picker / starter templates.
- Auto-generated name.
- Sending preview.
- Create -> explicit Start.

Add:

- [x] Estimated sustainable new-lead admission/day.
- [x] Estimated first wave size.
- [x] Identified bottleneck action (e.g. "Invites are the limiting stage").
- [x] Pending pool preview: "1,000 leads; Trevra will admit them gradually as existing waves clear."
- [x] Advanced wave settings behind disclosure.
- [x] Campaign schedule: optional start date, end date, working-day/time override constrained to the seat's allowed window.
- [x] Exclusion list / exclusion filters.

## 9.2 Campaign operations screen

Replace ambiguous "active" scale with operational states:

- [x] Total audience.
- [x] Pending / not admitted.
- [x] In sequence.
- [x] Waiting on condition.
- [x] Manual/human checkpoint.
- [x] Replied.
- [x] Completed.
- [x] Failed.
- [x] Excluded.
- [x] Paused.

## 9.3 Wave view

Display recent waves:

```text
Wave 7 — admitted Aug 20
25 leads
View 25/25 | Invite 17/25 | Accepted 6 | Message 6 | Replied 2

Wave 6 — admitted Aug 19
25 leads
View 25/25 | Invite 25/25 | Accepted 11 | Message 11 | Replied 4
```

- [x] Wave list with admitted date/time and member count.
- [x] Step funnel inside each wave.
- [x] Current backlog by workflow node.
- [x] Estimated next admission reason / blocker.
- [x] Clicking a wave filters campaign members to that cohort.

## 9.4 Queue view for advanced operators

- [x] Due now by step.
- [x] Scheduled today.
- [x] Waiting for connection.
- [x] Waiting for reply.
- [x] Held by pause.
- [x] Blocked by safety ceiling.
- [x] Failed / operator action required.

Avoid exposing implementation IDs by default.

---

# 10. P1 — Exclusions, deduplication, and audience eligibility

Market tools treat exclusions as part of campaign creation.

- [x] Campaign exclusion lists.
- [x] Exclude leads contacted by any campaign in workspace within configurable lookback.
- [x] Exclude leads already messaged by the same sender.
- [x] Exclude leads already in a live campaign.
- [x] Exclude leads with an existing conversation / reply.
- [x] Exclude by connection state when required by template.
- [x] Exclude missing LinkedIn URL.
- [x] Exclude invalid / duplicate normalized LinkedIn URLs.
- [x] Optional company/domain suppression list.
- [x] Optional do-not-contact flag on lead/contact.
- [x] Exclusion reason must be visible and exportable.
- [x] Never silently drop leads without an explainable reason.

Trevra already enforces one-active-campaign membership at the DB level; expose the reason cleanly in UI rather than merely showing a lower enrolled count.

---

# 11. P1 — Multi-sender campaign rotation

HeyReach and agency-oriented tools let multiple LinkedIn accounts participate in one campaign.

Do not implement this by pretending a lead can randomly switch sender mid-thread.

- [x] Campaign can select one or more eligible seats.
- [x] Assign each lead to **one stable sender** at admission.
- [x] Store `assigned_seat_key` on campaign member or equivalent immutable assignment.
- [x] All later LinkedIn actions for that lead stay on that sender.
- [x] Admission balances using remaining seat capacity and campaign priority.
- [x] Sender health/cooldown removes that sender from new admissions but does not silently migrate an existing conversation to another sender.
- [x] UI shows leads / waves / outcomes by sender.
- [x] Per-sender exclusion and replay rules remain authoritative.

Optional later:

- [x] Weighted sender distribution.
- [x] Sender filters by LinkedIn license / capabilities.

---

# 12. P1 — Templates that teach the wave/branch model

Do not ship 190 opaque templates. Ship a small, excellent library.

Recommended starters:

## Template A — Warm -> Connect -> Follow-up

```text
View profile
Wait 1 day
Connection request
Monitor connected up to 10 days
  YES -> Wait 1 day -> Message -> Monitor reply 3 days
           YES -> End: Replied
           NO  -> Message follow-up -> End
  NO  -> Withdraw -> End
```

## Template B — Connect first

```text
If connected
  YES -> Message
  NO  -> Connection request -> Monitor connected 14 days
          YES -> Message
          NO  -> Withdraw -> End
```

## Template C — Warm human handoff

```text
View -> Follow -> Like -> Manual message checkpoint -> End
```

## Template D — Multi-channel fallback (after email phase exists)

```text
If connected
  YES -> LinkedIn message -> Monitor reply
  NO  -> Invite -> Monitor connected
          YES -> LinkedIn message
          NO  -> If email available
                  YES -> Email
                  NO  -> End
```

- [x] Template cards show action trail + branch summary.
- [ ] Template analytics later show aggregate benchmark only when enough anonymized data exists and privacy rules permit it. — **Deferred:** Deferred by the plan’s own privacy/sample-size condition; no cross-workspace benchmark dataset is created.

---

# 13. P2 — InMail parity

Trevra currently explicitly marks `inmail` unsupported because no reliable driver exists. Treat this as a real implementation project, not a schema toggle.

## 13.1 Capability model

- [x] Seat capability: LinkedIn Premium / Sales Navigator / Recruiter / unknown.
- [x] Open Profile detection.
- [x] InMail type: Open/free vs paid-credit.
- [x] Credit configuration / operator-entered monthly budget if LinkedIn does not expose a reliable balance.
- [x] Campaign-level InMail credit cap.

## 13.2 Driver

- [x] Dedicated InMail compose driver with its own selector table.
- [x] Subject + body personalization.
- [x] Detect open vs paid path before click.
- [x] Record definitive send outcome before settling ledger row.
- [x] Selector drift halts safely.
- [x] Never claim a paid InMail was sent if credit state is unknown after click.

## 13.3 Workflow

- [x] `if_open_profile` condition.
- [x] `send_inmail` action.
- [x] Auto-wrap InMail in eligibility checks in simple mode.
- [x] Analytics: sent / replied / failed / paid credits consumed where known.

---

# 14. P2 — Email channel and multichannel fallback

This is the largest feature family after LinkedIn-only parity.

## 14.1 Mailbox integration

- [x] Connect one or more sending mailboxes.
- [x] Campaign sender assignment maps LinkedIn seat -> mailbox when appropriate.
- [x] Per-mailbox daily limits / schedules.
- [x] Provider send API or existing Trevra mail infrastructure; do not drive browser email UIs.

## 14.2 Email workflow action

- [x] Subject.
- [x] Body.
- [x] Threaded follow-up support.
- [x] Merge variables.
- [x] Tracking policy clearly stated; opens/clicks only if technically and legally appropriate for the configured provider.
- [x] Reply detection.
- [x] Global stop-on-reply across LinkedIn and email.

## 14.3 Email conditions

- [x] If Email Available.
- [x] If Email Opened (only when tracking exists and is enabled).
- [x] If Email Clicked.
- [x] If Email Bounced.
- [x] If Email Replied.

## 14.4 Channel fallback

- [x] LinkedIn not accepted -> email.
- [x] No LinkedIn reply -> email.
- [x] Email unavailable -> LinkedIn/InMail/manual/end.
- [x] One lead timeline merges both channels.

---

# 15. P2 — Find Email / enrichment

Market parity feature in HeyReach, Dripify, multichannel products.

- [x] `find_email` workflow action or pre-campaign enrichment stage.
- [x] Provider abstraction so enrichment vendor is replaceable.
- [x] Credit/cost preview before launch.
- [x] Campaign-level enrichment credit cap.
- [x] Distinguish imported, first-party/profile, enriched, and manually entered email provenance.
- [x] Confidence / verification status.
- [x] `Email found` / `Email not found` branch.
- [x] Never re-charge enrichment for the same lead/provider result without an explicit refresh policy.

---

# 16. P2 — External handoff actions

HeyReach/Expandi-style interoperability is valuable even before Trevra owns every channel.

- [x] Generic webhook action.
- [x] Add tag action.
- [x] Remove tag action.
- [x] Push lead to configured external email campaign/provider.
- [x] Push to CRM stage/list.
- [x] HTTP response policy: idempotency key includes campaign/member/step.
- [x] Retry only definite failures; unknown outcome must not duplicate external side effects.
- [x] Branch on handoff success/failure only when semantically useful.

---

# 17. P2 — Rich message content

Market features seen in We-Connect and similar tools.

- [x] Attachments for supported LinkedIn message surfaces.
- [x] GIF where LinkedIn surface permits and driver can verify the final send.
- [x] Voice message only after explicit feasibility / selector / media-upload research.
- [x] Message preview shows exact rendered copy and attachment.
- [x] Media upload failures do not fall back to sending an incomplete message silently.

Keep these below core branching/waves because they increase execution complexity without fixing campaign flow fundamentals.

---

# 18. P2 — Custom fields and personalization parity

Managed Workflows currently have a closed merge-field set. Market products commonly allow CSV custom variables.

- [x] Add typed custom lead fields / campaign variables.
- [x] Preserve canonical built-ins: first name, last name, company, email, phone, country.
- [x] CSV importer can map extra columns into custom field JSON.
- [x] Variable picker shows availability coverage across selected lead list.
- [x] Warn before launch when a required variable is missing for a material share of leads.
- [x] Define fallback syntax or conditional content; never send raw unresolved `{{token}}`.
- [x] Sample preview can cycle through several real leads, not only a synthetic sample.

Optional later:

- [ ] AI-assisted personalization draft at campaign setup, but never make opaque generated content a prerequisite for sending. — **Deferred:** Optional differentiator; intentionally not a prerequisite for campaign parity or sending.

---

# 19. P2 — Lead sources and signal-triggered campaign entry

Market leaders increasingly start campaigns from a signal, not only a static CSV/list.

## Static sources

- [x] CSV.
- [x] Existing Trevra list.
- [x] Paste LinkedIn profile URLs.

## LinkedIn-derived sources where deployment policy permits

- [x] Search / Sales Navigator result source.
- [x] Recruiter result source.
- [x] Post engagers / commenters.
- [x] Event attendees.
- [x] Group members.
- [x] Company employees.

## Signal entry

- [x] Lead viewed sender's profile.
- [x] Lead engaged with a tracked post.
- [x] Lead joined / attended configured event where detectable.
- [x] Lead changed job / role when supplied by an external signal source.

Signal campaigns still use the same admission controller; a burst of 500 engagers must not bypass wave capacity.

---

# 20. P3 — Company / event / group engagement actions

These appear in Linked Helper / Expandi-style products but are not core cold-outreach parity.

Evaluate one-by-one:

- [x] Follow company.
- [x] Like company post.
- [x] Invite 1st-degree connection to follow company.
- [x] Invite connection to event.
- [x] Invite connection to group.
- [x] Group-member messaging where LinkedIn legitimately exposes the message surface.
- [x] Event-attendee messaging where LinkedIn legitimately exposes the message surface.

For every action:

- [x] Add a capability/eligibility check.
- [x] Dedicated driver selector surface if necessary.
- [x] Pacing band / limit policy.
- [x] Ledger action kind.
- [x] Replay/idempotency semantics.
- [x] Analytics.
- [x] Graceful skip when the action is unavailable to that target.

Do not add an action to the builder before the worker can execute and verify it end to end.

---

# 21. P3 — Workflow editor UX

Avoid a mandatory free-form graph for simple campaigns, but support advanced branching clearly.

## Simple mode

- [x] Vertical timeline.
- [x] Connection request visually expands into Accepted / Not Accepted lanes.
- [x] Message can visually expand into Replied / No Reply lanes when a monitor is added.
- [x] Delay chip between actions.
- [x] One-click add action.
- [x] Starter templates.

## Advanced mode

- [x] Condition nodes with YES / NO branches.
- [x] Monitor nodes with timeout.
- [x] End nodes.
- [x] Drag/reorder where semantically valid.
- [x] Prevent invalid cross-branch drag rather than saving a broken graph.
- [ ] Mini-map / branch collapse only if workflows become large enough to justify it. — **Deferred:** Conditional UX optimization; current validated timeline/branch editor does not justify a second navigation surface.

## Builder validation UX

- [x] Every disabled Save explains why.
- [x] Every invalid node displays its own reason.
- [x] Detect unreachable nodes.
- [x] Detect open branch with no End.
- [x] Detect impossible action eligibility.
- [x] Detect capacity bottleneck before save/launch.

---

# 22. P3 — Campaign editing / version lifecycle

Trevra's current snapshot behavior is a strength. Preserve it and make edits explicit.

- [x] Editing reusable Workflow creates a new version.
- [x] Running campaign remains on its snapshot by default.
- [x] Campaign page shows workflow version.
- [x] "Apply latest workflow" requires explicit operator action.
- [x] Safe upgrade option can apply only to **pending/unadmitted** leads while already-admitted waves stay on the old snapshot.
- [x] Advanced migration of in-flight leads between workflow versions is out of scope until there is a formal step-mapping model.
- [x] Duplicate Campaign creates a new draft with same audience/workflow/settings but no live membership history.

---

# 23. P3 — Analytics required for wave-based operation

## Campaign funnel

- [x] Total audience.
- [x] Pending.
- [x] Admitted / In Sequence.
- [x] Invited.
- [x] Accepted.
- [x] Messaged.
- [x] Replied.
- [x] Completed.
- [x] Failed.
- [x] Excluded.

## Wave analytics

- [x] Wave size.
- [x] Admission timestamp.
- [x] Time to first action.
- [x] Time through each step.
- [x] Acceptance rate.
- [x] Reply rate.
- [x] Failure rate.
- [x] Backlog remaining.

## Step analytics

- [x] Scheduled.
- [x] Sent/executed.
- [x] Skipped.
- [x] Failed.
- [x] Outcome rate.
- [x] Median delay vs intended delay.
- [x] Queue latency / overdue count.

## Variant analytics

- [x] Invite note variants.
- [x] DM variant IDs already stored; extend display.
- [x] Minimum sample before naming winner.
- [x] Do not auto-kill a variant from tiny samples.

## Sender analytics

- [x] Per-seat volume.
- [x] Acceptance rate.
- [x] Reply rate.
- [x] Safety blocks / cooldowns.
- [x] Campaign allocation.

## Bottleneck analytics

- [x] "Why isn't this campaign moving?"
- [x] Limiting action budget.
- [x] Waiting-on-condition count.
- [x] Pending because admission closed.
- [x] Worker unavailable / browser batch halted.
- [x] Seat working window closed.

---

# 24. P3 — Unified lead timeline and handoff

- [x] One timeline per campaign member across profile views, follows, likes, invites, acceptance, DMs, replies, manual tasks, InMail/email later.
- [x] Show workflow step ID/name beside each event.
- [x] Show wave number.
- [x] Show sender.
- [x] Show branch taken and why.
- [x] Show exact approved message variant.
- [x] Human can pause/resume one lead.
- [x] Human can end automation for one lead.
- [x] Human can move lead to manual checkpoint where safe.
- [x] Human reply keeps automation stopped unless explicitly resumed/re-enrolled.

---

# 25. P3 — Campaign-level schedules

Trevra has per-seat working schedules. Market tools also expose campaign schedules.

- [x] Optional campaign start date/time.
- [x] Optional campaign end date/time.
- [x] Optional campaign working days / hours **within** the seat's allowed window.
- [x] Campaign timezone defaults to seat timezone.
- [x] Campaign schedule can narrow seat availability, never widen it.
- [x] End date stops new admission first; define whether already-admitted leads may finish or are held/stopped according to operator choice.

Suggested options at end date:

- `Stop admitting new leads; finish current waves` (default).
- `Pause all campaign work`.
- `Stop campaign immediately` (destructive warning).

---

# 26. P3 — Failure recovery and operator controls

- [x] Retry definite no-side-effect failures.
- [x] Never retry unknown side effects automatically.
- [x] Per-step failure reason visible.
- [x] Bulk retry selected deterministic failures.
- [x] Resume from exact workflow node.
- [x] Re-run condition without re-sending previous action.
- [x] Skip one step manually with audit reason.
- [x] End one lead manually.
- [x] Move selected leads to another follow-up campaign only with dedupe checks.

---

# 27. P3 — Team / agency controls around campaigns

- [x] Workspace-level exclusion / do-not-contact policy.
- [x] Campaign ownership.
- [x] Sender ownership / permission checks.
- [x] Template library scoped workspace vs personal.
- [x] Role permissions for create/edit/start/pause/stop.
- [x] Audit trail for campaign lifecycle changes.
- [x] Client/workspace export of campaign results.
- [ ] Optional white-label reporting only if it fits broader Trevra product direction. — **Deferred:** Conditional product-direction item; not required for campaign execution parity.

---

# 28. P4 — Optimization features after parity

These are differentiators, not blockers for parity.

## 28.1 Predictive wave sizing

- [x] Forecast tomorrow's invite/message demand using observed acceptance/reply distributions.
- [x] Admit enough leads to keep later stages full without building large queues.
- [x] Confidence bands; fall back to conservative static behavior on small samples.
- [x] Never override hard ceilings.

## 28.2 Target SLA per step

- [x] Operator can define "follow up within N hours/days".
- [x] Scheduler escalates overdue continuation work.
- [x] UI reports SLA miss rate.

## 28.3 Auto-throttle from outcomes

- [x] Reduce new admissions when acceptance rate falls materially.
- [x] Reduce/stop outreach on high failure/challenge rates.
- [x] Require enough sample before reacting.
- [x] Explain every throttle in the campaign UI.

## 28.4 Recommended sequence diagnostics

- [x] Detect too many touches.
- [x] Detect repeated action bottleneck.
- [x] Detect missing reply monitor between follow-ups.
- [x] Detect no cleanup path for long-pending invites.
- [x] Detect content missing variables across many leads.
- [x] Suggest, never silently rewrite, the operator's workflow.

---

# 29. Data-model plan

Exact migration numbers must be chosen from the repository's latest migration at implementation time.

Likely additions:

## `linkedin_campaigns`

- `priority`
- `admission_policy_json`
- optional campaign schedule fields
- optional end-date behavior

## `linkedin_campaign_members`

- `admitted_at`
- `wave_id`
- optional stable `assigned_seat_key` for multi-sender campaigns
- optional branch/node state if step-index is no longer enough for graph workflows

## `linkedin_campaign_waves`

New table for durable admission cohorts.

## workflow storage

Current `steps_json` may need a versioned workflow graph schema with:

- action nodes
- condition nodes
- wait nodes
- monitor nodes
- end nodes
- edges / branch targets

Prefer a version field and explicit normalizer over trying to infer graph schema from arbitrary JSON forever.

## `linkedin_actions`

Already has `workflow_step_id`; ensure every new action continues populating it.

Potential additions only if necessary:

- condition/branch evaluation audit reference;
- external action idempotency metadata;
- InMail/email channel metadata.

---

# 30. Runner architecture plan

Target runner stages:

```text
runManagedCampaigns
  1. reconcile outcomes / replies
  2. refresh running campaigns
  3. enroll new list members as PENDING
  4. evaluate monitors / conditions
  5. calculate seat + campaign budgets
  6. rank continuation queues
  7. plan continuation actions
  8. calculate safe admission capacity
  9. create new wave if capacity > 0
 10. plan first actions for newly admitted members
 11. batch member-state writes
 12. mark campaigns complete only when:
       pending == 0
       AND no live/admitted members remain
       AND no outstanding manual/held work that semantically keeps campaign open
```

Important:

- [x] Do not mark campaign completed while pending audience still exists merely because no currently admitted member is live.
- [x] Do not admit new leads during campaign pause.
- [x] Do not let a pending pool create future action rows before admission.
- [x] Keep planning idempotent under concurrent ticks using existing workspace advisory locking.

---

# 31. Local-worker / browser-batch plan

Keep the existing physical batch abstraction.

- [x] `linkedin_batches` remains one browser execution pass, not a campaign wave.
- [x] Batch may contain actions from several campaigns on the same seat.
- [x] Batch selection respects planned times and scheduler priority already encoded by planning.
- [x] Continue per-action safety gate immediately before execution.
- [x] Continue halting on challenge / limit wall / true selector drift.
- [x] New engagement actions use dedicated driver surfaces.
- [x] Monitor/condition nodes create no browser batch row unless their condition itself requires a read operation that cannot be answered from synchronized state.

---

# 32. API plan

Add/extend endpoints for:

- [x] Campaign wave list.
- [x] Campaign queue/backlog summary.
- [x] Campaign pending/admission summary.
- [x] Campaign priority update.
- [x] Campaign admission policy update while paused / rules for live editing.
- [x] Campaign schedule update.
- [x] Workflow graph create/update/read.
- [x] Workflow validation preview.
- [x] Campaign launch preview with bottleneck/admission estimate.
- [x] Per-member branch / timeline read.
- [x] Manual member pause/resume/end/skip controls.

Keep heavy aggregate work server-side; do not create N+1 member reads from React.

---

# 33. Testing strategy

## Pure unit tests

- [x] Workflow graph validation.
- [x] Branch evaluation.
- [x] Monitor deadline behavior.
- [x] Admission controller.
- [x] Priority ordering.
- [x] Bottleneck calculations.
- [x] Campaign preview estimates.
- [x] Existing workflow compatibility normalization.

## DB integration tests

- [x] Start leaves members pending.
- [x] Admission creates stable waves.
- [x] Downstream work beats new admission.
- [x] Seat budget shared correctly across campaigns.
- [x] Campaign priority affects allocation but never ceilings.
- [x] Reply stops future planned work.
- [x] Acceptance wakes monitor and schedules accepted branch.
- [x] Timeout enters not-accepted branch once.
- [x] Pause holds planned work and blocks admission.
- [x] Resume preserves member and wave state.
- [x] New leads added live join pending pool.
- [x] Campaign completes only when pending + live work are both exhausted.
- [x] Multi-sender assignment stays stable.

## Worker/driver tests

- [x] Like and endorse Managed Workflow actions execute existing engagement routines.
- [x] Deterministic skip conditions do not halt whole batch.
- [x] New InMail driver, if implemented, has selector-drift and unknown-outcome tests before being exposed in UI.

## Regression tests

- [x] Existing linear workflows execute unchanged.
- [x] Existing campaign snapshots remain readable.
- [x] Existing A/B DM assignments remain stable.
- [x] Existing campaign pause/resume behavior remains lossless.

---

# 34. Rollout order

Implement in this order; later items depend on earlier architecture.

## Milestone 1 — Correct the campaign execution model

- [x] Pending admission state.
- [x] Wave table / wave IDs.
- [x] Admission controller.
- [x] Drain-before-fill downstream priority.
- [x] Campaign UI: Pending vs In Sequence + wave list.
- [x] Completion semantics updated for pending pool.

**Definition of done:** a 1,000-lead campaign can run for days while only capacity-safe cohorts are admitted; the UI can explain exactly which leads are waiting and why.

## Milestone 2 — Conditional Managed Workflows

- [x] Canonical Wait / Monitor / Condition / End.
- [x] If Connected.
- [x] Accepted / Not Accepted timeout branch.
- [x] Replied / Not Replied branch.
- [x] Compatibility for `requiresAcceptedConnection`.
- [x] Advanced workflow editor branching UI.

**Definition of done:** the operator can build the market-standard Connected / Not Connected and Replied / No Reply paths without creating separate campaigns.

## Milestone 3 — LinkedIn action parity

- [x] Like Post via existing engagement driver.
- [x] Endorse via existing engagement driver.
- [x] Connection-note A/B testing.
- [x] Better deterministic skip semantics.
- [x] Template library refresh.

**Definition of done:** Trevra covers the common LinkedIn-only warm -> connect -> engage -> follow-up action set of Dripify/HeyReach/We-Connect/Snov.io.

## Milestone 4 — Campaign controls parity

- [x] Exclusions.
- [x] Campaign priority.
- [x] Campaign schedule.
- [x] Multi-sender stable assignment.
- [x] Queue/bottleneck analytics.
- [x] Duplicate/rebuild campaign UX.

## Milestone 5 — InMail

- [x] Seat capability.
- [x] Open-profile condition.
- [x] InMail driver.
- [x] Credit safeguards.
- [x] Analytics.

Do not expose until it is executable end to end.

## Milestone 6 — Email / enrichment / external handoff

- [x] Email action.
- [x] Email conditions.
- [x] Find Email.
- [x] LinkedIn -> email fallback.
- [x] Webhook / CRM / external sequencer handoff.
- [x] Cross-channel stop-on-reply.

## Milestone 7 — Extended market features

- [x] Attachments / GIFs / voice where safe and testable.
- [x] Company actions.
- [x] Event/group actions.
- [x] Signal-triggered campaign entry.
- [x] Predictive wave sizing.

---

# 35. Recommended first engineering slice

Do not begin by adding InMail, email, or another action button. First make the campaign engine capable of waves.

Slice 1:

- [x] Add `admitted_at` + `wave_id` and `linkedin_campaign_waves`.
- [x] Change campaign start so members remain pending.
- [x] Add a simple conservative admission controller using first-order action budgets.
- [x] Admit one cohort per eligible admission pass.
- [x] Rank already-admitted due work ahead of new admission.
- [x] Add Pending / In Sequence / Wave N counts to campaign operations.
- [x] Add tests proving a 1,000-lead campaign does not activate all 1,000 at once.

Then Slice 2:

- [x] Generalize accepted-connection behavior into Monitor + branch.
- [x] Add initial If Connected.
- [x] Add reply/no-reply monitor.

Then Slice 3:

- [x] Wire Like and Endorse into Managed Workflows.
- [x] Add invite-note A/B variants.

This sequence fixes the architecture before expanding the catalog.

---

# 36. Final target parity matrix

Legend: `CURRENT`, `BUILD`, `LATER`.

| Capability                         | Trevra target                 |
| ---------------------------------- | ----------------------------- |
| Profile view                       | CURRENT                       |
| Follow profile                     | CURRENT                       |
| Connection request                 | CURRENT                       |
| Connection note                    | CURRENT                       |
| DM follow-up                       | CURRENT                       |
| DM A/B variants                    | CURRENT                       |
| Manual checkpoint                  | CURRENT                       |
| Withdraw pending invite            | CURRENT                       |
| Stop on LinkedIn reply             | CURRENT                       |
| Per-step delay                     | CURRENT                       |
| Seat safety ceilings               | CURRENT                       |
| Campaign ramp                      | CURRENT                       |
| Multiple LinkedIn visits/day       | CURRENT                       |
| Physical browser batches           | CURRENT                       |
| Workflow snapshot/version          | CURRENT                       |
| Like post                          | BUILD (reuse existing driver) |
| Endorse skills                     | BUILD (reuse existing driver) |
| Pending vs admitted leads          | BUILD                         |
| First-class waves/cohorts          | BUILD                         |
| Downstream-priority queues         | BUILD                         |
| Automatic wave sizing              | BUILD                         |
| Campaign priority                  | BUILD                         |
| If Connected                       | BUILD                         |
| Accepted / Not Accepted branch     | BUILD                         |
| Reply / No Reply branch            | BUILD                         |
| Wait vs Monitor                    | BUILD                         |
| Explicit End nodes                 | BUILD                         |
| Invite-note A/B variants           | BUILD                         |
| Exclusion lists/filters            | BUILD                         |
| Campaign schedule                  | BUILD                         |
| Multi-sender stable rotation       | BUILD                         |
| Per-wave analytics                 | BUILD                         |
| Queue/bottleneck analytics         | BUILD                         |
| Custom CSV variables               | BUILD                         |
| If Open Profile                    | LATER / InMail milestone      |
| InMail                             | LATER                         |
| Paid InMail / credit cap           | LATER                         |
| Find Email                         | LATER                         |
| If Email Available                 | LATER                         |
| Send Email                         | LATER                         |
| Email open/click/bounce conditions | LATER                         |
| Cross-channel stop-on-reply        | LATER                         |
| Webhook / tags / CRM handoff       | LATER                         |
| Push to external email sequencer   | LATER                         |
| Attachments                        | LATER                         |
| GIF message                        | LATER                         |
| Voice message                      | LATER                         |
| Unfollow                           | LATER                         |
| Disconnect                         | LATER / advanced only         |
| Comment on post                    | LATER / manual-first          |
| Follow company                     | LATER                         |
| Like company post                  | LATER                         |
| Invite to follow company           | LATER                         |
| Event invites                      | LATER                         |
| Group invites/messages             | LATER                         |
| Signal-triggered entry             | LATER                         |
| Predictive wave sizing             | LATER                         |

---

# 37. Product success criteria

The project is at strong campaign-creation parity when all of these are true:

- [x] A campaign with 10,000 leads does not imply 10,000 active LinkedIn journeys at launch.
- [x] The operator can see Pending, In Sequence, and individual waves.
- [x] New leads are admitted only when downstream capacity can absorb them.
- [x] Due follow-ups are not starved by new lead acquisition.
- [x] Mixed connected/not-connected lists route correctly.
- [x] Connection acceptance can wake the next step immediately.
- [x] Not-accepted leads follow an explicit timeout path.
- [x] Replies stop all remaining automation.
- [x] The common warm-up actions View / Follow / Like / Endorse are usable in Managed Workflows.
- [x] Campaign-level exclusions prevent accidental duplicate outreach.
- [x] Multi-sender campaigns keep each lead on one stable sender.
- [x] The UI can answer "Why isn't this lead/campaign moving?" without reading logs.
- [x] Workflow edits cannot silently mutate already-running waves.
- [x] Every action exposed in the builder is actually executable and verifiable by the worker.
- [x] InMail/email features, once exposed, are first-class channels with the same queue, branch, idempotency, safety, and analytics rules—not sidecar hacks.

That is the target architecture: **Audience -> Pending Pool -> Capacity-Aware Waves -> Branching Workflow Queues -> Downstream-Priority Scheduling -> Human-Like LinkedIn Visits/Batches -> Outcome-Driven Next Waves.**
