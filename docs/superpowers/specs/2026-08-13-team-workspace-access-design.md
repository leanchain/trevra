# Team workspace access for LinkedIn operation

Date: 2026-08-13
Status: approved, pending implementation plan

## Problem

Pankaj wants a teammate to operate the founder's LinkedIn seat from inside
Trevra — see the LinkedIn inbox, reply to conversations, work campaigns —
without ever being handed the LinkedIn password. "Just like Dripify."

Two things turned out to already be true and needed no work:

- The LinkedIn password is already write-only. `src/server/secrets/linkedin.ts`
  stores it sealed and no route, including `describeLinkedInCredentials`, ever
  returns it. This requirement was already satisfied before this spec.
- The LinkedIn inbox already supports replying, not just viewing
  (`src/client/LinkedInInbox.tsx`). A reply is queued as a gated
  `linkedin_actions` row and sent later by the self-hosted worker
  (`src/server/linkedin/local-worker.ts`), which runs unattended on the
  Oracle box using the stored credentials — no teammate machine or personal
  browser session is required to actually send anything.

The real gap: **Trevra has no concept of two humans in one workspace.**
`resolveBetterAuthIdentity` (`src/server/auth-service.ts:89-131`) creates a
brand-new, empty workspace for every email that has never signed in before.
There is no invite, no membership table, no role, and every route
(`requireSession`, `src/server/app.ts:2974`) trusts a single fixed
`{userId, workspaceId}` pair per user. Two people can never see the same
data today, regardless of what either of them wants.

A secondary finding worth recording: Dripify's own "Team" plan is not one
shared LinkedIn login operated by multiple humans — each teammate connects
their own LinkedIn account, and "team" adds shared visibility/dedupe across
those separate seats. What Pankaj asked for (one shared seat, two operators,
password withheld) is a level beyond Dripify's stock team model, closer to
Dripify's single-user inbox feature extended to a second human.

## Goals

- A teammate can log into Trevra with his own account and land in Pankaj's
  workspace, seeing everything Pankaj sees (LinkedIn inbox/campaigns/safety
  ledger, CRM, revenue, playbooks — full parity, per explicit decision below).
- The teammate can reply to LinkedIn conversations and work campaigns; those
  actions flow through the existing gated `linkedin_actions` queue exactly as
  they do for the founder today.
- The teammate never sees, and cannot retrieve, the LinkedIn password.
- The teammate can also keep his own separate Trevra workspace (e.g. his own
  clients/outreach) and switch between it and Pankaj's — membership is
  additive, not exclusive.
- Founder can see which of the two of them queued a given LinkedIn action.

## Non-goals

- Per-module/granular permissions (CRM vs. revenue vs. LinkedIn). Explicitly
  rejected in favor of full access for any member — see Decisions.
- Multiple LinkedIn seats per workspace (the "agency" case). Out of scope;
  `linkedin_seats` already documents this as deferred
  (`migrations/022_linkedin_seats.sql`), unaffected by this change.
- Custom fine-grained permission resources via better-auth's access-control
  system. One coarse role check (`owner` vs not) is enough for the one gated
  action this spec needs (LinkedIn credential management). YAGNI beyond that.
- Building an in-house invite/membership system. Better-auth's `organization`
  plugin is adopted instead — see Decisions.

## Decisions made during brainstorming

1. **Access scope**: full workspace parity for any member, not scoped to
   LinkedIn only.
2. **Credential control carve-out**: even with full access, only the
   workspace `owner` may replace/delete the stored LinkedIn credentials or
   delete the seat. This is the one and only role-gated action in this spec.
3. **Invite mechanism**: no formal "pending invite, must accept" step when
   the teammate already has a Trevra account — adding his email joins him
   instantly. A real invitation (with email or a copy-able link) is the
   fallback only when the email has never been seen before.
