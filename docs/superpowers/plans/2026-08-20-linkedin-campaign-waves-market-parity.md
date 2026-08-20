# LinkedIn Campaign Waves + Market Parity Implementation Plan

> **Status:** proposed implementation roadmap
> **Research date:** 2026-08-20
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

- [ ] **Sequence is not Wave.** Never label a workflow step group as a wave if it is actually only a per-lead sequence stage.
- [ ] **Wave is not Browser Batch.** A cohort admitted on Monday can be worked across many local-worker batches and several days.
- [ ] **Pending must mean truly not admitted.** Do not call every campaign member `active` the moment the campaign starts if they cannot realistically receive their first action yet.
- [ ] **Drain before fill.** Keep existing leads on schedule before admitting more new leads.
- [ ] **Protect downstream SLA first.** A due follow-up or acceptance-triggered message should generally beat a brand-new profile view.
- [ ] **Safety ceilings remain authoritative.** Wave admission can reduce work; it must never manufacture capacity beyond the seat/campaign guard.
- [ ] **One queue state per lead.** A lead must not be eligible for two mutually exclusive workflow branches at once.
- [ ] **Reply stops automation globally.** Once a real inbound reply is known, no later automated branch should continue unless the operator explicitly re-enrolls the lead.
- [ ] **Snapshot semantics stay.** Running campaigns execute a chosen workflow version, not an arbitrarily mutated live definition.
- [ ] **Campaign creation remains simple.** Keep Leads + Workflow + Preview + Create/Start. Put sophistication in the workflow editor and campaign operations screen, not in a giant mandatory setup wizard.
- [ ] **Progressive disclosure.** Simple templates should be one-click; advanced conditions should be available without forcing every operator to understand graph theory.

---

# 3. P0 — Introduce real campaign admission and Waves

This is the most important correction to the current model.

## 3.1 Keep new campaign members Pending until admitted

Current behavior promotes all `pending` campaign members to `active` on campaign start. Replace that meaning.

- [ ] Campaign start changes the campaign to `running` but leaves unadmitted members `pending`.
- [ ] A dedicated admission pass chooses which pending members enter the workflow.
- [ ] Only admitted members receive `active` / `waiting` workflow states.
- [ ] Add an explicit `admitted_at` timestamp.
- [ ] Preserve per-lead pause separately from campaign-level pause.
- [ ] Continue enrolling contacts added to a live list, but enroll them as `pending`, not immediately active.
- [ ] Never re-admit a removed lead because derived member IDs retain removal identity.

Likely files:

- `src/server/linkedin/managed-campaigns.ts`
- `src/server/linkedin/runner.ts`
- additive migration for campaign-member admission metadata

Tests:

- [ ] Start 1,000-member campaign -> 1,000 pending, 0 active before admission pass.
- [ ] Admission promotes only selected cohort.
- [ ] New contact added to running campaign appears pending first.
- [ ] Paused campaign does not admit.
- [ ] Resuming campaign does not accidentally unpause individually paused members.

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

- [ ] A wave represents **campaign admission**, not one local-worker batch.
- [ ] Wave ordinal is monotonic per campaign.
- [ ] Each admitted member receives exactly one wave ID for that campaign.
- [ ] Do not rewrite wave membership as the member advances through steps.
- [ ] Store enough capacity context to explain later why a wave contained N leads.
- [ ] Keep `linkedin_batches` unchanged as execution-session history.

Tests:

- [ ] Wave IDs are stable across runner ticks.
- [ ] Browser batches never mutate wave assignment.
- [ ] Newly imported leads can form a later wave.
- [ ] No member appears in two waves in the same campaign.

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

- [ ] Zero admission when the seat has no usable future slots.
- [ ] Zero admission when downstream backlog is already beyond target.
- [ ] Admission should be conservative when acceptance/reply rates are unknown.
- [ ] Once enough campaign history exists, optionally use observed acceptance rate to forecast how many connection requests will become messages.
- [ ] Always clamp by hard safety ceilings; forecasting may never override a hard ceiling.
- [ ] Make the decision deterministic for the same inputs so tests and UI preview agree.

## 3.4 Configurable wave policy without forcing configuration

Default should be automatic.

Operator-facing advanced options:

- [ ] `Automatic (recommended)` — Trevra sizes cohorts from downstream capacity.
- [ ] Optional maximum new leads/day.
- [ ] Optional maximum wave size.
- [ ] Optional minimum interval between new-wave admissions.
- [ ] Optional campaign end date / stop admitting after date.
- [ ] Never make the operator type a wave size just to launch a normal campaign.

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

