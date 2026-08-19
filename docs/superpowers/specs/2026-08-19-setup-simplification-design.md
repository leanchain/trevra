# Setup, simplified: two screens

Date: 2026-08-19
Status: approved design, not yet implemented

## Why

`/setup` is six tab-screens plus a `More…` dropdown, two redirect-only subs, and a deep link. Its
interiors are worse than its nav: `HostedAgentPanel` alone is ~980 lines rendered unconditionally,
six sections open, above the one control a first-run operator needs. Capabilities that exist on the
server are unreachable (workspace export and erasure); controls that look actionable are inert
(policy `enabled`, invite `role`, connection `lastError`); a third Reddit surface lives here instead
of in Research.

Four goals, all required:

1. A new operator lands on `/setup` and knows the one next thing to do.
2. Less to maintain — fewer components, fewer lines, fewer routes.
3. Nothing inert or dead.
4. Fewer screens to scan.

Audience is hosted customers and self-hosters. **No credential path may be cut.** Both the model-key
path and the own-subscription CLI path stay; they stop being the first thing on the page.

## Shape

```
Setup   [Access]  [Workspace]

Access      agent tokens + copy-command      (open)
            ▸ Run it on Trevra's compute     (closed: endpoint, key, subscription CLI)
            ▸ What it may spend              (closed, own Save)
            Run it once, now

Workspace   Connections                      (open)
            Limits                           (open, editor behind "New limit")
            Team                             (open)
            ▸ Export or erase this workspace (closed)
```

Two tabs. No `More…` dropdown, no Skills, no Reddit, no schedule block. Every heavy interior is
closed by default and opens in place.

Auto-open on mount when the block already holds state: hosted compute when `secret` or
`cli.tokenStored`; spend when `budget.enabled`.

## Routes

| URL                | Behaviour                                                 |
| ------------------ | --------------------------------------------------------- |
| `/setup`           | Access (canonical)                                        |
| `/setup/workspace` | Workspace (canonical)                                     |
| `/setup/agent`     | → `/setup`                                                |
| `/setup/data`      | → `/setup/workspace#connections`                          |
| `/setup/limits`    | → `/setup/workspace#limits`                               |
| `/setup/team`      | → `/setup/workspace#team`                                 |
| `/setup/team/:id`  | Accept-invitation panel, unchanged (full screen, no tabs) |
| `/setup/skills`    | → `/setup/workspace`                                      |
| `/setup/spend`     | → `/setup` (no scroll, no anchor)                         |
| `/setup/reddit`    | → `/research`                                             |
| `/setup/seat`      | → `/outreach` (existing)                                  |
| `/setup/research`  | → `/research` (existing)                                  |

Legacy subs stay in `route.ts` `SUBS.setup` so the router parses them; each resolves to a redirect,
not a screen. The cost screen's "Change the cap" link is retargeted at `/setup`; the
scroll-and-focus poll loop (`App.tsx:740-761`), the `navSub` alias (`726`) and `id="setup-spend"`
(`2110`) all go with it.

Anchor scrolling on Workspace uses one shared helper, not a copy per section.

## Cuts

All approved. Roughly 4,400 lines.

### Screens and blocks

| What                                                                                                    | Where                                                                                                                                                                                                                                                                    | Lines  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Dead LinkedIn subtree                                                                                   | `LinkedInSafety.tsx:663-2574`, `LinkedInViz.tsx:122-475` (charts only; `WindowPicker` stays), `views/recommendations.tsx`, `ui/keys.ts:27-36,90-133`, `ui/duration.ts:38-56`, `LinkedInScreen.tsx:97-102`, `recordLinkedInOutcome` + `LINKEDIN_ACTION_KINDS` in `api.ts` | ~2,600 |
| `/setup/reddit` tab: account sign-in moves to `/research`; one-shot reader and comment composer deleted | `RedditScreen.tsx` (reader `467-519`, composer `669-727`), mount `App.tsx:695,819`                                                                                                                                                                                       | ~450   |
| Skills section, entire                                                                                  | `views/SkillsView.tsx` (355), mount `App.tsx:821`                                                                                                                                                                                                                        | ~360   |
| Hosted schedule block                                                                                   | `App.tsx:2190-2241` + schedule state, dirty calc and `saveAll` leg                                                                                                                                                                                                       | ~90    |
| Limits: actor + environment checklists, and the three numeric thresholds                                | `App.tsx:2525-2535`, `2889-2900`, `2902-2950`                                                                                                                                                                                                                            | ~71    |
| Limits: `actionPattern`, `priority`, `version`                                                          | `App.tsx:2840-2878` and the POST body                                                                                                                                                                                                                                    | ~40    |
| `More…` dropdown and the primary/advanced route split                                                   | `App.tsx:687-700`, `778-795`                                                                                                                                                                                                                                             | ~30    |
| Connections: per-row "Sync now"                                                                         | `App.tsx:2407-2426`                                                                                                                                                                                                                                                      | 20     |
| Agent: Claude/Codex target switch (show both commands)                                                  | `App.tsx:1079`, `1170-1183`                                                                                                                                                                                                                                              | 15     |
| Agent: optional key-label field                                                                         | `App.tsx:1379`, `1847-1855`                                                                                                                                                                                                                                              | 14     |
| `/setup/spend` scroll-poll effect and anchor                                                            | `App.tsx:726`, `740-761`, `2110`                                                                                                                                                                                                                                         | 22     |
| `!available` early return + "switched off" card → `return null`                                         | `App.tsx:1550-1572`                                                                                                                                                                                                                                                      | 23     |