4. **Multi-workspace membership**: a person can belong to more than one
   workspace at once and switch between them (his own workspace *and*
   Pankaj's). This is the reason a bespoke "weld one email to one workspace"
   shortcut was rejected in favor of real membership.
5. **Implementation base**: adopt better-auth's `organization` plugin rather
   than a hand-rolled `workspace_members` table, since Trevra already runs
   better-auth for identity and the plugin's primitives (`member`,
   `invitation`, roles, active-organization-on-session) map directly onto
   requirements 1-4 above.

## Architecture

### Organization plugin as the membership source of truth

`src/server/auth-service.ts` gains the `organization` plugin
(`better-auth/plugins`). It adds three tables to the same Postgres database
Trevra already uses (`organization`, `member`, `invitation`), managed by
better-auth's own migration runner (`migrateAuthDatabase`, already called at
boot). Default roles (`owner`, `admin`, `member`) are used as-is — no custom
access-control statements. This workspace uses only `owner` and `member`.

### `workspaces` stays, becomes a shadow row

Trevra's own `workspaces` table is not removed: ~15 business tables
(`clients`, `invoices`, `linkedin_seats`, `linkedin_actions`, `recommendations`,
…) reference `workspace_id`, and none of those foreign keys change. Instead,
`workspaces.id` becomes *the same id* as the better-auth `organization.id` it
backs. An `organizationHooks.afterCreateOrganization` hook does what
`resolveBetterAuthIdentity`'s manual transaction does today: insert the
`workspaces` row, `workspace_settings` row, and default `automation_rules`,
keyed by the new organization's id.

`resolveBetterAuthIdentity` changes from "create workspace + user in one
transaction" to: on first-ever sign-in, create a better-auth organization
(which fires the hook above) via `auth.api.createOrganization`; on every
sign-in, still ensure Trevra's own `users` row exists (kept for existing
foreign keys — `audit_events.actor_id`, `approvals.user_id`,
`putLinkedInCredentials`'s `actorUserId`, `linkedin_actions.queued_by_user_id`
— see below). `users.workspace_id` stops being authoritative for access
control (a user is no longer 1:1 with a workspace) but is kept as a
"home workspace" reference for backfill/default purposes — see Migration.

### Active-workspace resolution — the one chokepoint

`requireSession` (`src/server/app.ts:2974-2998`) is the single place that
produces `req.auth: {userId, workspaceId, email}`, and every other route
consumes `req.auth.workspaceId` opaquely — confirmed by code search, no other
route reads a workspace id from anywhere else. This keeps the blast radius of
this change to one function plus the small number of net-new routes.

New resolution order inside `requireSession`:
1. Resolve the better-auth session as today (`resolveBetterAuthIdentity`).
2. Read `activeOrganizationId` off the better-auth session. If present *and*
   the user is still a member of it (defends against a stale cookie after
   removal), use it as `workspaceId`.
3. Otherwise, fall back to the user's own (owned) workspace — the one from
   `users.workspace_id` — and, as a side effect, call
   `auth.api.setActiveOrganization` so the fallback sticks for subsequent
   requests until the user switches again.

`req.auth` gains one field: `role` (`owner` | `member`) for the resolved
workspace, read from the `member` row, used only by the credential-route gate.

### Team management surface

No bespoke CRUD routes for membership — better-auth's client SDK
(`authClient.organization.*`) already exposes `addMember`, `inviteMember`,
`listMembers`, `removeMember`, `list` (workspaces the user belongs to), and
`setActive`. Trevra adds:

- A **Team settings** screen: lists current workspace's members + pending
  invitations (owner-only add/remove controls; a member sees the list
  read-only). "Add teammate" takes an email; server-side logic tries
  `organization.addMember` first (looked up by email against better-auth's
  own `user` table), falls back to `organization.inviteMember` when the
  email has no account yet.
- A **workspace switcher**: a dropdown in the app shell, shown only when
  `organization.list` returns more than one workspace, calling
  `organization.setActive` on selection and reloading.

### LinkedIn-specific pieces

- Credential routes (save/replace LinkedIn login, delete seat — the existing
  routes backed by `src/server/secrets/linkedin.ts`) add
  `if (req.auth.role !== 'owner') return res.status(403)...` at the top.
  Everything else under `/api/linkedin/*` is unchanged and open to any member.
