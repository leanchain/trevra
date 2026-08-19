# Managed campaign creation — radically simpler, with real defaults

Date: 2026-08-19
Scope: the guided "Managed Campaign" creator (`src/client/LinkedInManagerCampaignConfig.tsx`) and its two prerequisite builders — lead list import (`LinkedInManagerLeadConfig.tsx`, `src/server/linkedin/lead-import.ts`) and workflow (`LinkedInManagerWorkflowConfig.tsx`) — as orchestrated by `src/client/LinkedInManagerBuilder.tsx`. Explicitly NOT the legacy Campaigns/brief/sequence-template flow in `LinkedInCampaigns.tsx`.

**This supersedes an earlier draft of this doc** (card-picker-on-top-of-the-existing-3-gated-steps). Live-testing the current screen mid-brainstorm surfaced real bugs and a stronger complaint — "too many options, make it upload csv → create workflow → done" — that a polish pass on the existing structure wouldn't fix. This version restructures instead of decorating.

## What's actually wrong (found by reading the code + live-testing, not assumed)

1. **The onboarding checklist has no way back.** `OutreachManagerBuilder` mounts each prerequisite's editor only while it is the single "next" incomplete step; the moment a lead list (or workflow) exists, its editor unmounts and the checklist row collapses to a strikethrough line with zero controls. Reported directly: _"once the lead is there it is never letting me choose a different lead... it's a new first campaign and I can't reset those!"_
2. **"Lead list not found" fires during a clean CSV upload.** `LinkedInManagerLeadConfig` unconditionally auto-opens the first existing list's contact browser on mount (`openList(next[0].id)` → `GET /manager/lead-lists/:id/contacts` → `getLeadList` 404s server-side, `src/server/app.ts:4078`). This fetch is entirely unrelated to the CSV mapper the operator is looking at, but its error banner renders on the same screen — so a successful 108-row import looks broken.
3. **CSV column auto-match is exact-alias-only.** `autoMatchLeadFields` in `lead-import.ts` normalizes a header and checks it against a fixed alias set per field. "Business Name" or a typo'd header never matches, and the operator has to notice and fix it by hand.
4. **The campaign name has no default**, unlike list/workflow which already default to most-recently-updated (`ORDER BY updated_at DESC`).
5. **Disabled buttons often don't say why.** `LinkedInManagerWorkflowConfig`'s Save button already does this right (conditional footer text next to the button). `LinkedInManagerCampaignConfig`'s Create button doesn't — static text regardless of why it's disabled. Reported directly: _"when buttons are disabled show at least a message why... right now Import button is disabled and I have no way to know why."_
6. **Too much is visible by default.** The current screen always renders: a full contacts table (search/filter/page/edit/delete), the full ceiling/warm-up ramp math, and a 3-step gated wizard just to reach the one form that matters. None of that is needed to create a campaign; all of it is needed _sometimes_. Reported directly: _"make all these super simple. not so many options, upload csv, create workflow done right."_

## Target shape: one page, two choices, one button

Replace the 3-step gated wizard with a single screen (`OutreachManagerBuilder` collapses to: account check, then always render the campaign form). The form has exactly two inputs before Create:

### Leads

- A compact card picker over existing lists (name + lead count), defaulting to the most recent — unchanged data source, new presentation (reuses `.li-template-card`).
- A **"+ Upload a CSV"** card alongside the existing ones. Clicking it opens an inline drop-zone in place (not a navigation, not a separate screen). Drop → fuzzy automatch (Fix below) → if every required field mapped, a single "Import N leads" action creates the list and selects it. **The column-mapping grid only appears if automatch left a required field unresolved** — progressive disclosure, not a permanent fixture. No contacts table, no inline lead editor here.
- Nothing on this screen fetches or renders any existing list's _contents_. That fetch (and the bug it currently causes) simply isn't triggered by creating a campaign anymore.

### Workflow

- Same card picker shape (name + a short chip trail like `View → Invite → wait 3d → Message`, built from `workflow.steps` + the existing `ACTION_LABEL`), defaulting to most recent.
- A **"+ New from template"** card that expands the existing starter list (`STARTERS` in `LinkedInManagerWorkflowConfig.tsx` — already written, currently only reachable by fully leaving this screen). Clicking a starter creates+saves that workflow immediately under its own label and selects it. No step-by-step builder shown here.

