# Setup, simplified: two screens

Date: 2026-08-19
Status: approved design, not yet implemented

## Why

`/setup` is six tab-screens plus a `More…` dropdown, plus two redirect-only subs, plus a deep
link. Its interiors are worse than its nav: `HostedAgentPanel` alone is ~980 lines rendered
unconditionally, six sections open, directly beneath the one control a first-run operator
actually needs. Meanwhile capabilities that exist on the server are unreachable in the UI
(workspace export and erasure), controls that look actionable are inert (policy `enabled`,
invite `role`, connection `lastError`), and a whole third Reddit surface lives here rather than
in Research.

Four goals, all four required:

1. A new operator lands on `/setup` and knows the one next thing to do.
2. Less to maintain — fewer components, fewer lines, fewer routes.
3. Nothing inert or dead — every control does something; no unreachable screens.
4. Fewer screens to scan.

Audience is mixed: hosted customers and self-hosters. **No credential path may be cut.** Both
the model-key path and the own-subscription CLI path stay fully functional; they only stop being
the first thing on the page.

## Shape

```
Setup   [Access]  [Workspace]

Access      agent tokens + copy-command      (open)
            ▸ Run it on Trevra's compute     (closed: endpoint, key, subscription)
            ▸ What it may spend              (closed, own Save)
            ▸ Work on a schedule             (closed)
            Run it once, now

Workspace   Connections                      (open)
            Limits                           (open, editor behind "New limit")
            Team                             (open)
            Skills                           (open)
            ▸ Export or erase this workspace (closed)
```

Two tabs. No `More…` dropdown. Every heavy interior is closed by default and opens in place —
the pattern `SkillsView`'s `RunOneByHand` already uses.

### Auto-open rules

A closed disclosure opens on mount when it already holds state, so a configured workspace never
hides its own configuration:

- Hosted compute: open when `secret` or `cli.tokenStored` is truthy.
- Spend: open when `budget.enabled`, or when arriving via `/setup/spend`.
- Schedule: open when `schedule` is non-null.

## Routes

| URL                | Behaviour                                                          |
| ------------------ | ------------------------------------------------------------------ |
| `/setup`           | Access (canonical)                                                 |
| `/setup/workspace` | Workspace (canonical)                                              |
| `/setup/agent`     | → `/setup`                                                         |
| `/setup/spend`     | → `/setup`, spend disclosure forced open, scroll to `#setup-spend` |
| `/setup/data`      | → `/setup/workspace#connections`                                   |
| `/setup/limits`    | → `/setup/workspace#limits`                                        |
| `/setup/team`      | → `/setup/workspace#team`                                          |
| `/setup/team/:id`  | Accept-invitation panel, unchanged (full-screen, no tabs)          |
| `/setup/skills`    | → `/setup/workspace#skills`                                        |
| `/setup/reddit`    | → `/research`                                                      |
| `/setup/seat`      | → `/outreach` (existing)                                           |
| `/setup/research`  | → `/research` (existing)                                           |

Legacy subs stay in `route.ts` `SUBS.setup` so the router still parses them; they resolve to a
redirect, not a screen. The `#setup-spend` scroll-and-focus effect (`App.tsx:742-761`) survives
unchanged — it is why spend cannot become a peer screen, and that reasoning still holds.

Anchor scrolling on Workspace reuses the same poll-for-element helper, extracted once and shared
rather than copied.

## Cuts

All deletions below are approved.