- `linkedin_actions` gains a nullable `queued_by_user_id TEXT REFERENCES
  users(id) ON DELETE SET NULL` column. Every route that inserts a
  `linkedin_actions` row (reply queueing, sequence step queueing, withdrawal
  queueing) sets it from `req.auth.userId`. The inbox and queue views show
  "queued by <name>" using this column, resolved against `users`.

## Data model changes

New migration (after the current highest-numbered one):

```sql
-- better-auth's own migration runner adds organization/member/invitation
-- tables and two columns on its session table (activeOrganizationId,
-- activeTeamId) — not hand-written here, see migrateAuthDatabase().

ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS queued_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
```

Backfill (application code, run once at deploy time, not raw SQL — needs
better-auth's API to create matching `organization`/`member` rows correctly):
for every existing `workspaces` row, create a better-auth organization with
the same id (or map the existing id in directly, if the plugin allows an
explicit id on create — otherwise generate the org row directly in the same
transaction shape better-auth uses, matching its schema) and one `member` row
with `role='owner'` for that workspace's existing `users` row. This is the
step the implementation plan needs to get exactly right; flagged here rather
than hand-waved because getting it wrong silently locks every existing user
out of their own data.

## Risks / open implementation questions

- **Whether `organization.id` can be pinned to an existing `workspaces.id`
  at creation time** is not confirmed from the plugin's public docs (the
  `createOrganization` API shown there doesn't advertise an explicit `id`
  parameter). The architecture above assumes the ids can be made to match;
  the implementation plan must verify this against the installed better-auth
  version early — either by passing an id through database hooks / adapter
  config, or, if that's not possible, by storing an explicit
  `workspaces.better_auth_org_id` mapping column instead of relying on equal
  primary keys. Either way the rest of this design (shadow row per org,
  `requireSession` resolution) is unaffected — only the join key changes
  from "same id" to "same id via a mapping column."
- **Backfilling existing single-user workspaces into better-auth
  organizations** has to run through better-auth's own APIs/schema rather
  than hand-written SQL, since its tables are managed by its own migration
  runner. This is first-boot-after-deploy code, not a reversible dry-run-able
  SQL migration, so it needs a smoke test against a copy of production data
  before shipping, not just the idempotency unit test listed under Testing.

## Error handling & edge cases

- **Removing a member**: deletes the `member` row. If that user's
  `activeOrganizationId` pointed at the removed workspace, `requireSession`'s
  membership check (step 2 above) fails over to their own workspace on the
  very next request — no explicit "clear the session" step needed server-side
  beyond that check already being there.
- **Last-owner protection**: `removeMember` and any future role-downgrade
  path must reject removing/downgrading the sole remaining `owner` of a
  workspace. Better-auth does not enforce this itself; Trevra's Team-settings
  route does, before calling into the plugin.
- **Credential routes hit by a `member`**: 403, same shape as other
  authorization failures in this codebase (checked against existing route
  conventions during implementation).
- **Backfill idempotency**: the migration/backfill must be safe to re-run
  (e.g. `ON CONFLICT DO NOTHING` / existence checks) since better-auth's own
  migration runner already runs on every boot via `migrateAuthDatabase`.
- **Email already has its own workspace and gets added to Pankaj's**: no
  conflict — this is exactly goal 4 (additive membership, not exclusive).

## Testing

- `src/server/app.test.ts` / auth-service tests: two users, one workspace —
  second user added via `addMember` sees the same clients/invoices/LinkedIn
  data as the first.
- Credential route returns 403 for a `member`, 200 for an `owner`.
- Active-workspace resolution: switching, and falling back correctly when a
  membership is revoked mid-session.
- Backfill migration is idempotent and does not change `workspaceId` for any
  existing single-user workspace.
- Last-owner removal is rejected.
- `linkedin_actions.queued_by_user_id` is set on reply-queue and
  sequence-step-queue paths and rendered in the inbox/queue UI.
