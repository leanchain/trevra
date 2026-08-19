# Outreach simplification — design

**Date:** 2026-08-20
**Scope:** the `/outreach` section — routes, nav, screens, and the legacy LinkedIn campaign subsystem behind it.
**Precedent:** `docs/superpowers/specs/2026-08-19-setup-simplification-design.md`. Same treatment, same rules: labels over prose, nothing inert, fewer screens to scan.

## Goals

1. Four screens, no tab machinery.
2. One campaign system, not two.
3. Nothing on the section that the operator cannot act on.
4. Less to maintain: no file over ~1,500 lines in this section.

## Current state

Nine routes behind three primary tabs plus a `⋯ More` `<select>` that pins extra tabs into the strip and persists them in `localStorage` (`trevra.outreach.pinned-tabs`, `src/client/App.tsx:120-145, 453-527`). Two complete LinkedIn campaign systems ship side by side: legacy (`src/server/linkedin/campaigns.ts`, `export.ts`, `queue.ts`, eleven `/api/linkedin/campaigns*` routes, `src/client/LinkedInCampaigns.tsx`) and managed (`src/server/linkedin/managed-campaigns.ts`, `src/client/LinkedInManagerRead.tsx` + builder + three config files).

## Target shape

| Tab         | Path                 | Component                             |
| ----------- | -------------------- | ------------------------------------- |
| Campaigns   | `/outreach`          | `OutreachManagerRead`                 |
| — (builder) | `/outreach/new`      | `OutreachManagerBuilder`              |
| Messages    | `/outreach/inbox`    | `OutreachInbox`                       |
| Posts       | `/outreach/posts`    | `LinkedInPosts`                       |
| Settings    | `/outreach/settings` | `LinkedInAccounts` (split, see below) |

`SUB_ROUTES.outreach` becomes `['', 'new', 'inbox', 'posts', 'settings']`. The sidebar nav item points at `/outreach`.

### Redirects

| From                                             | To                                                          |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `/outreach/manager`                              | `/outreach`                                                 |
| `/outreach/manager/new`                          | `/outreach/new`                                             |
| `/outreach/manager/:id`                          | `/outreach` (no managed-campaign detail route exists today) |
| `/outreach/campaigns`, `/outreach/campaigns/:id` | `/outreach`                                                 |
| `/outreach/plan`                                 | `/outreach`                                                 |
| `/outreach/activity`                             | `/outreach`                                                 |
| `/outreach/queue`                                | `/outreach` (existing redirect, retargeted)                 |
| `/outreach/accounts`                             | `/outreach#accounts`                                        |
| `/outreach/leads`                                | `/outreach#leads`                                           |
| `/leads` (shell path)                            | `/outreach#accounts`                                        |

Anchors reuse the Setup mechanism verbatim: a `{ id, seq }` state and the shared `scrollToId` helper in `src/client/ui/scrollToId.ts`. A repeat navigation to the same anchor re-fires because `seq` changes.

### Folds

The Campaigns screen gains two collapsed `<details className="mgr-inputs">` blocks below the campaign list, in this order:

- `id="leads"` — **Find people**, rendering `OutreachLeads` (`src/client/LinkedInLeads.tsx`).
- `id="accounts"` — **Target accounts**, rendering `AccountsScreen` (`src/client/AccountsScreen.tsx`).

Both components keep their current props and behaviour. `LinkedInLeads.tsx:460`'s `navigate('/outreach/campaigns')` becomes `navigate('/outreach/new')`. `LinkedInManagerLeadConfig.tsx:955,1003`'s two `/outreach/leads` links become in-page `#leads` anchors.

## Deletions

### Client

- `src/client/LinkedInCampaigns.tsx` (3,325 lines) — `OutreachCampaigns` and `OutreachPlan` both go.
- `src/client/LinkedInActivity.tsx` (187 lines) — `/ledger` is the run surface.
- The pinned-tab machinery in `App.tsx`: `OUTREACH_MORE_ROUTES`, `OUTREACH_PINNED_TABS_STORAGE_KEY`, `readPinnedOutreachTabs`, `pinnedOutreachTabs` state, both effects, the `⋯ More` `<select>`, and the pinned-tab markup.
- Dead exports: 40 in `src/client/api.ts`, 4 in `src/client/LinkedInSafety.tsx` (`ACTION_STATUS_LABELS`, `humanizeRule`, `SeatLimitsRead`, `SeatStop`), `ACCOUNT_KEY_PATTERN` in `LinkedInAccounts.tsx`. Each is deleted only after confirming zero importers.
- `src/client/ui/HelpPanel.tsx` entries for `/outreach/accounts`, `/outreach/leads`, `/outreach/campaigns`, `/outreach/plan`.
- `LinkedInAnalyticsScreen.tsx:215`'s link to `/outreach/campaigns` → `/outreach`.
- The CSS for `.outreach-more-select`, `.outreach-pinned-tab`, `.outreach-pinned-open`, `.outreach-pinned-close`, and any rule left with no matching class.