| What                                  | Where                                                                                                                                                                                                                                                                       | Note                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/setup/reddit` tab                   | `App.tsx:695,819`, `RedditScreen.tsx`                                                                                                                                                                                                                                       | Account sign-in + one-shot read move to `/research`, beside the corpus they shadow                                                                                                                   |
| Reddit comment composer               | `RedditScreen.tsx:669-727`                                                                                                                                                                                                                                                  | Posts immediately: no approval, no queue, no ledger row. Contradicts what Limits promises. Deleted, not relocated. `POST /api/reddit/comment` server route is left in place but unused by the client |
| `More…` `<select>`                    | `App.tsx:779-800`                                                                                                                                                                                                                                                           | Dies with the two-tab nav                                                                                                                                                                            |
| `SETUP_ROUTES` advanced/primary split | `App.tsx:687-700`                                                                                                                                                                                                                                                           | Replaced by a two-entry list                                                                                                                                                                         |
| Dead LinkedIn subtree, ~2,600 lines   | `LinkedInSafety.tsx:663-2574`, `LinkedInViz.tsx:122-475` (charts only; `WindowPicker` stays), `views/recommendations.tsx`, `ui/keys.ts:27-36,90-133`, `ui/duration.ts:38-56`, `LinkedInScreen.tsx:97-102`, plus `recordLinkedInOutcome`/`LINKEDIN_ACTION_KINDS` in `api.ts` | Unreachable from any route. Separate commit; `docs/gtm-shell-shape.md:36,191` must stop naming `LinkedInSafetyScreen` as the guard surface                                                           |

The Reddit move is a move, not a rewrite: `RedditScreen` keeps its own credential auth (it is not
the Nango OAuth path `/research` uses — two different mechanisms for one provider, both real) and
is mounted from the Research page's source-management area.

## Wiring

Each item below is a capability the backend already has and the UI does not reach.

**Export / erase workspace.** `GET /api/workspace/export`, erasure preview, `DELETE /api/workspace`
(`app.ts:1907,1939`, tested at `app.test.ts:1570-1747`) have no UI at all. New closed disclosure at
the foot of Workspace: Export downloads; Erase shows the preview counts first, then a
`ConfirmDrawer` with typed confirmation. Owner-only, hidden for members.

**Limits: edit and enable/disable.** Today "edit" is create-then-delete (`App.tsx:2765-2790`) and
can strand two rows on partial failure; `enabled` is respected by `evaluatePolicy`
(`control-plane/policy.ts:38`) but the UI always posts `true` and offers no toggle. Add
`PATCH /api/policies/:id` (owner-only, same shape as POST, all fields optional including `enabled`),
point Edit at it, and add a per-row on/off switch. This is the only new server route in the design.

**Connections: status and reconnect.** Render `lastSyncedAt` and `lastError` (`shared/types.ts:61-70`,
never displayed) on the card, and give `needs_reauth` / `error` an explicit Reconnect that opens the
same Nango connect session. Today a broken connection silently reappears as an available "Connect"
in the panel below — an undiscoverable path.

**Team: invite role and expiry.** `POST /api/team/members` already validates
`role: 'owner' | 'member'` (`app.ts:942-945`); the form never sends it, so an owner cannot be
invited. Add the role select, and show `expiresAt` on pending invitations.

**Owner-gating consistency.** `LimitsView` renders New/Edit/Delete for members and lets the server
403 them into a toast; `TeamScreen` hides them. Hide is correct — Limits (and the new export/erase
block) follow Team.

## Out of scope

Named so they are not mistaken for oversights:

- LinkedIn exclusions have no remove, in the UI _or_ the server (`linkedin/exclusions.ts` exports
  only list/add/filter). Real gap, needs a backend route, not part of this change.
- `skill-runs` and `playbook-runs` remain two run vocabularies.
- The hosted CLI path's `tokenCustody` / `tokenKeyId` fields are returned by the server and dropped
  by the client type; surfacing them is a correctness fix for a different change.
- `TREVRA_AGENT_CLI` env precedence silently overriding panel config.

## Milestones

1. **IA.** Two screens, redirect table, shared anchor-scroll helper, disclosures with auto-open
   rules. No behaviour change inside any block.
2. **Wiring.** `PATCH /api/policies/:id` + Limits edit/toggle; connections status + reconnect; team
   role + expiry; export/erase block; owner-gating.
3. **Reddit.** Move account + read to `/research`, delete the composer, retire `/setup/reddit`.
4. **Dead code + docs.** Delete the LinkedIn subtree and the small orphans; update
   `docs/app-spec.md:88-150` and `docs/gtm-shell-shape.md:36,191`.

Each milestone is independently shippable and independently revertible.

## Verification

- `npm run test:unit` — extend `src/client/ui/route.test.ts` with the redirect table above.
- New server test in `src/server/app.test.ts` for `PATCH /api/policies/:id`: owner-only, partial
  update, `enabled: false` takes the policy out of `evaluatePolicy`.
- `npm run build` (typecheck + vite + server tsc) after the deletion milestone — the dead subtree
  is the one place where removal can break an import that no test covers.
- Manual: `/setup/spend` still lands on the cap with the disclosure open; every legacy URL in the
  route table resolves; a member sees no owner-only control on either screen.
