# Setup Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `/setup` from six tab-screens to two (Access, Workspace), delete ~4,400 lines of unreachable screens, dead code and explanatory prose, and wire four capabilities the server already has but the UI never reaches.

**Architecture:** `SetupView` (`src/client/App.tsx`) becomes a two-tab router: `/setup` renders Access (agent tokens + a collapsed hosted-agent panel), `/setup/workspace` renders Workspace (Connections, Limits, Team, and a collapsed export/erase block). Every legacy sub-route resolves to a redirect rather than a screen. Cuts happen after the IA is stable so each deletion is a small diff against a known shape. One new server route, `PATCH /api/policies/:id`, replaces the client's create-then-delete edit.

**Tech Stack:** React 18 + TypeScript (Vite), Express + zod on the server, vitest for tests, Prettier enforced by a pre-commit hook.

**Spec:** `docs/superpowers/specs/2026-08-19-setup-simplification-design.md`

## Global Constraints

- **No credential path may be cut.** Both the model-key (BYOK) path and the own-subscription CLI path in `HostedAgentPanel` keep working end to end. They only stop being open by default.
- **The CLI risk-acceptance checkbox stays** (one-line label). The server requires `riskAcceptedAt` before `resolveWorkspaceCliBackend` will run (`src/server/agent/cli.ts:325-370`).
- **Every `ConfirmDrawer` stays** with a one-line consequence: revoke token, remove key, remove CLI token, delete policy, disconnect integration, remove member, cancel invite, erase workspace.
- **Copy rule: labels only.** No intro paragraphs, no hint text, no "saved earlier / edited since" receipts, no empty-state sentences, no decorative `h4`s, no status pills or count chips. A control's label is the whole explanation.
- **Two tabs, no dropdown.** Setup nav is exactly `Access` and `Workspace`.
- **Owner-only actions are hidden from members**, not rendered and 403'd.
- **The router contract holds** (`src/client/ui/route.ts` header): a route is a path, a hash is only a scroll position. Anchors on Workspace scroll; they never carry routing meaning.
- **Pre-commit runs Prettier and aborts the commit on reformat.** When that happens, `git add` the same paths and commit again. Do not use `--no-verify`.
- Line numbers below are from the pre-change tree. Locate code by symbol name or quoted text; treat the numbers as hints.

## File Structure

| File                                                                                                                                            | Responsibility after this plan                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/ui/route.ts`                                                                                                                        | Adds `workspace` to `SUB_ROUTES.setup`; legacy subs stay parseable so redirects can fire                                                                        |
| `src/client/ui/route.test.ts`                                                                                                                   | Covers the redirect table                                                                                                                                       |
| `src/client/App.tsx`                                                                                                                            | `SetupView` two-tab router + `SETUP_LEGACY_REDIRECTS`; `AgentAccessPanel`, `HostedAgentPanel`, `ConnectionsView`, `LimitsView` shrink; new `WorkspaceDataBlock` |
| `src/client/ui/scrollToId.ts`                                                                                                                   | **New.** One shared "poll for an element, then scroll and focus it" helper for Workspace anchors                                                                |
| `src/client/TeamScreen.tsx`                                                                                                                     | Adds invite role + expiry; loses its prose and inert role columns                                                                                               |
| `src/client/RedditScreen.tsx`                                                                                                                   | Reduced to the Reddit account block; mounted from `ResearchView`, not from Setup                                                                                |
| `src/client/views/ResearchView.tsx`                                                                                                             | Mounts the Reddit account block beside the corpus disclosure                                                                                                    |
| `src/client/views/SkillsView.tsx`                                                                                                               | **Deleted**                                                                                                                                                     |
| `src/server/app.ts`                                                                                                                             | Adds `PATCH /api/policies/:id`                                                                                                                                  |
| `src/server/app.test.ts`                                                                                                                        | Covers the new route                                                                                                                                            |
| `src/client/LinkedInSafety.tsx`, `LinkedInViz.tsx`, `views/recommendations.tsx`, `ui/keys.ts`, `ui/duration.ts`, `LinkedInScreen.tsx`, `api.ts` | Dead code removed (Task 15)                                                                                                                                     |
| `docs/app-spec.md`, `docs/gtm-shell-shape.md`                                                                                                   | Describe the two-screen Setup (Task 16)                                                                                                                         |

---

## Milestone 1 — IA

### Task 1: Route table

**Files:**

- Modify: `src/client/ui/route.ts:46`
- Test: `src/client/ui/route.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `parseRoute('/setup/workspace')` returns `{ section: 'setup', sub: 'workspace', id: null, path: '/setup/workspace' }`. Every legacy sub still parses to itself so Task 2 can redirect it.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('parseRoute', ...)` block in `src/client/ui/route.test.ts`:

```ts
it('parses the two setup screens', () => {
  expect(parseRoute('/setup').sub).toBe('');
  expect(parseRoute('/setup/workspace')).toEqual({
    section: 'setup',
    sub: 'workspace',
    id: null,
    path: '/setup/workspace'
  });
});

/**
 * Legacy subs must keep PARSING so SetupView can redirect them. A sub that
 * falls out of this list parses to '' and silently lands on Access instead.
 */
