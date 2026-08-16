# Product journeys, usability contract, and autonomous release work

Status: current release record, 2026-08-16.

This document answers three questions in one place:

1. **What Trevra already is today.**
2. **How a person is supposed to move through it without learning the codebase.**
3. **What autonomous production and usability work is included in the working tree that contains this document.**

It is intentionally broader than a UI checklist. Trevra's usability depends on
routing, tenancy, deployment behavior, safety boundaries, background workers and
failure recovery being understandable together.

---

## 1. What exists today

### Product shell

Trevra is one GTM loop with five primary destinations:

| Destination | Job |
| --- | --- |
| **Loop** | Show where the GTM loop is stuck and give one next action. |
| **Outreach** | Operate sending accounts, prospect inputs, campaigns and replies. |
| **Money** | Review prepared work around agreements, delivery, invoicing and collection. |
| **Ledger** | Inspect what agents/workflows actually did and the evidence behind it. |
| **Setup** | Configure access, data sources and limits that change infrequently. |

The shell also has a persistent stop surface, contextual help, keyboard shortcuts,
workspace switching, theme control and direct URLs for app screens.

### Agent operation

- Claude Code and Codex can connect over scoped MCP agent tokens.
- Tokens can read and prepare but cannot approve or execute.
- Trevra can optionally run an agent on a workspace's own provider key or
  accepted CLI subscription token.
- Model spend has a monthly cap and an explicit off switch.
- Agent runs and approvals are visible in the Ledger.

### Outreach

- Multiple LinkedIn sending accounts per workspace.
- Per-account timezone, working days/hours, operator ceilings and safety bands.
- Warm-up, acceptance-rate controls, cooldown behavior and explicit pause/resume.
- Target-company import/scoring with evidence-backed reasons.
- LinkedIn source walks for people/search/post/keyword discovery where enabled.
- Lead lists.
- Reusable workflows with waits, branches, variants and manual steps.
- Managed campaigns binding one sending account + lead list + workflow.
- Campaign/member pause, resume, stop and manual-message tasks.
- Inbox sync, thread reading and guarded replies.
- Send queue, dry-run planning, advanced approval/export path and analytics.
- Pending invite withdrawal workflow.
- Never-contact/exclusion controls.

### Revenue / money side

- Connected email/accounting/integration sources through Nango.
- Agreement/document import and marketplace CSV import.
- Client commercial timelines and scope ledger.
- Recommendations for scope creep, stale proposals, unbilled work and overdue
  invoices.
- Evidence/proof packs.
- Exact-payload approval before external writes.
- Revenue-at-risk, ready-to-invoice and collected metrics.

### Workspaces and hosted tenancy

- Better Auth workspace/organization mapping.
- Google OAuth hosted sign-in.
- Hosted password signup disabled until a verified-email flow exists.
- Workspace-scoped authorization and owner-only privileged operations.
- Agent token scope separation.
- Per-workspace quota controls.
- Composite tenant constraints/hardening migrations and hosted readiness checks.
- Workspace export/erasure and disconnect cleanup paths.

### Production operations

Two supported production shapes exist in this tree:

1. **Single-operator self-hosted** — dedicated production Compose profile,
   loopback-only HTTP option, production Postgres, migrations, API, worker,
   backups and hardened containers.
2. **Hosted multi-tenant on Oracle Cloud** — Cloudflare Tunnel ingress, private
   Postgres, hosted runtime mode, one-shot migration/hardening job, backup before
   migration, then API/worker rollout.

---

## 2. Primary users and use cases

### Founder / seller: win new business

Goal: create a safe outbound campaign without learning Trevra's internal data
model.

Journey:

`Sign in → Loop → Win new business → LinkedIn account → lead list → workflow → campaign → Start → Inbox`

The user should never need to know the words `seat_key`, `replay_scope`, lease,
ledger row or migration.

### Founder / operator: get paid for completed work

Goal: connect evidence and see the first thing requiring a commercial decision.

Journey:

`Sign in → Loop → Get paid for work → Agent access → Data → Clients/agreements → Money → Approve/reject → Ledger`

A recommendation is an outcome, not a setup requirement.

### Returning operator: tend the loop

Goal: spend as little attention as possible deciding what actually needs a human.

Journey:

`Loop → one stuck stage / one next action → resolve → Loop`

Exceptions such as a paused account, waiting approval, manual campaign message or
o data connection should name the exact route that clears them.

### Team owner

Goal: invite collaborators without granting every member the ability to alter
security-sensitive policy, credentials or destructive state.

Workspace switching and team settings are available, while owner-only server
authorization remains the final authority regardless of UI visibility.

---

## 3. Information architecture after this usability pass

### Five primary destinations only