- [ ] Add a computed priority to due-member selection or stage work through separate queues.
- [ ] Sort by priority first, due time second, deterministic member ID third.
- [ ] Define overdue escalation so a follow-up two days late outranks one due one minute ago.
- [ ] Add fairness so one campaign cannot permanently starve every other campaign on the same seat.
- [ ] Preserve seat-wide ledger floor so campaigns cannot independently oversubscribe the same browser time.

## 4.2 Campaign priority

Market feature (Expandi and others): allow campaign-level priority.

- [ ] Campaign priority: Low / Normal / High or numeric weight.
- [ ] Priority affects allocation of remaining seat capacity, not safety ceilings.
- [ ] Existing due continuation work should still have a starvation guard.
- [ ] UI must explain that priority does not increase LinkedIn limits.

## 4.3 Repeated action bottlenecks

HeyReach explicitly warns that repeating the same action type splits the same daily capacity.

- [ ] Preview workflow bottlenecks by action kind.
- [ ] Warn when a workflow contains repeated expensive actions (e.g. Like twice, DM four times) and the configured ceiling means later stages will lag.
- [ ] Campaign preview estimates sustainable new-lead admission rate from the bottleneck, not just first-step capacity.

---

# 5. P0 — Unify Managed Workflows with generalized branching

Do not keep `requiresAcceptedConnection` as the long-term only condition model.

## 5.1 Canonical workflow control nodes

Add three control concepts:

- [ ] **Wait** — timer only, no condition polling.
- [ ] **Monitor** — wait up to X while repeatedly checking a condition; route YES immediately, route NO at timeout.
- [ ] **Condition** — one-time evaluation now; route YES/NO.
- [ ] **End** — explicit branch terminator.

Keep existing `delayBefore` for simple linear workflows, but support explicit nodes in advanced mode.

## 5.2 P0 conditions

Implement first:

- [ ] If already connected.
- [ ] If connection request accepted.
- [ ] If connection request not accepted by timeout.
- [ ] If replied.
- [ ] If not replied by timeout.

These cover the core LinkedIn campaign lifecycle.

## 5.3 Reuse branch validation

- [ ] Extend or adapt `src/server/linkedin/branching.ts` so Managed Workflow steps can use the same semantic rules.
- [ ] Conditions may reference only earlier result-bearing steps where appropriate.
- [ ] No cycles.
- [ ] No branch can depend on an action that cannot produce the queried result.
- [ ] Graph must terminate on every reachable path.
- [ ] Validate unreachable nodes and orphan branches.

## 5.4 Replace special cases gradually

Migration strategy:

- [ ] Existing `message.requiresAcceptedConnection = true` remains readable.
- [ ] At load time, normalize it to the new accepted-connection monitor/gate representation or keep a compatibility adapter.
- [ ] Existing stored campaigns keep executing their snapshots unchanged.
- [ ] Newly saved workflows use the canonical branch model after migration.

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

- [ ] Monitor state has `started_at`, `deadline_at`, condition, yes target, no target.
- [ ] Runner wakes monitors on reconciliation events and periodic ticks.
- [ ] If condition becomes true early, advance immediately.
- [ ] If deadline expires unresolved, advance to NO branch.
- [ ] Monitor should not create repeated outbound actions while waiting.
- [ ] UI must visibly distinguish a passive Wait from an active Monitor.

---

# 7. P1 — Core market-parity LinkedIn action catalog

## 7.1 Like recent post — wire existing Trevra execution into Managed Workflows

- [ ] Add `like_post` workflow action.
- [ ] Reuse `driver-engage.ts`.
- [ ] Add pacing / budget mapping.
- [ ] Add preview label and analytics counter.
- [ ] Handle "no recent post" as deterministic skip, not seat-wide selector drift.

## 7.2 Endorse skills — wire existing Trevra execution into Managed Workflows

- [ ] Add `endorse_skills` workflow action.
- [ ] Reuse `driver-engage.ts`.
- [ ] Configurable maximum skills per touch within existing safe driver bounds.
- [ ] Only offer in branches where the target is eligible.
- [ ] Treat no endorsable skills as a skip.

## 7.3 Connection request A/B variants

Managed messages already support deterministic variants; connection notes should reach parity.

- [ ] Convert connection request copy to one-or-more variants.
- [ ] Keep empty-note variant valid.
- [ ] Deterministic assignment by member + step.
- [ ] Store `variant_id` in ledger rows, same as DMs.
- [ ] Analytics: sent, accepted, replied, acceptance rate by invite-note variant.
- [ ] At least a minimum sample before declaring a winner.