### Name

- Auto-fills as `"{list name} → {workflow name}"` once both are chosen; stops overwriting the instant the operator types (a `nameTouched` flag).

### Create

- Disabled-reason text next to the button always says why, when disabled (mirrors the pattern `LinkedInManagerWorkflowConfig`'s Save button already uses correctly).
- The "what will happen" preview lede ("X leads worked through Y by Z, over ~N days") stays visible by default — it's the one sentence that matters. The ceiling/warm-up ramp math and source notes move behind a collapsed **"Sending details"** toggle in the same preview pane — still there, not deleted, just not shoved in front of every operator by default.

### Everything else moves behind explicit links, loaded on demand

- **"Manage lists"** and **"Manage workflows"** links (not auto-expanded `<details>`, not auto-mounted) open the existing full editors — contacts table with search/edit/delete, full step-by-step workflow builder, ceilings detail. Nothing under these links fetches anything until the operator clicks through. This is where Fix 2's bug (auto-opening a list's contacts) structurally cannot recur, because nothing opens a list's contacts unless asked.
- The three-step account/leads/workflow _gating_ goes away along with it: the only real prerequisite left is having a LinkedIn account, which already has its own screen and rarely needs redoing. If no account exists, show that one prompt; otherwise go straight to the campaign form described above.

This also resolves the "can't redo a step" complaint by construction: there is no gated step to get past. Leads and workflow are always both changeable, always both visible, on the one screen, for the life of the form.

## Fix 2 — Fuzzy column matching (unchanged from the original plan)

In `lead-import.ts`, `autoMatchLeadFields` keeps its exact-alias pass first (cheap, deterministic, unchanged behavior for every header that already worked). For headers with no exact hit, add a similarity pass:

- Score an unmapped header against each field's alias set using normalized edit-distance + substring/token containment.
- Auto-fill the best-scoring field whose score clears a threshold; tag it `'guessed'` vs `'exact'`.
- Once a header is claimed by any field, remove it from the pool so a later field can't also claim it.
- Below-threshold headers stay unmapped, exactly as today — that's what still triggers the (now progressive-disclosure) mapping grid.

Wire shape: `LeadCsvPreview` gains `mappingConfidence?: Partial<Record<LeadField, 'exact' | 'guessed'>>`. The existing `mapping` field (plain header strings actually sent to import) is unchanged — additive only.

This directly serves the simplification goal: better automatch means the mapping grid — the most "option-heavy" part of the old screen — shows up less often.

## Fix 5 — Disabled buttons always say why

Apply `LinkedInManagerWorkflowConfig`'s existing Save-button pattern (conditional footer text keyed to the actual blocking reason) to the new single Create button: no list chosen / no workflow chosen / name empty / busy — whichever applies, stated in the footer next to the button, plus a `title` attribute mirroring it for hover tooltip parity. The CSV "Import N leads" action inside the inline uploader gets the same treatment for its own blockers (required field unmapped / zero usable rows / no name for a new list).

## Explicitly out of scope

- The legacy Campaigns/brief/sequence-template flow (`LinkedInCampaigns.tsx`) — untouched.
- Toast/"saved feedback" on CSV import, lead edits, and workflow save already exist (`setToast(...)` calls already present in both prerequisite builders) and are unaffected by moving their UI behind "Manage lists/workflows" links.
- Deleting the contacts table, ceilings detail, or step-by-step workflow builder — all three stay, just reachable on demand instead of always rendered.

## Testing

- `lead-import.test.ts`: typo/synonym headers ("Buisness", "Business Name", "Cell #", "LI Profile") now auto-match with `'guessed'`; existing exact-alias cases still tag `'exact'`; a header with no reasonable match stays unmapped; no header is ever claimed by two fields.
- Component/behavior checks: creating a campaign never issues a `GET .../contacts` request (the bug's root cause is structurally gone); the mapping grid only renders when a required field is unmapped after fuzzy automatch; a starter template click produces a selected, usable workflow with no navigation; default name fills from list+workflow and stops once edited; Create's footer names the actual blocking reason for every disabled combination.
