# Outreach Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `/outreach` to four screens and delete the legacy LinkedIn campaign system it was hiding, UI and server.

**Architecture:** The section's markup moves out of `App.tsx` into `src/client/views/OutreachView.tsx`, which owns a four-tab strip, a legacy-redirect table with scroll anchors, and two collapsed disclosures that absorb the Find-people and Target-accounts screens. Server-side, `linkedin/campaigns.ts` is split: its shared half (error type, action ledger, analytics) is extracted to new modules, its legacy half is deleted along with `export.ts`, `queue.ts`, eleven routes, two control-plane action types, and the `gtm.linkedin-outreach` playbook.

**Tech Stack:** React 18 + TypeScript (Vite), Express + zod, vitest, Postgres via testcontainers, Prettier via a pre-commit hook.

**Design spec:** `docs/superpowers/specs/2026-08-20-outreach-simplification-design.md`
**Blast-radius analysis (read before any server task):** `.superpowers/notes/legacy-campaigns-blast-radius.md`

## Global Constraints

- **Never commit to `main`.** Every task starts by proving the working directory: `git rev-parse --show-toplevel && git branch --show-current`. The branch must be `outreach-simplification`.
- **The pre-commit hook runs Prettier and ABORTS the commit if it reformats anything.** That is normal. Re-run `git add <files>` and commit again. Never use `--no-verify`.
- **The router contract (`src/client/ui/route.ts` header comment):** a route is a PATH; a hash is only a scroll position and is never read for routing. Do not add hash routing.
- **UI copy is labels only.** Do not add explanatory sentences, hints, warnings, or help prose to any screen. This is a product decision, not a style preference.
- **Progressive disclosure pattern**, used verbatim wherever this plan asks for a collapsible block:
  ```tsx
  <details className="mgr-inputs">
    <summary>Label</summary>
    <div className="mgr-inputs-body">{/* content */}</div>
  </details>
  ```
- **No compatibility re-exports.** When a symbol moves file, update every importer; never leave `export { x } from './old'`.
- **Commands:** `npm run typecheck`; `npx vitest run <path>` for one file; `npm test` for the full DB-backed suite (needs Docker; if testcontainers cannot start, say so in the report rather than claiming green); `npm run build`.
- **Scope:** `/outreach` only. Do not touch Loop, Ledger, Research, Setup, or the `linkedin_campaigns` / `linkedin_actions` schema.

## File Structure

| File                                                                                                                                                               | Responsibility                                                      | Task  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----- |
| `src/client/ui/route.ts`                                                                                                                                           | Sub-route table for `outreach`                                      | 1     |
| `src/client/ui/route.test.ts`                                                                                                                                      | Parser coverage for new + legacy paths                              | 1     |
| `src/client/views/OutreachView.tsx` (new)                                                                                                                          | Tab strip, legacy redirects + anchors, folds, screen dispatch       | 2, 10 |
| `src/client/App.tsx`                                                                                                                                               | Loses the whole outreach block and its pinned-tab machinery         | 2     |
| `src/client/LinkedInManagerRead.tsx`, `LinkedInManagerBuilder.tsx`, `LinkedInManagerLeadConfig.tsx`, `LinkedInLeads.tsx`, `views/LoopView.tsx`, `ui/HelpPanel.tsx` | Internal links repointed                                            | 3     |
| `src/server/linkedin/errors.ts` (new)                                                                                                                              | `LinkedInApiError` — the LinkedIn surface's HTTP error type         | 4     |
| `src/server/linkedin/action-ledger.ts` (new)                                                                                                                       | Shared action reads/writes + `linkedinAnalytics` + `CampaignStatus` | 5     |
| `src/server/app.ts`                                                                                                                                                | Loses 11 legacy routes and the playbook constant                    | 6, 8  |
| `src/server/linkedin/campaigns.ts`, `export.ts`, `queue.ts`                                                                                                        | Deleted                                                             | 7     |
| `src/server/control-plane/execution.ts`                                                                                                                            | Loses `linkedin.export` / `linkedin.queue` action types             | 8     |
| `src/server/playbooks/registry.ts`                                                                                                                                 | Loses `gtm.linkedin-outreach`                                       | 8     |
| `src/server/migrations/084_drop_linkedin_exports.sql` (new)                                                                                                        | Drops the orphaned table                                            | 9     |
| `src/client/LinkedInCampaigns.tsx`, `LinkedInActivity.tsx`                                                                                                         | Deleted                                                             | 11    |
| `src/client/LinkedInActiveAccount.tsx` (new)                                                                                                                       | Active-seat store                                                   | 12    |
| `src/client/LinkedInCompanion.tsx` (new)                                                                                                                           | Companion attention/panel/worker notice                             | 13    |
| `src/client/LinkedInAccountForm.tsx` (new)                                                                                                                         | Add/edit account forms and their fields                             | 14    |
| `src/client/LinkedInAccounts.tsx`                                                                                                                                  | Settings screen only                                                | 12–15 |
| `src/client/api.ts`, `LinkedInSafety.tsx`, `styles.css`, `docs/*`                                                                                                  | Sweep                                                               | 16–18 |

---

## Task 1: Route table

**Files:**

- Modify: `src/client/ui/route.ts` (the `SUB_ROUTES` literal, `outreach` entry)
- Test: `src/client/ui/route.test.ts`

**Interfaces:**