## 7.4 Unfollow

Market feature in We-Connect / broader automation tools.

- [ ] Add only if there is a reliable reversible driver.
- [ ] Make it a low-priority cleanup action, not a default outreach template step.
- [ ] Explicitly distinguish profile follow from connection state.

## 7.5 Disconnect / remove connection

Market feature but potentially destructive.

- [ ] Do **not** make this a default campaign action.
- [ ] If implemented, require explicit advanced-mode warning and strong eligibility checks.
- [ ] Never auto-insert it into templates.

## 7.6 Comment on post

Trevra's action taxonomy already names `comment`, but it is not currently a safe managed execution primitive.

- [ ] Treat as future/manual-first until a reliable driver exists.
- [ ] Prefer a manual checkpoint that suggests a comment before automated commenting.
- [ ] If later automated, require selected target post and previewed approved text.

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

- [ ] Add condition to workflow builder.
- [ ] Resolve current connection state before wasting an invite action.
- [ ] `already_connected` from the driver should advance the correct branch, not be treated only as a failed/skipped invite.

## 8.2 Accepted vs not accepted branch

- [ ] Connection Request automatically offers Accepted / Not Accepted paths in simple mode.
- [ ] Operator chooses the monitoring timeout.
- [ ] Accepted path can message immediately or after delay.
- [ ] Not Accepted path can View, Like, Follow, Find Email, Email, InMail, Withdraw, Manual, or End as those features become available.
- [ ] Once a lead exits through timed-out Not Accepted, define whether late acceptance can rejoin the accepted path. Default: **no automatic cross-branch jump after the negative timeout**, matching deterministic campaign history. A later follow-up campaign can handle late acceptances.

## 8.3 Reply / no-reply branch

Current runner already stops on reply; expose it visually.

- [ ] Message can be followed by `Monitor reply for N days`.
- [ ] Replied -> End / Human handoff.
- [ ] No reply -> next follow-up / channel fallback.
- [ ] Preserve global stop-on-reply even when no explicit reply monitor node is present.

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

- [ ] Estimated sustainable new-lead admission/day.
- [ ] Estimated first wave size.
- [ ] Identified bottleneck action (e.g. "Invites are the limiting stage").
- [ ] Pending pool preview: "1,000 leads; Trevra will admit them gradually as existing waves clear."
- [ ] Advanced wave settings behind disclosure.
- [ ] Campaign schedule: optional start date, end date, working-day/time override constrained to the seat's allowed window.
- [ ] Exclusion list / exclusion filters.

## 9.2 Campaign operations screen

Replace ambiguous "active" scale with operational states:

- [ ] Total audience.
- [ ] Pending / not admitted.
- [ ] In sequence.
- [ ] Waiting on condition.
- [ ] Manual/human checkpoint.
- [ ] Replied.
- [ ] Completed.
- [ ] Failed.
- [ ] Excluded.
- [ ] Paused.

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

- [ ] Wave list with admitted date/time and member count.
- [ ] Step funnel inside each wave.
- [ ] Current backlog by workflow node.
- [ ] Estimated next admission reason / blocker.
- [ ] Clicking a wave filters campaign members to that cohort.

## 9.4 Queue view for advanced operators

- [ ] Due now by step.
- [ ] Scheduled today.
- [ ] Waiting for connection.
- [ ] Waiting for reply.
- [ ] Held by pause.
- [ ] Blocked by safety ceiling.
- [ ] Failed / operator action required.

Avoid exposing implementation IDs by default.

---

# 10. P1 — Exclusions, deduplication, and audience eligibility

Market tools treat exclusions as part of campaign creation.

- [ ] Campaign exclusion lists.
- [ ] Exclude leads contacted by any campaign in workspace within configurable lookback.
- [ ] Exclude leads already messaged by the same sender.
- [ ] Exclude leads already in a live campaign.
- [ ] Exclude leads with an existing conversation / reply.
- [ ] Exclude by connection state when required by template.
- [ ] Exclude missing LinkedIn URL.
- [ ] Exclude invalid / duplicate normalized LinkedIn URLs.
- [ ] Optional company/domain suppression list.
- [ ] Optional do-not-contact flag on lead/contact.
- [ ] Exclusion reason must be visible and exportable.
- [ ] Never silently drop leads without an explainable reason.

Trevra already enforces one-active-campaign membership at the DB level; expose the reason cleanly in UI rather than merely showing a lower enrolled count.

