# Outreach Simplification — Design

**Date:** 2026-08-20
**Scope:** the whole `/outreach` section — routes, nav, screens, and the server-side legacy campaign system behind one of them.
**Precedent:** `docs/superpowers/specs/2026-08-19-setup-simplification-design.md`. Same treatment, same rules.
**Supporting analysis:** `.superpowers/notes/legacy-campaigns-blast-radius.md` (exact symbols, line ranges, importers). Implementers must read it before touching the server.

## Goals

1. Four screens, no optional-tab machinery.
2. Nothing inert: no route, table, endpoint, or MCP tool that nothing reaches.
3. Less to maintain: one campaign system, not two.
4. Labels only — no explanatory prose added anywhere. (Carried over from the Setup work.)

## Screens

| Tab         | Path                 | Component                              |
| ----------- | -------------------- | -------------------------------------- |
| Campaigns   | `/outreach`          | `OutreachManagerRead`                  |
| — (builder) | `/outreach/new`      | `OutreachManagerBuilder`               |
| Messages    | `/outreach/inbox`    | `OutreachInbox`                        |
| Posts       | `/outreach/posts`    | `LinkedInPosts`                        |
| Settings    | `/outreach/settings` | `LinkedInAccounts` (split — see below) |

`SUB_ROUTES.outreach` becomes `['', 'new', 'inbox', 'posts', 'settings']`. The sidebar entry points at `/outreach`.

### Redirects

Every legacy sub-route resolves rather than 404s. Anchors are scroll positions only — the router never reads the fragment (`src/client/ui/route.ts` contract).

| From                                             | To                                     |
| ------------------------------------------------ | -------------------------------------- |
| `/outreach/manager`                              | `/outreach`                            |
| `/outreach/manager/new`                          | `/outreach/new`                        |
| `/outreach/manager/:id`                          | `/outreach/:id`                        |
| `/outreach/campaigns`, `/outreach/campaigns/:id` | `/outreach`                            |
| `/outreach/plan`                                 | `/outreach`                            |
| `/outreach/activity`                             | `/outreach`                            |
| `/outreach/queue`                                | `/outreach` (already redirected today) |
| `/outreach/leads`                                | `/outreach#leads`                      |
| `/outreach/accounts`                             | `/outreach#accounts`                   |
| `/leads` (shell path)                            | `/outreach#accounts`                   |

Reuse the Setup implementation exactly: an `OUTREACH_LEGACY_REDIRECTS` map, an `OUTREACH_LEGACY_ANCHORS` map, `{ id, seq }` anchor state, and the shared `src/client/ui/scrollToId.ts` helper.

## Nav

Delete the optional-tab mechanism entirely: `OUTREACH_MORE_ROUTES`, `OUTREACH_PINNED_TABS_STORAGE_KEY`, `readPinnedOutreachTabs`, the `pinnedOutreachTabs` state and its two effects, the pinned-tab and `⋯ More` markup, and the `.outreach-more-select` / `.outreach-pinned-*` CSS. `OUTREACH_ROUTES` becomes the four tabs above.

## Folds

The Campaigns screen gains two collapsed disclosures below the campaign list, using the established `<details className="mgr-inputs">` + `<summary>` + `.mgr-inputs-body` pattern:

- `id="leads"` — **Find people**: renders `OutreachLeads` (`src/client/LinkedInLeads.tsx`) unchanged.
- `id="accounts"` — **Target accounts**: renders `AccountsScreen` (`src/client/AccountsScreen.tsx`) unchanged.

Both are closed on mount, so neither fetches until opened. `LinkedInManagerLeadConfig.tsx:955` and `:1003` link to `/outreach#leads` instead of `/outreach/leads`. `LinkedInLeads.tsx:460` navigates to `/outreach` instead of the deleted `/outreach/campaigns`.

## Deletions — client