### Server — extract first, then delete

`src/server/linkedin/campaigns.ts` is two modules fused. The shared half moves to a new `src/server/linkedin/actions.ts` with no behaviour change:

`LinkedInApiError`, `CampaignStatus`, `LinkedInActionView`, `listActions`, `getAction`, `skipAction`, `ingestOutcome`, `recordDetectedAcceptance`, `writeActionStatus`, `linkedinAnalytics`.

These are load-bearing for the managed system: `LinkedInApiError` is the error type `linkedinRoute()` catches (`app.ts:6489`) and every `/api/linkedin/manager/*` route throws; `CampaignStatus` is re-used as `ManagedCampaignStatus` (`managed-campaigns.ts:24`); `linkedinAnalytics` feeds `loop-cost.ts` and `LinkedInAnalyticsScreen.tsx` over legacy _and_ managed rows; the Messages tab runs on `listActions`/`getAction`/`skipAction` through `inbox.ts`, which the worker imports.

Only then delete:

- Legacy-only exports of `campaigns.ts`: `createCampaign`, `listCampaigns`, `getCampaign`, `stopCampaign`, `getCampaignBrief`, `countDeliveredActions`, `attachCampaignRun`, `newCampaignId`, and the export-record family.
- `src/server/linkedin/export.ts` (729 lines), `src/server/linkedin/queue.ts` (440 lines), and whatever remains of `campaigns.ts` after the extraction.
- The eleven `/api/linkedin/campaigns*` routes (`app.ts:3355-3978`).
- The `gtm.linkedin-outreach` playbook (`src/server/playbooks/registry.ts:448`) and its MCP exposure.
- A new migration dropping `linkedin_exports` (created by migration 025). `linkedin_campaigns` and `linkedin_actions` are shared with the managed system and the worker — they stay.

The CSV export path has no managed equivalent and is not replaced. That is the accepted cost of the decision.

## Settings split

`src/client/LinkedInAccounts.tsx` is 3,373 lines and the section's largest file. It splits by responsibility, no behaviour change:

| File                        | Contents                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LinkedInActiveAccount.tsx` | active-seat store, `setActiveSeatKey`, `useActiveSeatKey`, `ActiveLinkedInAccountName`, `slugifyAccountKey` — the module eight other files import |
| `LinkedInCompanion.tsx`     | `LinkedInCompanionAttention`, `CompanionPanel`, `WorkerNotice`                                                                                    |
| `LinkedInAccountForm.tsx`   | `AddAccountForm`, `EditAccountForm`, `TimezoneField`, `TimezoneOptions`, `ProxyField`, `ScheduleFields`, `BandOverrideField`, `draftToPatch`      |
| `LinkedInAccounts.tsx`      | the screen, `AccountPanel`, `AccountsTable`, `PendingInviteWithdrawals(+Section)`, `Wall`, `accountState`, `stateSentence`                        |

Always-open panels inside the screen collapse behind `<details>` per the audit's finding #1 (`docs/superpowers/specs/2026-08-19-app-wide-simplicity-audit.md`): the daily-limit configuration and `ProxyField` open only when they hold a non-default value.

## Out of scope

Messages (`OutreachInbox`), Posts (`LinkedInPosts`, mid-build), the managed campaign builder's three config screens, and every server route outside `/api/linkedin/campaigns*`.

## Milestones

1. **Routes and nav** — `SUB_ROUTES`, redirects, anchors, four tabs, pinned-tab machinery deleted. Route tests updated.
2. **Extract the action ledger** — `src/server/linkedin/actions.ts`, all importers repointed. Green suite before anything is deleted.
3. **Delete the legacy system** — routes, files, playbook, drop migration, client screen, `LinkedInActivity`.
4. **Folds** — the two `<details>` on Campaigns, the three cross-links repointed.
5. **Settings split + collapse.**
6. **Sweep** — dead exports, dead CSS, HelpPanel, `docs/app-spec.md`, `docs/first-run.md`, `docs/lead-spine.md`, `docs/product-journeys-and-autonomous-work.md`.

## Verification

- `npm run typecheck` clean.
- `npx vitest run src/client` and `src/server/app.test.ts` green; route tests cover every redirect in the table above.
- `npm test` (testcontainers Postgres) green on a host that can run it.
- Manual: every legacy URL in the redirect table lands on its target, and both anchors scroll and focus.

## Expected size

≈ −9,000 lines net, against ~800 relocated by the extraction.