---

# 11. P1 — Multi-sender campaign rotation

HeyReach and agency-oriented tools let multiple LinkedIn accounts participate in one campaign.

Do not implement this by pretending a lead can randomly switch sender mid-thread.

- [ ] Campaign can select one or more eligible seats.
- [ ] Assign each lead to **one stable sender** at admission.
- [ ] Store `assigned_seat_key` on campaign member or equivalent immutable assignment.
- [ ] All later LinkedIn actions for that lead stay on that sender.
- [ ] Admission balances using remaining seat capacity and campaign priority.
- [ ] Sender health/cooldown removes that sender from new admissions but does not silently migrate an existing conversation to another sender.
- [ ] UI shows leads / waves / outcomes by sender.
- [ ] Per-sender exclusion and replay rules remain authoritative.

Optional later:

- [ ] Weighted sender distribution.
- [ ] Sender filters by LinkedIn license / capabilities.

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

- [ ] Template cards show action trail + branch summary.
- [ ] Template analytics later show aggregate benchmark only when enough anonymized data exists and privacy rules permit it.

---

# 13. P2 — InMail parity

Trevra currently explicitly marks `inmail` unsupported because no reliable driver exists. Treat this as a real implementation project, not a schema toggle.

## 13.1 Capability model

- [ ] Seat capability: LinkedIn Premium / Sales Navigator / Recruiter / unknown.
- [ ] Open Profile detection.
- [ ] InMail type: Open/free vs paid-credit.
- [ ] Credit configuration / operator-entered monthly budget if LinkedIn does not expose a reliable balance.
- [ ] Campaign-level InMail credit cap.

## 13.2 Driver

- [ ] Dedicated InMail compose driver with its own selector table.
- [ ] Subject + body personalization.
- [ ] Detect open vs paid path before click.
- [ ] Record definitive send outcome before settling ledger row.
- [ ] Selector drift halts safely.
- [ ] Never claim a paid InMail was sent if credit state is unknown after click.

## 13.3 Workflow

- [ ] `if_open_profile` condition.
- [ ] `send_inmail` action.
- [ ] Auto-wrap InMail in eligibility checks in simple mode.
- [ ] Analytics: sent / replied / failed / paid credits consumed where known.

---

# 14. P2 — Email channel and multichannel fallback

This is the largest feature family after LinkedIn-only parity.

## 14.1 Mailbox integration

- [ ] Connect one or more sending mailboxes.
- [ ] Campaign sender assignment maps LinkedIn seat -> mailbox when appropriate.
- [ ] Per-mailbox daily limits / schedules.
- [ ] Provider send API or existing Trevra mail infrastructure; do not drive browser email UIs.

## 14.2 Email workflow action

- [ ] Subject.
- [ ] Body.
- [ ] Threaded follow-up support.
- [ ] Merge variables.
- [ ] Tracking policy clearly stated; opens/clicks only if technically and legally appropriate for the configured provider.
- [ ] Reply detection.
- [ ] Global stop-on-reply across LinkedIn and email.

## 14.3 Email conditions

- [ ] If Email Available.
- [ ] If Email Opened (only when tracking exists and is enabled).
- [ ] If Email Clicked.
- [ ] If Email Bounced.
- [ ] If Email Replied.

## 14.4 Channel fallback

- [ ] LinkedIn not accepted -> email.
- [ ] No LinkedIn reply -> email.
- [ ] Email unavailable -> LinkedIn/InMail/manual/end.
- [ ] One lead timeline merges both channels.

---

# 15. P2 — Find Email / enrichment

Market parity feature in HeyReach, Dripify, multichannel products.

- [ ] `find_email` workflow action or pre-campaign enrichment stage.
- [ ] Provider abstraction so enrichment vendor is replaceable.
- [ ] Credit/cost preview before launch.
- [ ] Campaign-level enrichment credit cap.
- [ ] Distinguish imported, first-party/profile, enriched, and manually entered email provenance.
- [ ] Confidence / verification status.
- [ ] `Email found` / `Email not found` branch.
- [ ] Never re-charge enrichment for the same lead/provider result without an explicit refresh policy.

---

# 16. P2 — External handoff actions

HeyReach/Expandi-style interoperability is valuable even before Trevra owns every channel.

- [ ] Generic webhook action.
- [ ] Add tag action.
- [ ] Remove tag action.
- [ ] Push lead to configured external email campaign/provider.
- [ ] Push to CRM stage/list.
- [ ] HTTP response policy: idempotency key includes campaign/member/step.
- [ ] Retry only definite failures; unknown outcome must not duplicate external side effects.
- [ ] Branch on handoff success/failure only when semantically useful.