The separate **Accounts** primary-nav item is removed. It described target
companies while **Account** inside Outreach described the LinkedIn identity that
sends. The singular/plural distinction was doing conceptual work a user should
never have to do.

Target-company scoring now lives at:

`/outreach/accounts` → **Outreach → Target accounts**

The old `/leads` URL remains a compatibility alias and is replaced in history so
Back does not bounce through obsolete navigation.

### Outreach language

Primary outreach sub-routes now say what the objects are:

- **LinkedIn accounts** — identities that send.
- **Target accounts** — companies worth pursuing.
- **Find people** — people discovered from LinkedIn sources.
- **Campaigns** — lead list + workflow + sending account.
- **Inbox** — replies and manual messages.

The advanced path remains available as Plan, Approve & export, and Send queue,
but it is visually separated from the primary managed-campaign workflow.

### LinkedIn setup has one first-time door

First-time CTAs now point to **Outreach → LinkedIn accounts**, which already
supports add/switch/manage and the settings required to operate an account.

`Setup → LinkedIn settings` remains a detailed settings route for an active
account; it is no longer the place a new user is sent merely because no account
exists.

---

## 4. First-run usability improvements in this release

### A. One outcome at a time

Before this pass, a brand-new workspace could show both outreach setup and revenue
setup simultaneously. It made signup read as a prerequisite list for two products.

Now Loop presents two explicit outcomes:

- **Win new business**
- **Get paid for work**

Only one checklist is expanded. The choice is a local presentation preference;
it does not mutate business state.

### B. Every check mark is verifiable

The prior outreach checklist contained rows deliberately marked "untracked".
They could stay visually incomplete even after the user did the work.

Loop now reads the actual lead lists, workflows and managed campaigns. Completion
comes from:

- configured LinkedIn account;
- saved lead list;
- saved workflow;
- campaign;
- live agent token;
- live non-demo connection;
- imported client.

There is no fake completion flag.

### C. Exactly one next setup action

The selected checklist shows the full order, but only the earliest incomplete
step gets the primary button. Later steps remain visible for orientation without
looking equally urgent.

### D. Recommendations are not onboarding

The old money checklist treated "Review what your agent found" as a completion
step. That can never be a reliable setup condition: a healthy workspace may have
nothing requiring approval.

Money-side setup now ends when the agent, data source and client/agreement data
exist.

### E. Campaign first run explains its prerequisites

An empty Campaigns page previously exposed campaign controls, result surfaces,
lead-list builders and workflow builders in a long page and expected the user to
infer the order.

It now states the four-step sequence and highlights one next prerequisite:

1. sending account;
2. lead list;
3. workflow;
4. campaign.

The campaign creation form is hidden until its prerequisites exist.

### F. New-user empty copy points back to the first-run flow

A blank recommendation list no longer tells every new user to "connect a tool",
which was wrong for someone whose first outcome is outreach. It now points to the
first setup on Loop and explains what will appear later.

### G. Mobile primary navigation returns to five items

The mobile tab bar had gained a sixth Accounts cell while its own layout comment
and product contract still assumed five. Removing the extra primary destination
restores the intended touch target budget and keeps desktop/mobile information
architecture aligned.

### H. Setup keeps common and safety-critical choices visible

Setup had grown into eight horizontal destinations. That made the rarest expert
surfaces consume the same navigation weight as connections, LinkedIn and limits.

The always-visible Setup choices are now:

1. Agent access;
2. Connections;
3. LinkedIn;
4. Limits;
5. Team.

Research, Reddit and Skills remain directly addressable routes and move under a
native **More…** selector. Limits deliberately stay visible because a safety
control is not expert configuration just because it is changed rarely.

### I. Campaign construction is a separate journey from campaign operation

`/outreach/manager` is now the returning-operator surface: campaign status,
results, manual work, and a collapsed read-only reference to campaign inputs.
It no longer embeds CSV import, workflow editing and campaign creation in the
same long page.

`/outreach/manager/new` is the construction journey. It checks the three real
prerequisites in order — sending account, lead list, workflow — and opens only
the first missing piece. Once all three exist, the campaign form becomes the
primary surface. Starting a campaign returns to the operating screen.

"Build it again" on a finished/stopped campaign stages the same account/list/
workflow in memory and opens the builder. Nothing is recreated until the user
reviews and submits the new campaign.

---

## 5. Autonomous production/security work included in this release

The working tree this document ships with includes more than the usability pass.
The following production work was completed autonomously before this journey
review and is intentionally preserved in the same release.

### Single-operator production

- Dedicated `compose.selfhost.yml` production stack.
- Secret/bootstrap/deploy/backup scripts.
- Production app + worker + Postgres with migration gate.
- Loopback-only HTTP exception for local self-hosting; public/hosted production
  still requires secure origins/cookies.