| What                                   | Where                                                                                                                                                  | Lines |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Legacy campaign builder + plan preview | `src/client/LinkedInCampaigns.tsx` (whole file: `OutreachCampaigns`, `OutreachPlan`)                                                                   | 3,325 |
| Activity screen                        | `src/client/LinkedInActivity.tsx` (whole file)                                                                                                         | 187   |
| Pinned-tab / More machinery            | `src/client/App.tsx`                                                                                                                                   | ~120  |
| Dead API surface                       | `src/client/api.ts` — the 40 exports with no importer, listed in the notes file                                                                        | ~400  |
| Dead helpers                           | `src/client/LinkedInSafety.tsx` — `ACTION_STATUS_LABELS`, `humanizeRule`, `SeatLimitsRead`, `SeatStop`; `LinkedInAccounts.tsx` — `ACCOUNT_KEY_PATTERN` | ~80   |
| Stale links                            | `src/client/ui/HelpPanel.tsx` (accounts/leads/campaigns/plan entries), `LinkedInAnalyticsScreen.tsx:215`                                               | ~20   |
| Dead CSS                               | `src/client/styles.css` — every selector orphaned by the above                                                                                         | ~150  |

`LinkedInCampaigns.tsx` is deleted, not trimmed. Any symbol still imported from it by a surviving file (verify before deleting) moves to the importer or to `LinkedInSafety.tsx`.

## Deletions — server

The legacy campaign system goes. `src/server/linkedin/campaigns.ts` is two modules in one file; the shared half is extracted first, then the legacy half is deleted with its dependents.

**Extract (must happen before any deletion):**

- `src/server/linkedin/errors.ts` (new) — `LinkedInApiError`. Imported by `app.ts` (`linkedinRoute()` at ~L6489, plus 16 throws in `/api/linkedin/manager/*`), `inbox.ts`, `lead-lists.ts`.
- `src/server/linkedin/action-ledger.ts` (new) — `listActions`, `getAction`, `skipAction`, `writeActionStatus`, `ingestOutcome`, `recordDetectedAcceptance`, `LinkedInActionView`, `CampaignStatus`, `WORKER_ONLY_STATUSES`/`isWorkerOnlyStatus`, `linkedinAnalytics`. Same import set `campaigns.ts` has today (`db`, `actions.js`, `seats.js`, `pacing.js`), so no new cycles.
- `managed-campaigns.ts:24` keeps aliasing `CampaignStatus` — it now imports it from `action-ledger.ts`.

**Then delete:**

| What                                  | Where                                                                                                                                                                  | Lines  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Legacy campaign CRUD + export records | `src/server/linkedin/campaigns.ts` (whole file, post-extraction)                                                                                                       | ~800   |
| CSV export                            | `src/server/linkedin/export.ts`                                                                                                                                        | 729    |
| Legacy approval queue                 | `src/server/linkedin/queue.ts`                                                                                                                                         | 440    |
| 11 `/api/linkedin/campaigns*` routes  | `src/server/app.ts` ~L3355–3978                                                                                                                                        | ~620   |
| MCP playbook                          | `gtm.linkedin-outreach` (`src/server/playbooks/registry.ts:449`), `LINKEDIN_PLAYBOOK_ID` (`app.ts:6478`) and its call sites (`app.ts:3492`, `:3600`, `:7469`, `:7623`) | ~80    |
| Their tests                           | `campaigns.test.ts`, `queue.test.ts`, `export*.test.ts`, legacy cases in `app.test.ts`                                                                                 | ~1,500 |

Outreach becomes UI-only: no MCP entry point starts a campaign. That is the accepted consequence of deleting the playbook.

**Migration:** a new `src/server/migrations/084_drop_linkedin_exports.sql` drops `linkedin_exports` (created by 025). It is the only table the legacy system owns outright. `linkedin_campaigns` and `linkedin_actions` are **shared** with the managed system and the worker — neither is touched, no columns are dropped.

## Settings split