---

# 17. P2 — Rich message content

Market features seen in We-Connect and similar tools.

- [ ] Attachments for supported LinkedIn message surfaces.
- [ ] GIF where LinkedIn surface permits and driver can verify the final send.
- [ ] Voice message only after explicit feasibility / selector / media-upload research.
- [ ] Message preview shows exact rendered copy and attachment.
- [ ] Media upload failures do not fall back to sending an incomplete message silently.

Keep these below core branching/waves because they increase execution complexity without fixing campaign flow fundamentals.

---

# 18. P2 — Custom fields and personalization parity

Managed Workflows currently have a closed merge-field set. Market products commonly allow CSV custom variables.

- [ ] Add typed custom lead fields / campaign variables.
- [ ] Preserve canonical built-ins: first name, last name, company, email, phone, country.
- [ ] CSV importer can map extra columns into custom field JSON.
- [ ] Variable picker shows availability coverage across selected lead list.
- [ ] Warn before launch when a required variable is missing for a material share of leads.
- [ ] Define fallback syntax or conditional content; never send raw unresolved `{{token}}`.
- [ ] Sample preview can cycle through several real leads, not only a synthetic sample.

Optional later:

- [ ] AI-assisted personalization draft at campaign setup, but never make opaque generated content a prerequisite for sending.

---

# 19. P2 — Lead sources and signal-triggered campaign entry

Market leaders increasingly start campaigns from a signal, not only a static CSV/list.

## Static sources

- [ ] CSV.
- [ ] Existing Trevra list.
- [ ] Paste LinkedIn profile URLs.

## LinkedIn-derived sources where deployment policy permits

- [ ] Search / Sales Navigator result source.
- [ ] Recruiter result source.
- [ ] Post engagers / commenters.
- [ ] Event attendees.
- [ ] Group members.
- [ ] Company employees.

## Signal entry

- [ ] Lead viewed sender's profile.
- [ ] Lead engaged with a tracked post.
- [ ] Lead joined / attended configured event where detectable.
- [ ] Lead changed job / role when supplied by an external signal source.

Signal campaigns still use the same admission controller; a burst of 500 engagers must not bypass wave capacity.

---

# 20. P3 — Company / event / group engagement actions

These appear in Linked Helper / Expandi-style products but are not core cold-outreach parity.

Evaluate one-by-one:

- [ ] Follow company.
- [ ] Like company post.
- [ ] Invite 1st-degree connection to follow company.
- [ ] Invite connection to event.
- [ ] Invite connection to group.
- [ ] Group-member messaging where LinkedIn legitimately exposes the message surface.
- [ ] Event-attendee messaging where LinkedIn legitimately exposes the message surface.

For every action:

- [ ] Add a capability/eligibility check.
- [ ] Dedicated driver selector surface if necessary.
- [ ] Pacing band / limit policy.
- [ ] Ledger action kind.
- [ ] Replay/idempotency semantics.
- [ ] Analytics.
- [ ] Graceful skip when the action is unavailable to that target.

Do not add an action to the builder before the worker can execute and verify it end to end.

---

# 21. P3 — Workflow editor UX

Avoid a mandatory free-form graph for simple campaigns, but support advanced branching clearly.

## Simple mode

- [ ] Vertical timeline.
- [ ] Connection request visually expands into Accepted / Not Accepted lanes.
- [ ] Message can visually expand into Replied / No Reply lanes when a monitor is added.
- [ ] Delay chip between actions.
- [ ] One-click add action.
- [ ] Starter templates.

## Advanced mode

- [ ] Condition nodes with YES / NO branches.
- [ ] Monitor nodes with timeout.
- [ ] End nodes.
- [ ] Drag/reorder where semantically valid.
- [ ] Prevent invalid cross-branch drag rather than saving a broken graph.
- [ ] Mini-map / branch collapse only if workflows become large enough to justify it.

## Builder validation UX

- [ ] Every disabled Save explains why.
- [ ] Every invalid node displays its own reason.
- [ ] Detect unreachable nodes.
- [ ] Detect open branch with no End.
- [ ] Detect impossible action eligibility.
- [ ] Detect capacity bottleneck before save/launch.

---

# 22. P3 — Campaign editing / version lifecycle

Trevra's current snapshot behavior is a strength. Preserve it and make edits explicit.