- Produces: `SUB_ROUTES.outreach` accepts `'' | 'new' | 'inbox' | 'posts' | 'settings'` as live subs and `'accounts' | 'activity' | 'campaigns' | 'leads' | 'manager' | 'plan'` as legacy carriers that `OutreachView` (Task 2) redirects. A sub NOT in this list is normalised by `parseRoute` to the section root, which would destroy the redirect — that is why the legacy names stay listed.

- [ ] **Step 1: Write the failing test**

In `src/client/ui/route.test.ts`, inside the existing `describe('parseRoute', ...)` block, add:

```ts
it('parses the four outreach screens', () => {
  expect(parseRoute('/outreach')).toMatchObject({
    section: 'outreach',
    sub: '',
    path: '/outreach'
  });
  expect(parseRoute('/outreach/new')).toMatchObject({ section: 'outreach', sub: 'new' });
  expect(parseRoute('/outreach/inbox')).toMatchObject({ section: 'outreach', sub: 'inbox' });
  expect(parseRoute('/outreach/posts')).toMatchObject({ section: 'outreach', sub: 'posts' });
  expect(parseRoute('/outreach/settings')).toMatchObject({ section: 'outreach', sub: 'settings' });
});

it('keeps legacy outreach subs parseable so the view can redirect them', () => {
  for (const sub of ['manager', 'campaigns', 'plan', 'activity', 'leads', 'accounts']) {
    expect(parseRoute(`/outreach/${sub}`)).toMatchObject({ section: 'outreach', sub });
  }
  expect(parseRoute('/outreach/manager/new')).toMatchObject({ sub: 'manager', id: 'new' });
  expect(parseRoute('/outreach/campaigns/abc')).toMatchObject({ sub: 'campaigns', id: 'abc' });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/client/ui/route.test.ts`
Expected: FAIL — `/outreach/new`, `/outreach/posts` and `/outreach/settings` currently parse to `sub: ''`.

- [ ] **Step 3: Update the table**

In `src/client/ui/route.ts`, replace the `outreach` line of `SUB_ROUTES` with:

```ts
  // Live: '', new, inbox, posts, settings. The rest are legacy addresses kept
  // parseable so OutreachView can redirect them; parseRoute would otherwise
  // flatten them to the section root and lose the anchor.
  outreach: [
    '',
    'new',
    'inbox',
    'posts',
    'settings',
    'accounts',
    'activity',
    'campaigns',
    'leads',
    'manager',
    'plan'
  ],
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/client/ui/route.test.ts`
Expected: PASS. Any pre-existing assertion that expected `/outreach/manager/new` to keep `path: '/outreach/manager/new'` still holds — the parser is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/client/ui/route.ts src/client/ui/route.test.ts
git commit -m "outreach: route table for four screens"
```

---

## Task 2: OutreachView — tabs and redirects

**Files:**

- Create: `src/client/views/OutreachView.tsx`
- Modify: `src/client/App.tsx` (delete the outreach block at ~L453–546, the constants at ~L119–145, the state and effects at ~L261–285, and the now-unused imports)

**Interfaces:**

- Consumes: `SUB_ROUTES.outreach` from Task 1; `scrollToId` from `src/client/ui/scrollToId.ts`; `replaceNavigate`, `type Route` from `src/client/ui/route.ts`.
- Produces: `export function OutreachView({ route, setToast, onNavigate }: { route: Route; setToast: (message: string) => void; onNavigate: (path: string) => void })`. `App.tsx` renders `{route.section === 'outreach' && <OutreachView route={route} setToast={setToast} onNavigate={go} />}`.
- Produces: element ids `outreach-leads` and `outreach-accounts` — Task 10 attaches the folds to them.

- [ ] **Step 1: Create the view**

`src/client/views/OutreachView.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { LinkedInAccounts, LinkedInCompanionAttention } from '../LinkedInAccounts';
import { OutreachInbox } from '../LinkedInInbox';
import { OutreachManagerBuilder } from '../LinkedInManagerBuilder';
import { OutreachManagerRead } from '../LinkedInManagerRead';
import { LinkedInPosts } from '../LinkedInPosts';
import { replaceNavigate, type Route } from '../ui/route';
import { scrollToId } from '../ui/scrollToId';

const OUTREACH_TABS: ReadonlyArray<{ sub: string; path: string; label: string }> = [
  { sub: '', path: '/outreach', label: 'Campaigns' },
  { sub: 'inbox', path: '/outreach/inbox', label: 'Messages' },
  { sub: 'posts', path: '/outreach/posts', label: 'Posts' },
  { sub: 'settings', path: '/outreach/settings', label: 'Settings' }
];

/** Old addresses, and where each one now lives. */
const OUTREACH_LEGACY_REDIRECTS: Record<string, string> = {
  manager: '/outreach',
  campaigns: '/outreach',
  plan: '/outreach',
  activity: '/outreach',
  leads: '/outreach',
  accounts: '/outreach'
};

/** Legacy addresses whose content is now a fold on the Campaigns screen. */
const OUTREACH_LEGACY_ANCHORS: Record<string, string> = {
  leads: 'outreach-leads',
  accounts: 'outreach-accounts'
};

/** Which tab owns the screen being shown. Legacy subs are mid-redirect and own none. */
function activeSub(sub: string): string {
  if (sub === 'new') return '';
  return OUTREACH_TABS.some((tab) => tab.sub === sub) ? sub : '';
}