`src/client/LinkedInAccounts.tsx` (3,373 lines) splits by responsibility. No behaviour changes in this step beyond default visibility.

| File                                         | Holds                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/LinkedInActiveAccount.tsx` (new) | The active-seat store: `setActiveSeatKey`, `useActiveSeatKey`, `ActiveLinkedInAccountName`, `slugifyAccountKey`, and the subscribe/snapshot internals. Imported by 8 files — this split is what stops those files pulling in the whole settings screen. |
| `src/client/LinkedInCompanion.tsx` (new)     | `LinkedInCompanionAttention`, `CompanionPanel`, `WorkerNotice`.                                                                                                                                                                                         |
| `src/client/LinkedInAccountForm.tsx` (new)   | `AddAccountForm`, `EditAccountForm`, `TimezoneField`, `TimezoneOptions`, `ProxyField`, `ScheduleFields`, `BandOverrideField`, `draftToPatch`.                                                                                                           |
| `src/client/LinkedInAccounts.tsx` (remains)  | The screen, `AccountPanel`, `AccountsTable`, `PendingInviteWithdrawals(Section)`, `Wall`, `accountState`, `stateSentence`.                                                                                                                              |

Re-export nothing for compatibility — update every importer.

**Collapse (audit finding #1, `docs/superpowers/specs/2026-08-19-app-wide-simplicity-audit.md`):** `AccountPanel` renders collapsed by default rather than fully expanded; `ProxyField` and `ScheduleFields` stay inside their existing disclosures. A panel opens on mount only when its account is in a state that needs attention (`accountState` is not the healthy state).

## Docs

Update to the four-screen Outreach and remove references to deleted routes/screens: `docs/app-spec.md`, `docs/first-run.md`, `docs/lead-spine.md`, `docs/product-journeys-and-autonomous-work.md`, `docs/gtm-shell-shape.md`. Any doc naming `/outreach/campaigns`, `/outreach/plan`, `/outreach/activity`, `/outreach/leads`, `/outreach/accounts`, or the `gtm.linkedin-outreach` playbook is stale by definition.

## Out of scope

- The Messages (inbox) screen's internals — routes and file stay as they are.
- Scheduled posts beyond its new tab position; Milestone 1 work continues untouched.
- `linkedin_campaigns` / `linkedin_actions` schema.
- Loop, Ledger, Research, Setup.

## Milestones

1. **Routes and nav** — `SUB_ROUTES`, redirects, anchors, four tabs, pinned-tab machinery deleted, `route.test.ts` covers every legacy path.
2. **Server extraction** — `errors.ts` + `action-ledger.ts` created, every importer repointed, suite green. No deletions yet.
3. **Legacy deletion** — legacy `campaigns.ts`, `export.ts`, `queue.ts`, the 11 routes, the playbook, their tests, the drop migration.
4. **Folds** — Find people and Target accounts as closed disclosures on Campaigns; `LinkedInCampaigns.tsx` and `LinkedInActivity.tsx` deleted.
5. **Settings split + collapse** — four files, default-collapsed panels.
6. **Sweep** — dead `api.ts` / `LinkedInSafety.tsx` exports, dead CSS, HelpPanel, docs.

Each milestone ends green and is independently revertable. Milestone 2 must land before 3.

## Verification

- `npm run typecheck` clean after every milestone.
- `npx vitest run src/client` green after every client milestone; `npm test` (DB-backed, testcontainers) green after milestones 2 and 3.
- `npm run build` succeeds.
- Manual: each of the four tabs loads; every redirect in the table above lands on the right screen, with `#leads` / `#accounts` scrolling to and opening nothing that was not asked for; a managed campaign can still be created, run, and read.
- `grep` proves zero references to deleted symbols, routes, and paths.

## Expected size

≈ 9,000 lines removed, ≈ 900 relocated, against ~400 added (redirect tables, disclosures, split file headers).