The Reddit comment composer posts immediately — no approval, no queue, no ledger row — which
contradicts what Limits promises; it is deleted rather than relocated. `POST /api/reddit/comment`
stays on the server, uncalled.

Cutting Skills makes install / uninstall / revoke unreachable. Today that costs nothing: the
published catalog is 20 of 20 `builtin`, zero community modules, so those buttons have nothing to
act on. If community modules ship, revoke has to come back somewhere.

### Prose

All explanatory copy in the setup screens goes — intro paragraphs, hints, "saved earlier / edited
since" receipts, empty-state sentences, decorative `h4`s, the CLI `--scope project` tutorial, status
pills and count chips, the spend progress bar, inert role columns, `registry-trust` spans. Labels
only. About 250 lines.

The key-paste warning (`App.tsx:1783-1804`) and the CLI ToS/suspension warning (`1971-1985`) go too.

**Two things survive that rule, because they are controls rather than copy:**

- The CLI risk-acceptance checkbox stays, with a one-line label. The server requires
  `riskAcceptedAt` before `resolveWorkspaceCliBackend` will run
  (`agent/cli.ts:325-370`); deleting the control breaks the path we agreed to keep.
- Every `ConfirmDrawer` stays with its one-line consequence: revoke token, remove key, remove CLI
  token, delete policy, disconnect integration, remove member, cancel invite, erase workspace. These
  are the only guard on irreversible actions.

## Wiring

Each is a capability the backend already has and the UI does not reach.

**Export / erase workspace.** `GET /api/workspace/export`, erasure preview, `DELETE /api/workspace`
(`app.ts:1907,1939`, tested `app.test.ts:1570-1747`) have no UI. Closed disclosure at the foot of
Workspace: Export downloads; Erase shows preview counts, then a `ConfirmDrawer` with typed
confirmation. Owner-only.

**Limits: edit and enable/disable.** Today edit is create-then-delete (`App.tsx:2765-2790`) and can
strand two rows; `enabled` is respected by `evaluatePolicy` (`control-plane/policy.ts:38`) but the
UI always posts `true`. Add `PATCH /api/policies/:id` (owner-only, all fields optional including
`enabled`), point Edit at it, add a per-row on/off switch. Only new server route in this design.

**Connections: status and reconnect.** Render `lastSyncedAt` and `lastError`
(`shared/types.ts:61-70`, never displayed) and give `needs_reauth` / `error` an explicit Reconnect
opening the same Nango session. Today a broken connection silently reappears as "Connect" below.

**Team: invite role and expiry.** `POST /api/team/members` already validates
`role: 'owner' | 'member'` (`app.ts:942-945`); the form never sends it, so no owner can be invited.
Add the role select, show `expiresAt`, and the role columns stop being inert.

**Owner-gating consistency.** `LimitsView` renders New/Edit/Delete for members and lets the server
403 them into a toast; `TeamScreen` hides them. Hide is correct — Limits and export/erase follow
Team.

## Out of scope

- LinkedIn exclusions have no remove, in UI or server (`linkedin/exclusions.ts` exports only
  list/add/filter). Real gap, needs a backend route.
- The hosted CLI path's `tokenCustody` / `tokenKeyId` are returned by the server and dropped by the
  client type.
- `TREVRA_AGENT_CLI` env precedence silently overrides panel config (`agent/loop.ts:146-155`).

## Milestones

1. **IA.** Two screens, redirect table, shared anchor helper, disclosures and auto-open rules. No
   behaviour change inside any surviving block.
2. **Cuts.** Schedule, Skills, Reddit, limits fields, small controls, all prose.
3. **Wiring.** `PATCH /api/policies/:id` + limits edit/toggle; connections status + reconnect; team
   role + expiry; export/erase; owner-gating.
4. **Dead code + docs.** LinkedIn subtree and small orphans; update `docs/app-spec.md:88-150` and
   `docs/gtm-shell-shape.md:36,191`.

Each milestone is independently shippable and revertible.

## Verification

- `npm run test:unit`; extend `src/client/ui/route.test.ts` with the redirect table above.
- New `src/server/app.test.ts` case for `PATCH /api/policies/:id`: owner-only, partial update,
  `enabled: false` takes the policy out of `evaluatePolicy`.
- `npm run build` after milestone 4 — the dead subtree is where removal can break an import no test
  covers.
- Manual: every legacy URL in the route table resolves; a member sees no owner-only control on
  either screen; the CLI path still completes a run end to end after the prose strip.