- [ ] Editing reusable Workflow creates a new version.
- [ ] Running campaign remains on its snapshot by default.
- [ ] Campaign page shows workflow version.
- [ ] "Apply latest workflow" requires explicit operator action.
- [ ] Safe upgrade option can apply only to **pending/unadmitted** leads while already-admitted waves stay on the old snapshot.
- [ ] Advanced migration of in-flight leads between workflow versions is out of scope until there is a formal step-mapping model.
- [ ] Duplicate Campaign creates a new draft with same audience/workflow/settings but no live membership history.

---

# 23. P3 — Analytics required for wave-based operation

## Campaign funnel

- [ ] Total audience.
- [ ] Pending.
- [ ] Admitted / In Sequence.
- [ ] Invited.
- [ ] Accepted.
- [ ] Messaged.
- [ ] Replied.
- [ ] Completed.
- [ ] Failed.
- [ ] Excluded.

## Wave analytics

- [ ] Wave size.
- [ ] Admission timestamp.
- [ ] Time to first action.
- [ ] Time through each step.
- [ ] Acceptance rate.
- [ ] Reply rate.
- [ ] Failure rate.
- [ ] Backlog remaining.

## Step analytics

- [ ] Scheduled.
- [ ] Sent/executed.
- [ ] Skipped.
- [ ] Failed.
- [ ] Outcome rate.
- [ ] Median delay vs intended delay.
- [ ] Queue latency / overdue count.

## Variant analytics

- [ ] Invite note variants.
- [x] DM variant IDs already stored; extend display.
- [ ] Minimum sample before naming winner.
- [ ] Do not auto-kill a variant from tiny samples.

## Sender analytics

- [ ] Per-seat volume.
- [ ] Acceptance rate.
- [ ] Reply rate.
- [ ] Safety blocks / cooldowns.
- [ ] Campaign allocation.

## Bottleneck analytics

- [ ] "Why isn't this campaign moving?"
- [ ] Limiting action budget.
- [ ] Waiting-on-condition count.
- [ ] Pending because admission closed.
- [ ] Worker unavailable / browser batch halted.
- [ ] Seat working window closed.

---

# 24. P3 — Unified lead timeline and handoff

- [ ] One timeline per campaign member across profile views, follows, likes, invites, acceptance, DMs, replies, manual tasks, InMail/email later.
- [ ] Show workflow step ID/name beside each event.
- [ ] Show wave number.
- [ ] Show sender.
- [ ] Show branch taken and why.
- [ ] Show exact approved message variant.
- [ ] Human can pause/resume one lead.
- [ ] Human can end automation for one lead.
- [ ] Human can move lead to manual checkpoint where safe.
- [ ] Human reply keeps automation stopped unless explicitly resumed/re-enrolled.

---

# 25. P3 — Campaign-level schedules

Trevra has per-seat working schedules. Market tools also expose campaign schedules.

- [ ] Optional campaign start date/time.
- [ ] Optional campaign end date/time.
- [ ] Optional campaign working days / hours **within** the seat's allowed window.
- [ ] Campaign timezone defaults to seat timezone.
- [ ] Campaign schedule can narrow seat availability, never widen it.
- [ ] End date stops new admission first; define whether already-admitted leads may finish or are held/stopped according to operator choice.

Suggested options at end date:

- `Stop admitting new leads; finish current waves` (default).
- `Pause all campaign work`.
- `Stop campaign immediately` (destructive warning).

---

# 26. P3 — Failure recovery and operator controls

- [ ] Retry definite no-side-effect failures.
- [ ] Never retry unknown side effects automatically.
- [ ] Per-step failure reason visible.
- [ ] Bulk retry selected deterministic failures.
- [ ] Resume from exact workflow node.
- [ ] Re-run condition without re-sending previous action.
- [ ] Skip one step manually with audit reason.
- [ ] End one lead manually.
- [ ] Move selected leads to another follow-up campaign only with dedupe checks.

---

# 27. P3 — Team / agency controls around campaigns

- [ ] Workspace-level exclusion / do-not-contact policy.
- [ ] Campaign ownership.
- [ ] Sender ownership / permission checks.
- [ ] Template library scoped workspace vs personal.
- [ ] Role permissions for create/edit/start/pause/stop.
- [ ] Audit trail for campaign lifecycle changes.
- [ ] Client/workspace export of campaign results.
- [ ] Optional white-label reporting only if it fits broader Trevra product direction.

---

# 28. P4 — Optimization features after parity

These are differentiators, not blockers for parity.

## 28.1 Predictive wave sizing