export function OutreachView({
  route,
  setToast,
  onNavigate
}: {
  route: Route;
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  const sub = route.sub;
  const [anchor, setAnchor] = useState<{ id: string; seq: number } | null>(null);
  const anchorSeq = useRef(0);

  useEffect(() => {
    const target = OUTREACH_LEGACY_REDIRECTS[sub];
    if (!target) return;
    const anchorId = OUTREACH_LEGACY_ANCHORS[sub];
    if (anchorId) setAnchor({ id: anchorId, seq: ++anchorSeq.current });
    // `/outreach/manager/new` was the builder's address.
    replaceNavigate(sub === 'manager' && route.id === 'new' ? '/outreach/new' : target);
  }, [sub, route.id]);

  useEffect(() => {
    if (!anchor) return;
    return scrollToId(anchor.id);
  }, [anchor]);

  const current = activeSub(sub);

  return (
    <div className="page-stack outreach-simple">
      <LinkedInCompanionAttention setToast={setToast} />
      <nav className="outreach-nav" aria-label="Outreach sections">
        {OUTREACH_TABS.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={tab.sub === current ? 'is-active' : undefined}
            aria-current={tab.sub === current ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {sub === 'inbox' && <OutreachInbox setToast={setToast} />}
      {sub === 'posts' && <LinkedInPosts setToast={setToast} />}
      {sub === 'settings' && <LinkedInAccounts setToast={setToast} />}
      {sub === 'new' && <OutreachManagerBuilder setToast={setToast} onNavigate={onNavigate} />}
      {sub === '' && <OutreachManagerRead setToast={setToast} onNavigate={onNavigate} />}
    </div>
  );
}
```

Note the anchor effect must return `scrollToId(anchor.id)` as its own cleanup — calling `setAnchor(null)` after it instead cancels the scroll before its first tick.

- [ ] **Step 2: Gut the outreach block in `App.tsx`**

Delete, in `src/client/App.tsx`:

- `OUTREACH_ROUTES`, `OUTREACH_MORE_ROUTES`, `OUTREACH_PINNED_TABS_STORAGE_KEY`, `readPinnedOutreachTabs` (~L119–145)
- the `pinnedOutreachTabs` state, its persistence effect, its deep-link pinning effect, and the `/outreach/queue` redirect effect (~L261–285)
- the whole `{route.section === 'outreach' && ( … )}` JSX block (~L453–546)
- imports left unused by the above: `LinkedInAccounts`, `LinkedInCompanionAttention`, `AccountsScreen`, `OutreachCampaigns`, `OutreachPlan`, `OutreachInbox`, `OutreachActivity`, `OutreachLeads`, `OutreachManagerBuilder`, `OutreachManagerRead`, `LinkedInPosts`, `X` (lucide)

Replace the deleted JSX block with:

```tsx
{
  route.section === 'outreach' && (
    <OutreachView route={route} setToast={setToast} onNavigate={go} />
  );
}
```

and add `import { OutreachView } from './views/OutreachView';` beside the other view imports.

Keep `useAccountsRoute` and its effect, but change the target: `if (accountsOpen) replaceNavigate('/outreach/accounts');` stays as-is — `/outreach/accounts` is a legacy carrier that `OutreachView` redirects to `/outreach#outreach-accounts`.

- [ ] **Step 3: Update the sidebar entry and the title map**

In `src/client/App.tsx`, the nav item at ~L108–112: `path: '/outreach/manager'` becomes `path: '/outreach'`.

In `viewTitle` (~L2735–2750), replace the outreach branch with:

```ts
if (route.section === 'outreach') {
  if (route.sub === 'inbox') return 'Messages';
  if (route.sub === 'posts') return 'Scheduled posts';
  if (route.sub === 'settings') return 'Outreach settings';
  if (route.sub === 'new') return 'New campaign';
  return 'Campaigns';
}
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS. Typecheck failures naming `OutreachCampaigns` or `OutreachActivity` mean a leftover import — remove it, do not re-add the block.

- [ ] **Step 5: Commit**

```bash
git add src/client/views/OutreachView.tsx src/client/App.tsx
git commit -m "outreach: four tabs in their own view"
```

---

## Task 3: Repoint internal links

**Files:**

- Modify: `src/client/views/LoopView.tsx` (L142, L161, L205, L447, L454, L461)
- Modify: `src/client/LinkedInManagerRead.tsx` (L1146, L1213, L1286)
- Modify: `src/client/LinkedInManagerBuilder.tsx` (L25 comment, L85, L118)
- Modify: `src/client/ui/HelpPanel.tsx` (the `/outreach/*` entries around L273–302)

**Interfaces:**

- Consumes: the paths produced by Task 2 (`/outreach`, `/outreach/new`, `/outreach/inbox`, `/outreach/posts`, `/outreach/settings`).

- [ ] **Step 1: Rewrite every link**

- `'/outreach/manager'` → `'/outreach'` (all six LoopView sites, both Builder sites).
- `'/outreach/manager/new'` → `'/outreach/new'` (three ManagerRead sites, the Builder doc comment).
- `LoopView.tsx:161`'s conditional keeps its shape: `href: limits ? (seat?.configured ? '/outreach' : '/outreach/settings') : null` — an unconfigured seat belongs on Settings, which is where account setup now lives.

- [ ] **Step 2: Fix the HelpPanel entries**

In `src/client/ui/HelpPanel.tsx`, delete the entries whose `path` is `/outreach/accounts`, `/outreach/leads`, `/outreach/campaigns`, or `/outreach/plan`, and rewrite the two survivors:

```ts
  { path: '/outreach', label: 'Outreach · Campaigns', hint: 'Campaigns, people and companies' },
  { path: '/outreach/new', label: 'Outreach · New campaign', hint: 'Build and start one' },
```

Keep every non-outreach entry untouched.

- [ ] **Step 3: Prove no stale links remain**

Run: `grep -rn "outreach/manager\|outreach/plan\|outreach/activity" src/client --include=*.tsx --include=*.ts | grep -v LinkedInCampaigns.tsx`
Expected: no output. (`LinkedInCampaigns.tsx` is deleted in Task 11 and is allowed to still reference them.)

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client
git commit -m "outreach: repoint internal links at the new paths"
```

---

## Task 4: Extract `LinkedInApiError`

**Files:**

- Create: `src/server/linkedin/errors.ts`
- Modify: `src/server/linkedin/campaigns.ts` (remove the class, import it back), `src/server/app.ts`, `src/server/linkedin/inbox.ts`, `src/server/linkedin/lead-lists.ts`, and every other importer found in Step 1

**Interfaces:**

- Produces: `export class LinkedInApiError extends Error { constructor(status: number, message: string, …) }` — moved verbatim from `campaigns.ts` L38ff, including its doc comment and any `status`/`code` fields. Do not change its shape.

**Read first:** `.superpowers/notes/legacy-campaigns-blast-radius.md` §1(b).

- [ ] **Step 1: List every importer**

Run: `grep -rn "LinkedInApiError" src --include=*.ts | grep -v "^src/server/linkedin/campaigns.ts"`
Write the list down; every file in it gets its import rewritten in Step 3.

- [ ] **Step 2: Create the module**

Move the class and its doc comment out of `src/server/linkedin/campaigns.ts` into `src/server/linkedin/errors.ts`, unchanged. The new file imports nothing from the LinkedIn package (it is a leaf), so no cycle is possible.

- [ ] **Step 3: Repoint imports**

Every file from Step 1 imports from `'./errors.js'` (or `'./linkedin/errors.js'` from `app.ts`) instead of `campaigns.js`. `campaigns.ts` itself imports it back where it still throws.

- [ ] **Step 4: Typecheck and run the affected suites**

Run: `npm run typecheck && npx vitest run src/server/linkedin`
Expected: PASS with no behaviour change — this task moves a class and nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/server
git commit -m "linkedin: extract LinkedInApiError"
```

---

## Task 5: Extract the shared action ledger

**Files:**

- Create: `src/server/linkedin/action-ledger.ts`
- Modify: `src/server/linkedin/campaigns.ts`, `src/server/app.ts`, `src/server/loop-cost.ts`, `src/server/linkedin/inbox.ts`, `withdraw.ts`, `runner.ts`, `guard.ts`, `managed-campaigns.ts`, `lead-lists.ts`, and the test files listed in Step 1

**Interfaces:**

- Consumes: `LinkedInApiError` from `./errors.js` (Task 4).
- Produces, all moved verbatim from `campaigns.ts`: `listActions`, `getAction`, `skipAction`, `writeActionStatus`, `ingestOutcome`, `recordDetectedAcceptance`, `linkedinAnalytics`, `type LinkedInActionView`, `type CampaignStatus`, `WORKER_ONLY_STATUSES`, `isWorkerOnlyStatus`. Signatures unchanged.
- The new module's imports are exactly the ones `campaigns.ts` has today — `../db.js`, `./actions.js`, `./seats.js`, `./pacing.js`, `./errors.js` — so it introduces no cycle.
- `managed-campaigns.ts:24` keeps aliasing `CampaignStatus` as `ManagedCampaignStatus`; only the import path changes.

**Read first:** `.superpowers/notes/legacy-campaigns-blast-radius.md` §1.

- [ ] **Step 1: List every importer of the moving symbols**

Run:

```bash
grep -rn "from '\(\.\|\.\.\)/*.*campaigns.js'" src --include=*.ts
```

Expected files: `app.ts`, `loop-cost.ts`, `linkedin/{inbox,withdraw,runner,guard,managed-campaigns,lead-lists}.ts` and the matching `*.test.ts`. For each, note which symbols it takes — some take only legacy ones (those imports die in Task 7 instead).

- [ ] **Step 2: Move the symbols**

Cut each symbol in the Interfaces list — with its doc comments and any private helper used only by them — from `campaigns.ts` into `action-ledger.ts`. Leave the legacy half (`createCampaign`, `listCampaigns`, `getCampaign`, `stopCampaign`, `getCampaignBrief`, `countDeliveredActions`, `attachCampaignRun`, `newCampaignId`, the export-record family) in place; Task 7 deletes it.

- [ ] **Step 3: Repoint imports**

Every importer from Step 1 takes shared symbols from `'./action-ledger.js'` and legacy symbols (if any) still from `'./campaigns.js'`. `campaigns.ts` imports what it still needs back from `./action-ledger.js`.

- [ ] **Step 4: Run the suites**

Run: `npm run typecheck && npm test`
Expected: PASS, unchanged counts. This is a pure move — a behaviour change here is a bug. If testcontainers cannot start Postgres, run `npx vitest run src/server/linkedin` and report the DB-backed gap honestly.

- [ ] **Step 5: Commit**

```bash
git add src/server
git commit -m "linkedin: extract the shared action ledger"
```

---

## Task 6: Delete the legacy campaign routes

**Files:**

- Modify: `src/server/app.ts` (the eleven `/api/linkedin/campaigns*` routes, ~L3355–3978)
- Modify: `src/server/app.test.ts`, `src/server/linkedin/api.test.ts` (their legacy cases)

**Interfaces:**

- Consumes: nothing new.
- Produces: no `/api/linkedin/campaigns*` route exists. `/api/linkedin/manager/*` is untouched.

**Read first:** `.superpowers/notes/legacy-campaigns-blast-radius.md` §2 — it lists each route with its line range and its only callers.

- [ ] **Step 1: Delete the routes**

Remove all eleven handlers: `POST/GET /api/linkedin/campaigns`, `POST /api/linkedin/campaigns/draft`, `PATCH /api/linkedin/campaigns/:id/sequence`, `GET/DELETE /api/linkedin/campaigns/:id`, `GET /api/linkedin/campaigns/:id/exports`, `GET /api/linkedin/campaigns/:id/export/:exportId`, `POST /api/linkedin/campaigns/:id/export`, `POST /api/linkedin/campaigns/:id/queue`, `POST /api/linkedin/campaigns/:id/stop`. Remove the imports left dangling at the top of `app.ts`.

- [ ] **Step 2: Delete their tests**

In `src/server/app.test.ts` and `src/server/linkedin/api.test.ts`, delete every case that requests one of those paths — including `api.test.ts:815`'s export-focused block and the `gtm.linkedin-outreach` assertion at `api.test.ts:916`. Do not weaken a surviving assertion to make it pass; if a case covers both legacy and managed behaviour, keep the managed half.

- [ ] **Step 3: Prove they are gone**

Run: `grep -rn "api/linkedin/campaigns" src --include=*.ts --include=*.tsx`
Expected: matches only inside `src/client/api.ts` and `src/client/LinkedInCampaigns.tsx`, both deleted in Tasks 11 and 16.

- [ ] **Step 4: Run the suites**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server
git commit -m "linkedin: delete the legacy campaign routes"
```

---

## Task 7: Delete `campaigns.ts`, `export.ts`, `queue.ts`

**Files:**

- Delete: `src/server/linkedin/campaigns.ts`, `export.ts`, `queue.ts`, `campaigns.test.ts`, `export.test.ts`, `queue.test.ts`
- Modify: any file still importing them

**Interfaces:**

- Consumes: `action-ledger.ts` and `errors.ts` from Tasks 4–5 — every surviving importer must already be pointed at those.

- [ ] **Step 1: Confirm nothing shared is left in the doomed files**

Run: `grep -n "^export " src/server/linkedin/campaigns.ts`
Every remaining export must be one of: `createCampaign`, `listCampaigns`, `getCampaign`, `stopCampaign`, `getCampaignBrief`, `countDeliveredActions`, `attachCampaignRun`, `newCampaignId`, or an export-record/type symbol. If a shared symbol is still listed, move it to `action-ledger.ts` first — do not delete it.

- [ ] **Step 2: Delete the six files**

```bash
git rm src/server/linkedin/campaigns.ts src/server/linkedin/campaigns.test.ts \
       src/server/linkedin/export.ts src/server/linkedin/export.test.ts \
       src/server/linkedin/queue.ts src/server/linkedin/queue.test.ts
```

- [ ] **Step 3: Fix the fallout**

Run `npm run typecheck` and remove every import it flags. Expected sites: `src/server/control-plane/execution.ts` L9–10 (handled fully in Task 8 — for now delete the two imports and the two `if (actionType === 'linkedin.export' | 'linkedin.queue')` blocks at L143–230), plus any residual test helper.

- [ ] **Step 4: Run the suites**

Run: `npm run typecheck && npm test`
Expected: PASS with the deleted files' cases gone from the count.

- [ ] **Step 5: Commit**

```bash
git add -A src/server
git commit -m "linkedin: delete the legacy campaign system"
```

---

## Task 8: Delete the `gtm.linkedin-outreach` playbook

**Files:**

- Modify: `src/server/playbooks/registry.ts` (the entry at ~L449)
- Modify: `src/server/app.ts` (`LINKEDIN_PLAYBOOK_ID` at ~L6478 and its call sites at ~L3492, ~L3600, ~L7469, ~L7623)
- Modify: `src/server/control-plane/execution.ts` (any residue of `linkedin.export` / `linkedin.queue`)
- Modify: the playbook's own tests, and `src/client/api.ts:1522`'s doc comment if the function it documents survives

**Interfaces:**

- Produces: the MCP surface no longer exposes a LinkedIn outreach playbook. `trevra_list_playbooks` returns one fewer entry; update any test asserting the full list rather than deleting the assertion.

- [ ] **Step 1: Delete the registry entry**

Remove the `id: 'gtm.linkedin-outreach'` object from `src/server/playbooks/registry.ts` and any step definitions used only by it.

- [ ] **Step 2: Delete the constant and its uses**

Remove `LINKEDIN_PLAYBOOK_ID` from `app.ts` and each site that reads it. Sites at ~L3492 and ~L3600 sit inside routes already deleted in Task 6; ~L7469 and ~L7623 merge playbook input — delete the LinkedIn-specific branch there, keeping the generic path intact.

- [ ] **Step 3: Confirm the control plane is clean**

Run: `grep -rn "linkedin.export\|linkedin.queue\|linkedin-outreach" src/server --include=*.ts`
Expected: no matches outside doc-comment references to `docs/linkedin-outreach-plan.md`.

- [ ] **Step 4: Run the suites**

Run: `npm run typecheck && npm test`
Expected: PASS. A playbook-count assertion that now fails should be updated to the new count, not deleted.

- [ ] **Step 5: Commit**

```bash
git add src/server src/client/api.ts
git commit -m "playbooks: drop gtm.linkedin-outreach"
```

---

## Task 9: Drop `linkedin_exports`

**Files:**

- Create: `src/server/migrations/084_drop_linkedin_exports.sql`

**Interfaces:**

- Consumes: nothing — every reader of the table died in Tasks 6–8.
- Produces: schema without `linkedin_exports`. `linkedin_campaigns` and `linkedin_actions` are shared and must NOT be touched.

- [ ] **Step 1: Confirm no code reads the table**

Run: `grep -rn "linkedin_exports" src --include=*.ts`
Expected: no matches. If any remain, they belong to Task 6 or 7 — finish those first.

- [ ] **Step 2: Write the migration**

`src/server/migrations/084_drop_linkedin_exports.sql`:

```sql
-- The legacy campaign system owned this table alone: rendered CSV/JSON export
-- blobs for `/api/linkedin/campaigns/:id/export`. Both the route and the
-- renderer are gone, and the managed campaign path drives the worker directly
-- instead of producing files, so nothing reads these rows.
DROP TABLE IF EXISTS linkedin_exports;
```

- [ ] **Step 3: Run the DB-backed suite**

Run: `npm test`
Expected: PASS — migrations run from scratch in the testcontainer, so a broken file fails immediately.

- [ ] **Step 4: Commit**

```bash
git add src/server/migrations/084_drop_linkedin_exports.sql
git commit -m "db: drop linkedin_exports"
```

---

## Task 10: Fold Find people and Target accounts into Campaigns

**Files:**

- Modify: `src/client/views/OutreachView.tsx`
- Modify: `src/client/LinkedInManagerLeadConfig.tsx` (L955, L1003), `src/client/LinkedInLeads.tsx` (L460)

**Interfaces:**

- Consumes: `OutreachLeads` from `../LinkedInLeads`, `AccountsScreen` from `../AccountsScreen`, both unchanged.
- Produces: the ids `outreach-leads` and `outreach-accounts` that Task 2's anchor map already targets.

- [ ] **Step 1: Add the folds**

In `src/client/views/OutreachView.tsx`, replace the `sub === ''` line with:

```tsx
{
  sub === '' && (
    <>
      <OutreachManagerRead setToast={setToast} onNavigate={onNavigate} />
      <details className="mgr-inputs" id="outreach-leads">
        <summary>Find people</summary>
        <div className="mgr-inputs-body">
          <OutreachLeads setToast={setToast} />
        </div>
      </details>
      <details className="mgr-inputs" id="outreach-accounts">
        <summary>Target accounts</summary>
        <div className="mgr-inputs-body">
          <AccountsScreen setToast={setToast} />
        </div>
      </details>
    </>
  );
}
```

and add the two imports. Both are closed on mount, so neither fetches until opened — that is the point of the fold, do not force them open.

- [ ] **Step 2: Make the anchors open what they scroll to**

`scrollToId` focuses the element but a closed `<details>` shows nothing. In the anchor effect, open the target first:

```tsx
useEffect(() => {
  if (!anchor) return;
  const node = document.getElementById(anchor.id);
  if (node instanceof HTMLDetailsElement) node.open = true;
  return scrollToId(anchor.id);
}, [anchor]);
```

The element may not exist yet on the first tick; `scrollToId` already polls, so re-reading it inside the effect is enough for the redirect case, where the view re-renders before the poll resolves.

- [ ] **Step 3: Repoint the links into the folds**

- `src/client/LinkedInManagerLeadConfig.tsx` L955 and L1003: `href="/outreach/leads"` → `href="/outreach#outreach-leads"`.
- `src/client/LinkedInLeads.tsx` L460: `navigate('/outreach/campaigns')` → `navigate('/outreach')`.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client
git commit -m "outreach: fold people and accounts into Campaigns"
```

---

## Task 11: Delete the legacy campaign and activity screens

**Files:**

- Delete: `src/client/LinkedInCampaigns.tsx`, `src/client/LinkedInActivity.tsx`
- Modify: `src/client/LinkedInAnalyticsScreen.tsx` (L18 comment, L215 link), anything the typechecker flags

**Interfaces:**

- Consumes: nothing. Both files' only importer was the outreach block deleted in Task 2.

- [ ] **Step 1: Prove nothing imports them**

Run: `grep -rn "LinkedInCampaigns\|LinkedInActivity\|OutreachCampaigns\|OutreachPlan\|OutreachActivity" src --include=*.ts --include=*.tsx`
Expected: only the two files themselves. Any other hit must be repointed or deleted before Step 2 — if a surviving file imports a helper defined in `LinkedInCampaigns.tsx`, move that helper to the importer.

- [ ] **Step 2: Delete them**

```bash
git rm src/client/LinkedInCampaigns.tsx src/client/LinkedInActivity.tsx
```

- [ ] **Step 3: Fix the analytics screen**

In `src/client/LinkedInAnalyticsScreen.tsx`, change the `href="/outreach/campaigns"` link at L215 to `href="/outreach"` and update the L18 doc comment to name `/outreach` instead of `/outreach/campaigns`.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/client
git commit -m "outreach: delete the legacy campaign and activity screens"
```

---

## Task 12: Extract the active-account store

**Files:**

- Create: `src/client/LinkedInActiveAccount.tsx`
- Modify: `src/client/LinkedInAccounts.tsx` (remove L115–222 region), and the importers listed in Step 1

**Interfaces:**

- Produces, moved verbatim from `LinkedInAccounts.tsx`: `setActiveSeatKey(next: string): void`, `useActiveSeatKey(): [string, (key: string) => void]`, `ActiveLinkedInAccountName()`, `slugifyAccountKey(label: string): string`, plus the private `readActiveAccountKey`, `activeAccountSnapshot`, `adoptActiveAccountKey`, `subscribeToActiveAccount` they depend on. Signatures unchanged.

- [ ] **Step 1: List the importers**

Run: `grep -rn "useActiveSeatKey\|setActiveSeatKey\|ActiveLinkedInAccountName\|slugifyAccountKey" src/client --include=*.tsx --include=*.ts`
Expected files: `App.tsx`, `LinkedInInbox.tsx`, `LinkedInLeads.tsx`, `LinkedInPosts.tsx`, `LinkedInManagerRead.tsx`, `LinkedInManagerLeadConfig.tsx`, `LinkedInManagerCampaignConfig.tsx`, `views/OutreachView.tsx`, and `LinkedInAccounts.tsx` itself.

- [ ] **Step 2: Move the region**

Cut `src/client/LinkedInAccounts.tsx` L115–222 (from `slugifyAccountKey` through `ActiveLinkedInAccountName`) into the new file with its doc comments intact. Add whatever `react` imports it needs.

- [ ] **Step 3: Repoint every importer**

Each file from Step 1 imports from `'./LinkedInActiveAccount'` (or `'../LinkedInActiveAccount'` from `views/`). `LinkedInAccounts.tsx` imports back what it still uses. No re-export shim.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client
git commit -m "linkedin: extract the active-account store"
```

---

## Task 13: Extract the companion panels

**Files:**

- Create: `src/client/LinkedInCompanion.tsx`
- Modify: `src/client/LinkedInAccounts.tsx`, `src/client/views/OutreachView.tsx`

**Interfaces:**

- Consumes: `useActiveSeatKey` from `./LinkedInActiveAccount` (Task 12).
- Produces: `export function LinkedInCompanionAttention({ setToast }: { setToast: (message: string) => void })`, plus module-private `CompanionPanel` and `WorkerNotice`. `OutreachView` imports `LinkedInCompanionAttention` from the new module.

- [ ] **Step 1: Move the components**

Cut `LinkedInCompanionAttention` (L535–686), `CompanionPanel` (L687–~880) and `WorkerNotice` (L1180–~1248) out of `src/client/LinkedInAccounts.tsx` into `src/client/LinkedInCompanion.tsx`. If `WorkerNotice` is still rendered by the settings screen, export it and import it back rather than duplicating it.

- [ ] **Step 2: Repoint imports**

`views/OutreachView.tsx` imports `LinkedInCompanionAttention` from `'../LinkedInCompanion'`. `LinkedInAccounts.tsx` imports whatever of the three it still renders.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client
git commit -m "linkedin: extract the companion panels"
```

---

## Task 14: Extract the account forms

**Files:**

- Create: `src/client/LinkedInAccountForm.tsx`
- Modify: `src/client/LinkedInAccounts.tsx`

**Interfaces:**

- Consumes: `useActiveSeatKey`, `slugifyAccountKey` from `./LinkedInActiveAccount`.
- Produces: `export function AddAccountForm(...)` and `export function EditAccountForm(...)` with the props they already take, plus module-private `TimezoneField`, `TimezoneOptions`, `ProxyField`, `ScheduleFields`, `BandOverrideField`, `draftToPatch`. Do not change a single prop.

- [ ] **Step 1: Move the region**

Cut `TimezoneOptions` (L395), `TimezoneField` (L405), `draftToPatch` (L2711), `ProxyField` (L2794), `ScheduleFields` (L2875), `BandOverrideField` (L3026), `AddAccountForm` (L3107) and `EditAccountForm` (L3279) into `src/client/LinkedInAccountForm.tsx`. Move any type or constant used only by them (e.g. `AccountDraft`, `OperatorRanges`) with them; keep shared ones in place and import them.

- [ ] **Step 2: Repoint imports**

`LinkedInAccounts.tsx` imports `AddAccountForm` and `EditAccountForm` from `'./LinkedInAccountForm'`.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 4: Confirm the split landed**

Run: `wc -l src/client/LinkedInAccounts.tsx src/client/LinkedInActiveAccount.tsx src/client/LinkedInCompanion.tsx src/client/LinkedInAccountForm.tsx`
Expected: no file above ~1,500 lines; the four together roughly match the original 3,373 plus import headers.

- [ ] **Step 5: Commit**

```bash
git add src/client
git commit -m "linkedin: extract the account forms"
```

---

## Task 15: Collapse account panels by default

**Files:**

- Modify: `src/client/LinkedInAccounts.tsx` (`AccountPanel`, ~L1249)

**Interfaces:**

- Consumes: `accountState(account, detail)` — already in the file — which returns the account's state; an account whose state is not the healthy one needs attention.

- [ ] **Step 1: Wrap the panel body in a disclosure**

`AccountPanel` currently renders `<section className="page-panel li-acct-panel">` with everything expanded. Keep the account's name, state sentence, and any action buttons always visible; move the rest of the body into:

```tsx
<details className="mgr-inputs" open={needsAttention}>
  <summary>Details</summary>
  <div className="mgr-inputs-body">{/* the existing body */}</div>
</details>
```

where `needsAttention` is computed once, above the return:

```tsx
const state = accountState(account, detail);
const needsAttention = state !== 'ready';
```

Use whatever value `accountState` returns for the healthy case — read the function before assuming the string; if it returns a union, compare against the healthy member and do not invent a new one.

- [ ] **Step 2: Keep the inner disclosures**

The existing `<details>` at L1587 ("Next LinkedIn background activity") and the `ProxyField` / `EditAccountForm` disclosures stay as they are — do not nest a second copy around them.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client
git commit -m "linkedin: collapse healthy account panels"
```

---

## Task 16: Sweep dead client exports

**Files:**

- Modify: `src/client/api.ts`, `src/client/LinkedInSafety.tsx`, `src/client/LinkedInAccounts.tsx`

**Interfaces:**

- Consumes: nothing. This task only deletes symbols with zero importers.

- [ ] **Step 1: Find every unused export**

Run:

```bash
for f in src/client/api.ts src/client/LinkedInSafety.tsx src/client/LinkedInAccounts.tsx; do
  echo "== $f"
  grep -oP '^export (async function|function|const|class|type|interface) \K[A-Za-z0-9_]+' "$f" | while read s; do
    n=$(grep -rlw "$s" src --include=*.ts --include=*.tsx | grep -v "^$f$" | wc -l)
    [ "$n" = 0 ] && echo "  unused: $s"
  done
done
```

Before this task the list included 40 `api.ts` symbols (`researchReddit`, `commentOnReddit`, `queueLinkedInEngagement`, `saveLinkedInSeat`, `deleteLinkedInCampaign`, `getLinkedInSequenceTemplates`, `updateLinkedInPost`, `getLinkedInLeadSource`, and the `LinkedIn*`/`Reddit*` types listed alongside them), four in `LinkedInSafety.tsx` (`ACTION_STATUS_LABELS`, `humanizeRule`, `SeatLimitsRead`, `SeatStop`) and `ACCOUNT_KEY_PATTERN` in `LinkedInAccounts.tsx`. Tasks 6–11 will have grown that list — re-run it, do not trust this paragraph.

- [ ] **Step 2: Delete them**

Delete each reported symbol and any private helper left with no caller. A symbol reported unused but referenced from a `docs/` file still goes — docs are updated in Task 18.

- [ ] **Step 3: Re-run the scan**

Run the Step 1 command again.
Expected: no output. Deleting one function often orphans the next.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client
git commit -m "client: delete unreachable api and helper exports"
```

---

## Task 17: Sweep dead CSS

**Files:**

- Modify: `src/client/styles.css`

- [ ] **Step 1: Find orphaned selectors**

For each class name in `styles.css` that starts `outreach-`, `li-dryrun`, `li-campaign`, `li-export`, or `li-activity`, check for a user:

```bash
grep -oP '^\.\K[a-z0-9-]+' src/client/styles.css | sort -u | while read c; do
  n=$(grep -rl "$c" src/client --include=*.tsx | wc -l)
  [ "$n" = 0 ] && echo "unused: .$c"
done
```

- [ ] **Step 2: Delete the confirmed orphans**

Delete each rule the scan reports, including `.outreach-more-select`, `.outreach-pinned-tab`, `.outreach-pinned-open`, `.outreach-pinned-close` and anything left by `LinkedInCampaigns.tsx`/`LinkedInActivity.tsx`. Leave selectors that are built dynamically (template literals like `` `li-tone-${tone}` ``) — search for the prefix before deleting any class whose name looks composed.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success. If it fails with `EACCES` on `dist/.well-known`, that directory is root-owned on this host and pre-existing — report it, do not `sudo`.

- [ ] **Step 4: Commit**

```bash
git add src/client/styles.css
git commit -m "styles: sweep selectors orphaned by the outreach cuts"
```

---

## Task 18: Documentation

**Files:**

- Modify: `docs/app-spec.md`, `docs/first-run.md`, `docs/lead-spine.md`, `docs/product-journeys-and-autonomous-work.md`, `docs/gtm-shell-shape.md`

- [ ] **Step 1: Find every stale reference**

Run:

```bash
grep -rn "outreach/campaigns\|outreach/plan\|outreach/activity\|outreach/leads\|outreach/accounts\|outreach/manager\|gtm.linkedin-outreach\|LinkedInCampaigns\|LinkedInActivity" docs
```

- [ ] **Step 2: Rewrite them**

Describe Outreach as four screens — Campaigns (`/outreach`, with Find people and Target accounts as folds), Messages (`/outreach/inbox`), Posts (`/outreach/posts`), Settings (`/outreach/settings`) — and the builder at `/outreach/new`. Remove every mention of the legacy campaign system, the CSV export path, and the `gtm.linkedin-outreach` playbook. Do not add new prose beyond what the removed lines covered.

- [ ] **Step 3: Re-run the scan**

Run the Step 1 command again.
Expected: matches only in `docs/superpowers/specs/` and `docs/superpowers/plans/` (historical records, which stay as written) and in `docs/linkedin-outreach-plan.md` filename references.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: outreach is four screens"
```

---

## Final verification

After Task 18:

- `npm run typecheck` — clean
- `npm test` — green (report honestly if testcontainers cannot start Postgres on the host)
- `npm run build` — succeeds
- `git diff --stat main` — expect roughly `-9,000 / +900` across ~30 files