- HSTS / upgrade directives disabled only for the loopback HTTP profile.
- Hardened non-root/read-only application containers.
- Docker build context reduced to relevant source.
- Backup archive verification and restart recovery tested.
- Production dependency audit brought to zero known vulnerabilities at the time
  of release testing.

### Hosted multi-tenant hardening

- `TREVRA_DEPLOYMENT_MODE=hosted` enforced.
- Hosted secret custody requires `TREVRA_SECRETS_KEY`.
- One-shot migration job replaces per-process hosted boot migration.
- Hosted boot verifies schema and hardening state instead of mutating it.
- Better Auth organization migration/backfill included in release migration.
- Hosted password signup disabled; Google OAuth remains enabled.
- Per-seat LinkedIn proxy credentials moved out of plaintext seat rows into the
  encrypted workspace secret envelope.
- Hosted readiness refuses legacy plaintext proxy rows and deferred tenant
  hardening.
- CI image workflow gates publishing on dependency audit, PostgreSQL tests and
  production build.

### Oracle hosted rollout

- Two-micro Oracle deployment path hardened to:
  `verified backup → migration/hardening job → app/worker rollout → health`.
- Application releases avoid recreating healthy Postgres.
- Cloudflare Tunnel and Postgres images are pinned by digest in the production
  definitions.
- Pre-deploy custom-format PostgreSQL backups are verified with `pg_restore -l`
  and retained on the data volume.
- Hosted app/worker run non-root, read-only, with reduced capabilities.

### LinkedIn execution/data correctness work already in the tree

- Multi-account switching and per-account scoping across inbox/queue/campaign
  surfaces.
- Hosted browser-provider abstraction and fail-closed behavior when absent.
- Encrypted browser/session custody paths.
- Reply-to-inbound and acceptance detection improvements.
- Replay-scope fixes allowing later replies in a conversation without weakening
  duplicate-submit protection.
- Guard/safety test expansion.
- Worker lease/hosted execution work and additional pacing/side-task behavior.
- Analytics consistency fixes and UI tests around campaign workflow behavior.

---

## 6. Safety and usability rules that must survive future changes

1. **One primary nav item per repeated founder job.** Configuration and helper
   lists live under the job they serve.
2. **One canonical first-time route for a prerequisite.** A missing LinkedIn
   account does not offer two different setup funnels.
3. **One primary action at a time in first run.** Showing the future sequence is
   useful; making every future step a button is not.
4. **Checkmarks require evidence.** Never infer completion from an adjacent
   object and never use an untracked checkbox as decoration.
5. **Creation and execution are separate decisions.** Creating a campaign,
   preparing an action or importing a list sends nothing.
6. **Safety refusal copy is not an error rewrite.** Surface the rule that stopped
   the action and the next move.
7. **Hosted capability gaps fail closed.** Do not render a "ready" state for a
   browser provider, credential vault or migration state that does not exist.
8. **Legacy URLs may redirect; legacy information architectures do not remain
   duplicated forever.**
9. **A recommendation is allowed to be absent.** "Nothing needs you" is a valid
   success state.
10. **Desktop and mobile navigation name the same product.**

---

## 7. Remaining usability backlog

These are not release blockers for this pass, but they are the next highest-value
journey improvements:

1. **Hosted LinkedIn execution onboarding.** The Oracle hosted platform currently
   has no remote browser provider configured, so server-side LinkedIn execution
   must continue to fail closed. When a provider is chosen, onboarding should
   explain the hosted session/proxy model before asking for credentials.
2. **First actual-device mobile pass.** Responsive CSS is present, but the five
   primary tabs, long outreach sub-nav, campaign tables and inbox should be
   exercised on narrow physical devices with touch and safe-area insets.
3. **Screen-reader journey pass.** Focus trapping, skip links, live-region toasts
   and labels exist; the end-to-end first-run and campaign flows should still be
   tested with a real screen reader rather than inferred from markup.
4. **Team onboarding.** Invite/role flows should get the same "one next step"
   treatment as first-run setup, especially for members who cannot perform
   owner-only actions.
5. **Reduce duplicated explanatory copy.** The product deliberately explains
   safety decisions, but several LinkedIn screens still carry long paragraphs.
   Move durable education into contextual Help when the same text does not need
   to be visible for every decision.

---

## 8. Release acceptance criteria

Before this work is pushed/deployed:

- `git diff --check` clean;
- TypeScript typecheck green;
- relevant route/client tests green;
- complete PostgreSQL-backed test suite green;
- production build green;
- production dependency audit green;
- commit pushed to `origin/main`;
- an immutable image built from that commit;
- Oracle deploy uses the backup/migration gate;
- public health, auth mode, migration idempotency and runtime image identity
  verified after rollout.

The commit containing this document is the source record for this release.