- [ ] Forecast tomorrow's invite/message demand using observed acceptance/reply distributions.
- [ ] Admit enough leads to keep later stages full without building large queues.
- [ ] Confidence bands; fall back to conservative static behavior on small samples.
- [ ] Never override hard ceilings.

## 28.2 Target SLA per step

- [ ] Operator can define "follow up within N hours/days".
- [ ] Scheduler escalates overdue continuation work.
- [ ] UI reports SLA miss rate.

## 28.3 Auto-throttle from outcomes

- [ ] Reduce new admissions when acceptance rate falls materially.
- [ ] Reduce/stop outreach on high failure/challenge rates.
- [ ] Require enough sample before reacting.
- [ ] Explain every throttle in the campaign UI.

## 28.4 Recommended sequence diagnostics

- [ ] Detect too many touches.
- [ ] Detect repeated action bottleneck.
- [ ] Detect missing reply monitor between follow-ups.
- [ ] Detect no cleanup path for long-pending invites.
- [ ] Detect content missing variables across many leads.
- [ ] Suggest, never silently rewrite, the operator's workflow.

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

- [ ] Do not mark campaign completed while pending audience still exists merely because no currently admitted member is live.
- [ ] Do not admit new leads during campaign pause.
- [ ] Do not let a pending pool create future action rows before admission.
- [ ] Keep planning idempotent under concurrent ticks using existing workspace advisory locking.

---

# 31. Local-worker / browser-batch plan

Keep the existing physical batch abstraction.

- [ ] `linkedin_batches` remains one browser execution pass, not a campaign wave.
- [ ] Batch may contain actions from several campaigns on the same seat.
- [ ] Batch selection respects planned times and scheduler priority already encoded by planning.
- [ ] Continue per-action safety gate immediately before execution.
- [ ] Continue halting on challenge / limit wall / true selector drift.
- [ ] New engagement actions use dedicated driver surfaces.
- [ ] Monitor/condition nodes create no browser batch row unless their condition itself requires a read operation that cannot be answered from synchronized state.

---

# 32. API plan

Add/extend endpoints for:

- [ ] Campaign wave list.
- [ ] Campaign queue/backlog summary.
- [ ] Campaign pending/admission summary.
- [ ] Campaign priority update.
- [ ] Campaign admission policy update while paused / rules for live editing.
- [ ] Campaign schedule update.
- [ ] Workflow graph create/update/read.
- [ ] Workflow validation preview.
- [ ] Campaign launch preview with bottleneck/admission estimate.
- [ ] Per-member branch / timeline read.
- [ ] Manual member pause/resume/end/skip controls.

Keep heavy aggregate work server-side; do not create N+1 member reads from React.

---

# 33. Testing strategy

## Pure unit tests

- [ ] Workflow graph validation.
- [ ] Branch evaluation.
- [ ] Monitor deadline behavior.
- [ ] Admission controller.
- [ ] Priority ordering.
- [ ] Bottleneck calculations.
- [ ] Campaign preview estimates.
- [ ] Existing workflow compatibility normalization.

## DB integration tests

- [ ] Start leaves members pending.
- [ ] Admission creates stable waves.
- [ ] Downstream work beats new admission.
- [ ] Seat budget shared correctly across campaigns.
- [ ] Campaign priority affects allocation but never ceilings.
- [ ] Reply stops future planned work.
- [ ] Acceptance wakes monitor and schedules accepted branch.
- [ ] Timeout enters not-accepted branch once.
- [ ] Pause holds planned work and blocks admission.
- [ ] Resume preserves member and wave state.
- [ ] New leads added live join pending pool.
- [ ] Campaign completes only when pending + live work are both exhausted.
- [ ] Multi-sender assignment stays stable.

## Worker/driver tests

- [ ] Like and endorse Managed Workflow actions execute existing engagement routines.
- [ ] Deterministic skip conditions do not halt whole batch.
- [ ] New InMail driver, if implemented, has selector-drift and unknown-outcome tests before being exposed in UI.

## Regression tests

- [ ] Existing linear workflows execute unchanged.
- [ ] Existing campaign snapshots remain readable.
- [ ] Existing A/B DM assignments remain stable.
- [ ] Existing campaign pause/resume behavior remains lossless.

---

# 34. Rollout order

Implement in this order; later items depend on earlier architecture.

## Milestone 1 — Correct the campaign execution model

- [ ] Pending admission state.
- [ ] Wave table / wave IDs.
- [ ] Admission controller.
- [ ] Drain-before-fill downstream priority.
- [ ] Campaign UI: Pending vs In Sequence + wave list.
- [ ] Completion semantics updated for pending pool.