it('still parses every legacy setup sub', () => {
  for (const sub of ['agent', 'data', 'limits', 'team', 'skills', 'spend', 'reddit', 'seat']) {
    expect(parseRoute(`/setup/${sub}`).sub, sub).toBe(sub);
  }
  expect(parseRoute('/setup/team/inv_1').id).toBe('inv_1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/ui/route.test.ts`
Expected: FAIL — `/setup/workspace` parses to `sub: ''`.

- [ ] **Step 3: Add the sub**

`src/client/ui/route.ts:46` becomes:

```ts
setup: ['', 'workspace', 'agent', 'data', 'reddit', 'seat', 'skills', 'limits', 'spend', 'team'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/client/ui/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/ui/route.ts src/client/ui/route.test.ts
git commit -m "setup: route /setup/workspace"
```

---

### Task 2: Two-tab SetupView and the redirect table

**Files:**

- Create: `src/client/ui/scrollToId.ts`
- Modify: `src/client/App.tsx:687-840` (`SETUP_ROUTES`, `SetupView`), `src/client/App.tsx:3110-3127` (`viewTitle`)

**Interfaces:**

- Consumes: `parseRoute` from Task 1.
- Produces: `scrollToId(elementId: string): () => void` — starts a 100ms poll (20 tries), scrolls the element into view, focuses it with `tabindex="-1"`, and returns a cleanup function. `SetupView` renders exactly two screens, keyed on `sub === 'workspace'`.

- [ ] **Step 1: Create the shared scroll helper**

`src/client/ui/scrollToId.ts`:

```ts
/**
 * Scroll to an element that may not be mounted yet.
 *
 * Sections inside Setup render nothing until their own read lands, so the
 * target of `/setup/data` is absent on the first frame. Poll briefly, then
 * give up: a deployment without that block never grows one, and hunting
 * forever would leak a timer.
 */
export function scrollToId(elementId: string): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let tries = 0;
  const timer = window.setInterval(() => {
    const target = document.getElementById(elementId);
    if (target) {
      window.clearInterval(timer);
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      return;
    }
    if (++tries > 20) window.clearInterval(timer);
  }, 100);
  return () => window.clearInterval(timer);
}
```

- [ ] **Step 2: Replace `SETUP_ROUTES` and its primary/advanced split**

Delete `SETUP_ROUTES`, `SETUP_PRIMARY_ROUTES`, `SETUP_ADVANCED_ROUTES` (`App.tsx:687-700`) and the long comment block above them (`App.tsx:665-686`). Replace with:

```tsx
/**
 * Setup is two screens. Access is what may reach the workspace; Workspace is
 * what the workspace itself holds. Everything else is a redirect kept for
 * bookmarks -- a URL that used to name a tab now names a section anchor.
 */
const SETUP_TABS = [
  { sub: '', label: 'Access', path: '/setup' },
  { sub: 'workspace', label: 'Workspace', path: '/setup/workspace' }
] as const;

const SETUP_LEGACY_REDIRECTS: Record<string, string> = {
  agent: '/setup',
  spend: '/setup',
  data: '/setup/workspace',
  limits: '/setup/workspace',
  team: '/setup/workspace',
  skills: '/setup/workspace',
  reddit: '/research',
  seat: '/outreach',
  research: '/research'
};

/** Legacy sub -> the section it should land on inside Workspace. */
const SETUP_LEGACY_ANCHORS: Record<string, string> = {
  data: 'connections',
  limits: 'limits',
  team: 'team'
};
```

- [ ] **Step 3: Rewrite the body of `SetupView`**

Replace `SetupView` (`App.tsx:702-840`) entirely:

```tsx
function SetupView({
  route,
  data,
  reload,
  setToast,
  busyId,
  setBusyId,
  onNavigate
}: {
  route: Route;
  data: DashboardPayload;
  reload: () => Promise<void>;
  setToast: (message: string) => void;
  busyId: string | null;
  setBusyId: (id: string | null) => void;
  onNavigate: (path: string) => void;
}) {
  const sub = route.sub;
  // `/setup/team/:id` is the accept-invitation link from an email. It is a
  // full screen with no tabs: the reader has no workspace to configure yet.
  const invitationId = sub === 'team' ? route.id : null;
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (invitationId) return;
    const target = SETUP_LEGACY_REDIRECTS[sub];
    if (!target) return;
    setAnchor(SETUP_LEGACY_ANCHORS[sub] ?? null);
    replaceNavigate(target);
  }, [sub, invitationId]);

  useEffect(() => {
    if (!anchor) return;
    const stop = scrollToId(anchor);
    setAnchor(null);
    return stop;
  }, [anchor]);

  if (invitationId) {
    return (
      <TeamSettingsView route={route} setToast={setToast} reload={reload} onNavigate={onNavigate} />
    );
  }

  const onWorkspace = sub === 'workspace';

  return (
    <div className="page-stack">
      <nav className="setup-nav" aria-label="Setup sections">
        {SETUP_TABS.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={(tab.sub === 'workspace') === onWorkspace ? 'is-active' : undefined}
            aria-current={(tab.sub === 'workspace') === onWorkspace ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {onWorkspace ? (
        <>
          <ConnectionsView
            data={data}
            reload={reload}
            setToast={setToast}
            busyId={busyId}
            setBusyId={setBusyId}
          />
          <LimitsView setToast={setToast} />
          <LinkedInExclusions setToast={setToast} />
          <TeamSettingsView
            route={route}
            setToast={setToast}
            reload={reload}
            onNavigate={onNavigate}
          />
        </>
      ) : (
        <>
          <AgentAccessPanel setToast={setToast} />
          <HostedAgentPanel
            setToast={setToast}
            onInspectRun={(runId) => onNavigate(`/ledger/run/${runId}`)}
          />
        </>
      )}
    </div>
  );
}
```

Add `import { scrollToId } from './ui/scrollToId';` to the imports. `WorkspaceDataBlock` joins the Workspace branch in Task 14.

- [ ] **Step 4: Give each Workspace section its anchor id**

On the outermost `<section className="page-panel">` of each: `id="connections"` in `ConnectionsView` (`App.tsx:2389`), `id="limits"` in `LimitsView` (`App.tsx:2812`, replacing `id="setup-limits"`), `id="team"` on `TeamMembersPanel`'s root section in `TeamScreen.tsx:241`.

- [ ] **Step 5: Fix `viewTitle`**

`App.tsx:3110-3127` — replace the `SETUP_ROUTES.find(...)` lookup with:

```ts
if (route.section === 'setup')
  return route.sub === 'workspace' ? 'Setup · Workspace' : 'Setup · Access';
```

- [ ] **Step 6: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
Then `npm run dev` and visit `/setup`, `/setup/workspace`, `/setup/agent`, `/setup/data`, `/setup/limits`, `/setup/team`, `/setup/skills`, `/setup/spend`, `/setup/reddit`, `/setup/seat`. Expected: two tabs everywhere; each legacy URL replaces itself with its target; `/setup/data` lands scrolled at Connections.

- [ ] **Step 7: Commit**

```bash
git add src/client/App.tsx src/client/ui/scrollToId.ts src/client/TeamScreen.tsx
git commit -m "setup: two screens, legacy subs redirect"
```

---

### Task 3: Collapse the hosted agent and spend blocks

**Files:**

- Modify: `src/client/App.tsx:1532-2260` (`HostedAgentPanel`)

**Interfaces:**

- Consumes: `setup` from `getAgentSetup()` — `{ available, config, secret, budget, schedule, cli }`.
- Produces: nothing new. Two `<details>` wrappers with `open` derived once on load.

- [ ] **Step 1: Derive the two open-states**

After the `if (!loaded || !setup) return null;` guard (`App.tsx:1526`), add:

```tsx
// A configured workspace never hides its own configuration: open what is
// already set, keep the rest shut.
const computeOpen = Boolean(secret) || Boolean(setup.cli?.tokenStored);
const spendOpen = Boolean(budget?.enabled);
```

- [ ] **Step 2: Wrap the compute block**

Wrap everything from the key-risk warning through the CLI sub-flow (`App.tsx:1789-2109`) in:

```tsx
<details className="mgr-inputs" open={computeOpen}>
  <summary>Run it on Trevra's compute</summary>
  <div className="mgr-inputs-body">{/* existing endpoint/key/CLI blocks, unchanged */}</div>
</details>
```

The two inner `<details>` ("Endpoint & key", "Your own Claude/Codex subscription") become plain `<div>`s — one level of disclosure, not two.

- [ ] **Step 3: Wrap the spend block**

Wrap `App.tsx:2111-2188` in:

```tsx
<details className="mgr-inputs" open={spendOpen}>
  <summary>What it may spend</summary>
  <div className="mgr-inputs-body">{/* existing spend toggle, cap input, Save cap */}</div>
</details>
```

Keep `Save cap` writing only `saveAgentBudget` — it must never fold into the panel's shared Save.

- [ ] **Step 4: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: with no key stored, `/setup` shows tokens plus two closed disclosures. With a key stored, the compute disclosure is open on load. Saving a key still works from inside the disclosure.

- [ ] **Step 5: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: collapse hosted compute and spend"
```

---

## Milestone 2 — Cuts

### Task 4: Delete the Skills section

**Files:**

- Delete: `src/client/views/SkillsView.tsx`
- Modify: `src/client/App.tsx:103` (import), Workspace branch from Task 2

**Interfaces:**

- Consumes: nothing.
- Produces: `/setup/skills` redirects to `/setup/workspace` (already true from Task 2).

- [ ] **Step 1: Confirm nothing else imports it**

Run: `grep -rn "SkillsView" src/`
Expected: only `src/client/App.tsx:103` and the file itself.

- [ ] **Step 2: Delete**

```bash
git rm src/client/views/SkillsView.tsx
```

Remove the import at `App.tsx:103`. The Workspace branch from Task 2 never mounted it, so nothing else changes.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A src/client
git commit -m "setup: remove the skills screen"
```

Note for the reviewer: install / uninstall / revoke leave the product with this screen. The published catalog is 20 of 20 `builtin` with zero community modules, so those buttons have nothing to act on today. `POST|DELETE /api/registry/modules/:id/install` stay on the server, uncalled.

---

### Task 5: Move Reddit sign-in to Research, delete the reader and composer

**Files:**

- Modify: `src/client/RedditScreen.tsx`, `src/client/views/ResearchView.tsx:528-543`, `src/client/App.tsx:82,819`

**Interfaces:**

- Consumes: `ResearchView`'s existing `connections` prop and `setToast`.
- Produces: `RedditAccountPanel` — the renamed default export of `RedditScreen.tsx`, props `{ setToast: (message: string) => void }`.

- [ ] **Step 1: Cut the reader and the composer**

In `src/client/RedditScreen.tsx` delete: the "Read subreddits" block (`467-519`), the threads list and thread row (`521-734`), and the composer inside it (`669-727`). Delete the now-unused state (`subreddits`, `sort`, `limit`, `threads`, `openThread`, `draft`, `refused`, `degraded`) and the `redditResearch` / `redditComment` imports from `./api`.

What stays: credentials sign-in, the OTP stage, re-sign-in, Disconnect, and their state.

- [ ] **Step 2: Rename the export**

```tsx
export function RedditAccountPanel({ setToast }: { setToast: (message: string) => void }) {
```

- [ ] **Step 3: Mount it in Research**

In `src/client/views/ResearchView.tsx`, inside the existing `<details>` body (`ResearchView.tsx:538-542`), above `<ResearchScreen ... />`:

```tsx
{
  redditOpen && <RedditAccountPanel setToast={setToast} />;
}
```

Add `import { RedditAccountPanel } from '../RedditScreen';`.

- [ ] **Step 4: Unmount it from Setup**

Delete `App.tsx:82` (`import { RedditScreen }`) and the `{sub === 'reddit' && ...}` line — already absent after Task 2's rewrite; confirm with `grep -n "RedditScreen" src/client/App.tsx` returning nothing.

- [ ] **Step 5: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: `/research` → open "Reddit research corpus" → sign in with Reddit credentials, including the OTP stage. `/setup/reddit` redirects to `/research`.

- [ ] **Step 6: Commit**

```bash
git add src/client/RedditScreen.tsx src/client/views/ResearchView.tsx src/client/App.tsx
git commit -m "research: move the reddit account panel, drop the reader and composer"
```

The composer posted a comment immediately — no approval, no queue, no ledger row — which contradicts what Limits promises. `POST /api/reddit/comment` stays on the server, uncalled.

---

### Task 6: Delete the schedule block and the spend deep-link machinery

**Files:**

- Modify: `src/client/App.tsx` (`HostedAgentPanel` schedule block `2190-2241`, its state, dirty calc and `saveAll` leg; `id="setup-spend"` at `2110`)

**Interfaces:**

- Consumes: nothing.
- Produces: `saveAll` no longer calls `saveAgentSchedule`.

- [ ] **Step 1: Delete the block and its state**

Remove the schedule `<details>` (`2190-2241`), the `schedule*` state declarations, the schedule entries in the dirty calculation and `pendingLabels`, the `saveAgentSchedule` leg of `saveAll`, and the `saveAgentSchedule` import.

The goal textarea currently lives inside the schedule block and the run-now block reads it (`App.tsx:2270`). Move the textarea into the run-now block so "Run it once, now" still has a goal to run.

- [ ] **Step 2: Delete the spend anchor**

Remove `id="setup-spend"` (`App.tsx:2110`). The scroll-poll effect and `navSub` alias went with Task 2's rewrite; confirm `grep -n "setup-spend" src/client` returns nothing.

- [ ] **Step 3: Retarget the cost screen's link**

Run: `grep -rn "/setup/spend" src/client`
Point each hit at `/setup`.

- [ ] **Step 4: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: "Run it once, now" still starts a run and lands on `/ledger/run/:id`. `PUT /api/agent-setup/schedule` keeps working on the server; nothing calls it.

- [ ] **Step 5: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: drop the schedule block and the spend deep link"
```

---

### Task 7: Reduce the limits form

**Files:**

- Modify: `src/client/App.tsx:2525-2535` (`ACTOR_CHOICES`, `ENVIRONMENT_CHOICES`), `2679-2790` (`LimitsView` state and `savePolicy`), `2840-2956` (form fields)

**Interfaces:**

- Consumes: `createPolicy` (`src/client/api.ts:535`), unchanged signature.
- Produces: `POLICY_DEFAULTS = { actionPattern: 'skill:*', priority: 100 }` — the constants the form no longer asks for and every create/update still sends.

- [ ] **Step 1: Add the constants**

Above `LimitsView`:

```ts
/**
 * The two fields the form stopped asking for.
 *
 * `actionPattern` is required by the server schema and `skill:*` is what every
 * policy this UI has ever written used; `priority` only breaks ties between
 * rules nobody has been able to author more than one of.
 */
const POLICY_DEFAULTS = { actionPattern: 'skill:*', priority: 100 } as const;
```

- [ ] **Step 2: Cut the fields**

Delete from the form: the `actionPattern` input and its `<small>* stands for everything</small>`, the `priority` input and its `<small>higher wins a tie</small>`, the `condition-numbers` fieldset (`2902-2950`: maxAmount, minConfidence, maxRecipients), and the actor and environment `ConditionChecklist`s (`2889-2900`). Delete `ACTOR_CHOICES` and `ENVIRONMENT_CHOICES` (`2525-2535`).

What stays: name, effect, and the "What is being done" side-effects checklist.

- [ ] **Step 3: Trim the drafts**

`policyDraft` becomes `{ name, effect }`. `conditionDraft` keeps only `sideEffects`; update `EMPTY_CONDITIONS`, `buildConditions`, `conditionDraftFromPolicy` and `toggleCondition` to match. `buildConditions` still emits the same `conditions` shape, minus the keys the form no longer writes.

- [ ] **Step 4: Send the constants**

In `savePolicy`, the payload becomes:

```ts
const payload = {
  name: policyDraft.name.trim(),
  actionPattern: POLICY_DEFAULTS.actionPattern,
  effect: policyDraft.effect,
  priority: POLICY_DEFAULTS.priority,
  conditions: buildConditions(conditionDraft),
  enabled: true
};
```

The guard on the first line drops its `actionPattern` clause: `if (!policyDraft.name.trim()) return;`

- [ ] **Step 5: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: create a limit; it appears in the list and `describePolicy` still reads correctly. An existing policy carrying actor/environment conditions still renders its summary — `describePolicy` keeps reading keys the form cannot write.

- [ ] **Step 6: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: limits asks for a name and an effect"
```

---

### Task 8: Small structural cuts

**Files:**

- Modify: `src/client/App.tsx:1079,1170-1183` (target switch), `1379,1847-1855` (key label), `2407-2426` (sync now), `1550-1572` (`!available` card)

**Interfaces:**

- Consumes: nothing.
- Produces: `AgentAccessPanel` renders both connect commands at once.

- [ ] **Step 1: Both commands, no switch**

Delete the `agent-target-switch` buttons and the `target` state. Render the Claude and Codex command boxes one after the other, each with its own Copy button. The token auto-name drops its target suffix.

- [ ] **Step 2: Drop the optional key label**

Delete the `providerLabel` state and its input, and remove `label` from the `saveAgentModelConfig` payload. The server field stays optional.

- [ ] **Step 3: Drop per-connection "Sync now"**

Delete the sync button, its `busyId` branch, and the `syncIntegration` import if it has no other caller (`grep -n "syncIntegration" src/client`).

- [ ] **Step 4: `!available` returns null**

Replace the "switched off on this server" card (`1550-1572`) with `if (!available) return null;`. A deployment with no `TREVRA_SECRETS_KEY` shows tokens only.

- [ ] **Step 5: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: both commands copy correctly; saving endpoint + key still works without the label field.

- [ ] **Step 6: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: cut the target switch, key label, per-row sync"
```

---

### Task 9: Strip the prose

**Files:**

- Modify: `src/client/App.tsx` (`AgentAccessPanel`, `HostedAgentPanel`, `ConnectionsView`, `LimitsView`), `src/client/TeamScreen.tsx`, `src/client/LinkedInScreen.tsx:114-233`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Delete, block by block**

| Where                                                                 | What goes                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `App.tsx:1162-1165`                                                   | `AgentAccessPanel` intro                                                                                     |
| `App.tsx:1167`                                                        | `{active.length} connected` pill                                                                             |
| `App.tsx:1216-1235`                                                   | `agent-command-note` pair and the `--scope project` explainer                                                |
| `App.tsx:1538-1546`                                                   | hosted panel intro and `status-pill`                                                                         |
| `App.tsx:1783-1804`                                                   | `byok-warning` "Read this before you paste a key"                                                            |
| `App.tsx:1816-1825`, `1865-1874`                                      | "Where your key goes" / "Your key" headings and prose                                                        |
| `App.tsx:1857-1861`, `1919-1923`, `2084-2088`                         | "Saved earlier / Edited since" receipts                                                                      |
| `App.tsx:1961-1985`                                                   | CLI block-head prose and the ToS/suspension warning                                                          |
| `App.tsx:2008-2013`, `2029-2034`                                      | CLI meter copy and "Save the subscription CLI… first"                                                        |
| `App.tsx:2114-2117`, `2163-2184`                                      | spend head prose, both `byok-meter-copy`, the progress bar                                                   |
| `App.tsx:2243-2247`                                                   | panel-footer dirty sentence                                                                                  |
| `App.tsx:2262-2276`                                                   | run-once head and footer prose                                                                               |
| `App.tsx:2392`, `2442-2460`                                           | connections subtitle, empty state, "Connect a tool" heading and privacy line                                 |
| `App.tsx:2814`, `2819`, `2879-2881`, `2951-2962`, `2992-2994`, `3019` | limits subtitle, `{n} set` pill, condition hint, policy preview and footer sentence, effect chip, empty copy |
| `TeamScreen.tsx:245-248`, `308-311`, `335-337`, `346-349`, `551-559`  | section prose, the disabled-button hint, accept-invitation paragraph                                         |
| `TeamScreen.tsx:261,270-274`, `365,372-377`                           | inert Role columns (Task 13 gives the member one back, earned)                                               |
| `LinkedInScreen.tsx:166-169`, `192-195`, `206`, `214,224`             | exclusions head prose, matching-semantics paragraph, empty copy, "Added from" column                         |

- [ ] **Step 2: Keep these, deliberately**

The CLI risk-acceptance checkbox, relabelled to one line: `Using a personal subscription this way may breach your provider's terms.` Every `ConfirmDrawer` and its one-line consequence. `LinkedInScreen.tsx:196-198` ("no Remove button — a database change, on purpose") stays: it discloses irreversibility.

- [ ] **Step 3: Sweep for orphans**

Run: `npm run typecheck`
Expected: PASS. Fix any state or import left behind by a deleted block.

- [ ] **Step 4: Check by hand**

`/setup` and `/setup/workspace` read as labelled controls with no paragraphs. The CLI checkbox still gates the token field.

- [ ] **Step 5: Commit**

```bash
git add src/client/App.tsx src/client/TeamScreen.tsx src/client/LinkedInScreen.tsx
git commit -m "setup: labels only"
```

---

## Milestone 3 — Wiring

### Task 10: `PATCH /api/policies/:id`

**Files:**

- Modify: `src/server/app.ts:1186` (after the POST route), `src/server/app.ts:5601-5608` (schema)
- Test: `src/server/app.test.ts`

**Interfaces:**

- Consumes: `policyWriteSchema`, `listWorkspacePolicies`, `ownerOnly`.
- Produces: `PATCH /api/policies/:id` → `{ policies: WorkspacePolicy[] }`, 404 when the id is not this workspace's, 403 for members. Accepts any subset of `{ name, priority, actionPattern, effect, conditions, enabled }`.

- [ ] **Step 1: Write the failing test**

In `src/server/app.test.ts`, alongside the existing policy tests:

```ts
it('patches one field of a policy and leaves the rest alone', async () => {
  const created = await request(app)
    .post('/api/policies')
    .set(ownerHeaders)
    .send({ name: 'Ask me first', actionPattern: 'skill:*', effect: 'require_approval' })
    .expect(201);
  const policy = created.body.policies[0];

  const patched = await request(app)
    .patch(`/api/policies/${policy.id}`)
    .set(ownerHeaders)
    .send({ enabled: false })
    .expect(200);

  const updated = patched.body.policies.find((p: { id: string }) => p.id === policy.id);
  expect(updated.enabled).toBe(false);
  expect(updated.name).toBe('Ask me first');
  expect(updated.effect).toBe('require_approval');
});

it('refuses a policy patch from a member and an unknown id', async () => {
  await request(app)
    .patch('/api/policies/pol_nope')
    .set(ownerHeaders)
    .send({ enabled: false })
    .expect(404);
  await request(app)
    .patch('/api/policies/pol_nope')
    .set(memberHeaders)
    .send({ enabled: false })
    .expect(403);
});
```

Use whatever owner/member header helpers the neighbouring tests already use.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/app.test.ts -t "patches one field"`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Add the schema**

After `policyWriteSchema` (`app.ts:5608`):

```ts
/** Every field optional: a patch says what changed, not what the row is. */
const policyPatchSchema = policyWriteSchema.partial();
```

- [ ] **Step 4: Add the route**

After the POST route (`app.ts:1186`):

```ts
// Same owner-only carve-out as create and delete: flipping `enabled` off is
// how you turn a refusal off, which is the same privilege as never writing
// it. `updated_at` moves; `version` does not, because nothing reads it.
app.patch(
  '/api/policies/:id',
  ownerOnly("change this workspace's policies"),
  async (req: AuthedRequest, res, next) => {
    try {
      const input = policyPatchSchema.parse(req.body ?? {});
      const sets: string[] = [];
      const values: unknown[] = [];
      if (input.name !== undefined) (sets.push('name=?'), values.push(input.name));
      if (input.priority !== undefined) (sets.push('priority=?'), values.push(input.priority));
      if (input.actionPattern !== undefined)
        (sets.push('action_pattern=?'), values.push(input.actionPattern));
      if (input.effect !== undefined) (sets.push('effect=?'), values.push(input.effect));
      if (input.conditions !== undefined)
        (sets.push('conditions_json=?'), values.push(JSON.stringify(input.conditions)));
      if (input.enabled !== undefined) (sets.push('enabled=?'), values.push(input.enabled));
      if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change' });
      sets.push('updated_at=?');
      values.push(new Date().toISOString());
      const result = await db
        .prepare(`UPDATE workspace_policies SET ${sets.join(',')} WHERE id=? AND workspace_id=?`)
        .run(...values, String(req.params.id), req.auth!.workspaceId);
      if (result.changes === 0) return res.status(404).json({ error: 'Policy not found' });
      res.json({ policies: await listWorkspacePolicies(db, req.auth!.workspaceId) });
    } catch (error) {
      next(error);
    }
  }
);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/server/app.test.ts -t "policy"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts
git commit -m "policies: patch one field without deleting the row"
```

---

### Task 11: Limits edits through PATCH, plus an on/off switch

**Files:**

- Modify: `src/client/api.ts:550` (after `deletePolicy`), `src/client/App.tsx:2760-2800` (`savePolicy`), policy list rows (`2987-3023`)

**Interfaces:**

- Consumes: `PATCH /api/policies/:id` from Task 10.
- Produces: `updatePolicy(id: string, input: Partial<{ name: string; priority: number; actionPattern: string; effect: WorkspacePolicy['effect']; conditions: Record<string, unknown>; enabled: boolean }>): Promise<WorkspacePolicy[]>`

- [ ] **Step 1: Add the client call**

```ts
export async function updatePolicy(
  id: string,
  input: Partial<{
    name: string;
    priority: number;
    actionPattern: string;
    effect: WorkspacePolicy['effect'];
    conditions: Record<string, unknown>;
    enabled: boolean;
  }>
): Promise<WorkspacePolicy[]> {
  const result = await request<{ policies: WorkspacePolicy[] }>(
    `/api/policies/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
  return result.policies;
}
```

- [ ] **Step 2: Replace create-then-delete**

In `savePolicy`, the `if (editingPolicy)` branch becomes one call:

```ts
if (editingPolicy) {
  setPolicies(await updatePolicy(editingPolicy.id, payload));
} else {
  setPolicies(await createPolicy(payload));
}
closeForm();
```

Delete the old sequence and the "delete it by hand" partial-failure message it needed.

- [ ] **Step 3: Add the row switch**

On each policy row:

```tsx
<button
  type="button"
  className="ghost-button"
  disabled={busy === `policy-toggle-${policy.id}`}
  onClick={async () => {
    setBusy(`policy-toggle-${policy.id}`);
    try {
      setPolicies(await updatePolicy(policy.id, { enabled: !policy.enabled }));
    } catch (error) {
      setToast(agentSetupMessage(error, 'Could not change that limit.'));
    } finally {
      setBusy('');
    }
  }}
>
  {policy.enabled ? 'On' : 'Off'}
</button>
```

- [ ] **Step 4: Hide owner-only controls from members**

`LimitsView` renders New / Edit / Delete / the switch only for an owner, the way `TeamScreen` does. Reuse the same `isOwner` source `TeamScreen.tsx:121` uses.

- [ ] **Step 5: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: edit a limit's name — one row, same id. Toggle it off; the row reads Off. As a member, no write control renders.

- [ ] **Step 6: Commit**

```bash
git add src/client/api.ts src/client/App.tsx
git commit -m "setup: edit and disable a limit"
```

---

### Task 12: Connection status and reconnect

**Files:**

- Modify: `src/client/App.tsx:2389-2451` (`ConnectionsView` cards)

**Interfaces:**

- Consumes: `ConnectionSummary` (`src/shared/types.ts:61-70`) — `status`, `lastSyncedAt`, `lastError`; `createConnectSession` (`src/client/api.ts:201`).
- Produces: nothing.

- [ ] **Step 1: Show what the card already knows**

On each connected card, under the provider name: `Synced {relativeTime(connection.lastSyncedAt)}` when set, and `connection.lastError` when set. No other copy.

- [ ] **Step 2: Add Reconnect**

When `status === 'needs_reauth' || status === 'error'`, render a Reconnect button that runs the same Nango flow the "Connect a tool" grid uses (`App.tsx:2365-2375`): `createConnectSession([item.key])`, then `new Nango({...}).openConnectUI(...)`, then `reload()`. Extract that flow into one local `openConnect(key: string)` so both call sites share it.

- [ ] **Step 3: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: a connection in `needs_reauth` offers Reconnect and completes the Nango flow in place.

- [ ] **Step 4: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: connections show their state and offer reconnect"
```

---

### Task 13: Invite role and expiry

**Files:**

- Modify: `src/client/TeamScreen.tsx:161` (invite call), `301-339` (form), `341-404` (pending table)

**Interfaces:**

- Consumes: `addTeamMember({ email, role })` (`src/client/api.ts:186-191`), already typed `role?: 'owner' | 'member'`; server validates it at `src/server/app.ts:942-945`.
- Produces: nothing.

- [ ] **Step 1: Add the role select**

Beside the email input: a `<select>` with `member` (default) and `owner`, held in `const [role, setRole] = useState<'owner' | 'member'>('member')`.

- [ ] **Step 2: Send it**

`TeamScreen.tsx:161` becomes `await addTeamMember({ email: email.trim(), role });`

- [ ] **Step 3: Show expiry on pending invitations**

In the pending table, one column: `relativeTime(invitation.expiresAt)`. The Role column stays here because it now reflects a real choice.

- [ ] **Step 4: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: invite as owner; the pending row reads Owner and shows an expiry.

- [ ] **Step 5: Commit**

```bash
git add src/client/TeamScreen.tsx
git commit -m "team: invite an owner, show invite expiry"
```

---

### Task 14: Export and erase the workspace

**Files:**

- Modify: `src/client/App.tsx` (new `WorkspaceDataBlock`, mounted last in the Workspace branch)

**Interfaces:**

- Consumes: `workspaceExportDownloadPath()`, `previewWorkspaceErasure(): Promise<WorkspaceErasurePreview>`, `eraseWorkspace(confirm: string)` — all in `src/client/api.ts:699-745`.
- Produces: `WorkspaceDataBlock({ setToast }: { setToast: (message: string) => void })`.

- [ ] **Step 1: Write the block**

```tsx
/**
 * The export the privacy policy promises, and the erasure it promises after
 * it. Both routes have existed and been tested since the workspace shipped;
 * neither had a way in.
 */
function WorkspaceDataBlock({ setToast }: { setToast: (message: string) => void }) {
  const [preview, setPreview] = useState<WorkspaceErasurePreview | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <details className="mgr-inputs" id="workspace-data">
      <summary>Export or erase this workspace</summary>
      <div className="mgr-inputs-body">
        <a className="ghost-button" href={workspaceExportDownloadPath()} download>
          Export everything
        </a>
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const next = await previewWorkspaceErasure();
              setPreview(next);
              setConfirmErase(true);
            } catch (error) {
              setToast(agentSetupMessage(error, 'Could not read what erasure would remove.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          Erase this workspace
        </button>

        {confirmErase && preview && (
          <ConfirmDrawer
            title="Erase this workspace"
            body={
              <>
                <p>
                  {preview.totalRows} rows across {preview.inventory.length} tables. Not reversible.
                </p>
                {preview.inFlight.length > 0 && (
                  <ul>
                    {preview.inFlight.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                <label>
                  Type {preview.confirmationPhrase}
                  <input value={typed} onChange={(event) => setTyped(event.target.value)} />
                </label>
              </>
            }
            confirmLabel="Erase"
            busy={busy}
            disabled={!preview.erasable || typed !== preview.confirmationPhrase}
            onCancel={() => {
              setConfirmErase(false);
              setTyped('');
            }}
            onConfirm={async () => {
              setBusy(true);
              try {
                await eraseWorkspace(typed);
                window.location.assign('/login');
              } catch (error) {
                setToast(agentSetupMessage(error, 'Could not erase this workspace.'));
                setBusy(false);
              }
            }}
          />
        )}
      </div>
    </details>
  );
}
```

Match `ConfirmDrawer`'s real prop names to the neighbouring call sites (`App.tsx:1272-1305`); the shape above is illustrative of the content, not of the API.

- [ ] **Step 2: Mount it, owner-only**

Last in the Workspace branch of `SetupView`, rendered only for an owner:

```tsx
{
  isOwner && <WorkspaceDataBlock setToast={setToast} />;
}
```

- [ ] **Step 3: Typecheck and check by hand**

Run: `npm run typecheck`
Expected: PASS.
By hand: Export downloads a file. Erase shows the preview counts, refuses until the workspace name is typed exactly, and refuses while `inFlight` is non-empty. **Do not confirm an erase against a workspace you want to keep.**

- [ ] **Step 4: Commit**

```bash
git add src/client/App.tsx
git commit -m "setup: export or erase the workspace"
```

---

## Milestone 4 — Dead code and docs

### Task 15: Delete the unreachable LinkedIn subtree

**Files:**

- Modify: `src/client/LinkedInSafety.tsx:663-2574`, `src/client/LinkedInViz.tsx:122-475`, `src/client/ui/keys.ts:27-36,90-133`, `src/client/ui/duration.ts:38-56`, `src/client/LinkedInScreen.tsx:97-102`, `src/client/api.ts` (`recordLinkedInOutcome`, `LINKEDIN_ACTION_KINDS`)
- Delete: `src/client/views/recommendations.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. `WindowPicker` in `LinkedInViz.tsx` survives — `views/LoopView.tsx:558` uses it. `isTypingTarget` in `ui/keys.ts` survives — `useShortcuts` uses it.

- [ ] **Step 1: Prove each is unreachable**

For each symbol below, run `grep -rn "<symbol>" src/` and confirm every hit is inside the block being deleted:
`LinkedInSafetyScreen`, `useAccountTruth`, `AccountPanel` (the one in `LinkedInSafety.tsx` — `LinkedInAccounts.tsx:1249` has a live namesake, do not touch it), `BandOverride`, `CapCell`, `CeilingRow`, `accountClock`, `hoursStateOf`, `countLast24h`, `campaignRampOf`, `warmupWeekEndsAt`, `VolumeChart`, `WarmupRamp`, `AcceptanceMeter`, `useListKeys`, `ownsTheKey`, `relativeTime` (the `ui/duration.ts` copy — consumers import it from `./LinkedInScreen`), `ACTION_SOURCE_LABELS`, `ACTION_KIND_LABELS`, `recordLinkedInOutcome`, `LINKEDIN_ACTION_KINDS`.

- [ ] **Step 2: Delete**

```bash
git rm src/client/views/recommendations.tsx
```

Then remove each range listed under **Files**.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS. This is the one step that catches an import no test covers.

- [ ] **Step 4: Run the suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/client
git commit -m "client: remove the unreachable linkedin safety subtree"
```

---

### Task 16: Documentation

**Files:**

- Modify: `docs/app-spec.md:88-150`, `docs/gtm-shell-shape.md:36,191`

**Interfaces:**

- Consumes: the shipped behaviour of Tasks 1-15.
- Produces: nothing.

- [ ] **Step 1: `docs/app-spec.md`**

Setup is two screens: `/setup` (Access) and `/setup/workspace`. Delete the `/setup/spend` deep-link paragraph at `:150` — the link is gone. Note that legacy subs redirect.

- [ ] **Step 2: `docs/gtm-shell-shape.md`**

Stop naming `LinkedInSafetyScreen` as the guard surface (`:36`, `:191`). The live guard surface is Outreach → Settings plus `/setup/workspace#limits`.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/app-spec.md docs/gtm-shell-shape.md
git commit -m "docs: setup is two screens"
```

---

## Final verification

- [ ] `npm run check` (test suite + typecheck + both builds) passes.
- [ ] Every URL in the spec's route table resolves: `/setup`, `/setup/workspace`, `/setup/agent`, `/setup/data`, `/setup/limits`, `/setup/team`, `/setup/team/:id`, `/setup/skills`, `/setup/spend`, `/setup/reddit`, `/setup/seat`, `/setup/research`.
- [ ] A member sees no owner-only control on either screen.
- [ ] The BYOK key path completes a hosted run end to end.
- [ ] The subscription-CLI path completes a hosted run end to end, with the risk checkbox still gating the token field.
- [ ] `git diff --stat main` shows roughly 4,400 lines removed.