**Definition of done:** a 1,000-lead campaign can run for days while only capacity-safe cohorts are admitted; the UI can explain exactly which leads are waiting and why.

## Milestone 2 — Conditional Managed Workflows

- [ ] Canonical Wait / Monitor / Condition / End.
- [ ] If Connected.
- [ ] Accepted / Not Accepted timeout branch.
- [ ] Replied / Not Replied branch.
- [ ] Compatibility for `requiresAcceptedConnection`.
- [ ] Advanced workflow editor branching UI.

**Definition of done:** the operator can build the market-standard Connected / Not Connected and Replied / No Reply paths without creating separate campaigns.

## Milestone 3 — LinkedIn action parity

- [ ] Like Post via existing engagement driver.
- [ ] Endorse via existing engagement driver.
- [ ] Connection-note A/B testing.
- [ ] Better deterministic skip semantics.
- [ ] Template library refresh.

**Definition of done:** Trevra covers the common LinkedIn-only warm -> connect -> engage -> follow-up action set of Dripify/HeyReach/We-Connect/Snov.io.

## Milestone 4 — Campaign controls parity

- [ ] Exclusions.
- [ ] Campaign priority.
- [ ] Campaign schedule.
- [ ] Multi-sender stable assignment.
- [ ] Queue/bottleneck analytics.
- [ ] Duplicate/rebuild campaign UX.

## Milestone 5 — InMail

- [ ] Seat capability.
- [ ] Open-profile condition.
- [ ] InMail driver.
- [ ] Credit safeguards.
- [ ] Analytics.

Do not expose until it is executable end to end.

## Milestone 6 — Email / enrichment / external handoff

- [ ] Email action.
- [ ] Email conditions.
- [ ] Find Email.
- [ ] LinkedIn -> email fallback.
- [ ] Webhook / CRM / external sequencer handoff.
- [ ] Cross-channel stop-on-reply.

## Milestone 7 — Extended market features

- [ ] Attachments / GIFs / voice where safe and testable.
- [ ] Company actions.
- [ ] Event/group actions.
- [ ] Signal-triggered campaign entry.
- [ ] Predictive wave sizing.

---

# 35. Recommended first engineering slice

Do not begin by adding InMail, email, or another action button. First make the campaign engine capable of waves.

Slice 1:

- [ ] Add `admitted_at` + `wave_id` and `linkedin_campaign_waves`.
- [ ] Change campaign start so members remain pending.
- [ ] Add a simple conservative admission controller using first-order action budgets.
- [ ] Admit one cohort per eligible admission pass.
- [ ] Rank already-admitted due work ahead of new admission.
- [ ] Add Pending / In Sequence / Wave N counts to campaign operations.
- [ ] Add tests proving a 1,000-lead campaign does not activate all 1,000 at once.

Then Slice 2:

- [ ] Generalize accepted-connection behavior into Monitor + branch.
- [ ] Add initial If Connected.
- [ ] Add reply/no-reply monitor.

Then Slice 3:

- [ ] Wire Like and Endorse into Managed Workflows.
- [ ] Add invite-note A/B variants.

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

- [ ] A campaign with 10,000 leads does not imply 10,000 active LinkedIn journeys at launch.
- [ ] The operator can see Pending, In Sequence, and individual waves.
- [ ] New leads are admitted only when downstream capacity can absorb them.
- [ ] Due follow-ups are not starved by new lead acquisition.
- [ ] Mixed connected/not-connected lists route correctly.
- [ ] Connection acceptance can wake the next step immediately.
- [ ] Not-accepted leads follow an explicit timeout path.
- [ ] Replies stop all remaining automation.
- [ ] The common warm-up actions View / Follow / Like / Endorse are usable in Managed Workflows.
- [ ] Campaign-level exclusions prevent accidental duplicate outreach.
- [ ] Multi-sender campaigns keep each lead on one stable sender.
- [ ] The UI can answer "Why isn't this lead/campaign moving?" without reading logs.
- [ ] Workflow edits cannot silently mutate already-running waves.
- [ ] Every action exposed in the builder is actually executable and verifiable by the worker.
- [ ] InMail/email features, once exposed, are first-class channels with the same queue, branch, idempotency, safety, and analytics rules—not sidecar hacks.

That is the target architecture: **Audience -> Pending Pool -> Capacity-Aware Waves -> Branching Workflow Queues -> Downstream-Priority Scheduling -> Human-Like LinkedIn Visits/Batches -> Outcome-Driven Next Waves.**
