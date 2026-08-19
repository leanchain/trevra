# Managed campaign creation — smoother, with real defaults

Date: 2026-08-19
Scope: the guided "Managed Campaign" creator (`src/client/LinkedInManagerCampaignConfig.tsx`) and its two prerequisite builders — lead list import (`LinkedInManagerLeadConfig.tsx`, `src/server/linkedin/lead-import.ts`) and workflow (`LinkedInManagerWorkflowConfig.tsx`) — as orchestrated by `src/client/LinkedInManagerBuilder.tsx`. Explicitly NOT the legacy Campaigns/brief/sequence-template flow in `LinkedInCampaigns.tsx`.

## Problem

Creating a campaign asks for three things (lead list, workflow, name) and two of the three already default sensibly (most-recently-updated list/workflow, per `ORDER BY updated_at DESC` in `lead-lists.ts`/`workflows.ts`). What actually makes first-campaign creation rough:

1. **The onboarding checklist has no way back.** `OutreachManagerBuilder` mounts each prerequisite's editor only while it is the single "next" incomplete step. The instant a lead list (or workflow) exists, its editor unmounts and the checklist row collapses to a strikethrough line with zero controls. Reported directly: _"once the lead is there it is never letting me choose a different lead... it is struck out and I have no way to redo that step... it's a new first campaign and I can't reset those!"_ There genuinely is no path back to that step until **all three** prerequisites are done, at which point a separate `<details>` library section appears with the same editors. Mid-onboarding, it's a dead end.
2. **CSV column auto-match is exact-alias-only.** `autoMatchLeadFields` in `lead-import.ts` normalizes a header and checks it against a fixed alias set per field. A header like "Business Name" or "Buisness" (typo) never matches `company`, even though a human reads it instantly — the operator has to notice and fix it by hand every time.
3. **The campaign name has no default.** List and workflow pre-select the most recent option; name starts blank, so "next, next, next" breaks on the one field that has no name in the app to suggest one from.
4. **The workflow/list pickers are bare `<select>`s.** To compare two workflows you have to select one, read the right-hand preview, select the other, read again. No way to see them side by side before choosing.

## Fix 1 — Revisitable onboarding steps

`OutreachManagerBuilder` currently has two disjoint render branches (progressive vs. "ready"), each mounting `LinkedInManagerLeadConfig`/`LinkedInManagerWorkflowConfig` differently. Collapse into one structure:

- Three sections — Account, Lead list, Workflow — each a `<details>` (account still links out to `/outreach`, no inline editor there today; leads and workflow get real inline editors as they do now).
- The first incomplete step auto-opens (`open` attribute driven by `next?.kind === step.kind`, same signal as today).
- **Every row, done or not, is a real toggle.** Clicking a completed step's checklist row opens its `<details>` (scroll-into-view like `openEditor` already does for the ready-state library). No more strikethrough-and-vanish.
- `LinkedInManagerLeadConfig`/`WorkflowConfig` are each mounted exactly once (today they're duplicated across the two branches) — the `<details>` sections ARE the library sections; there's no separate "ready" branch needed once all three are always reachable.
- The campaign form (`LinkedInManagerCampaignConfig`) renders once `ready` is true, same as today, below the three sections.

This directly fixes the reported bug: a first-time operator who imports a list can immediately reopen that step to pick a different list or import another, at any point in onboarding, not just after finishing everything.

## Fix 2 — Fuzzy column matching

In `lead-import.ts`, `autoMatchLeadFields` keeps its exact-alias pass first (cheap, deterministic, unchanged behavior for every header that already worked). For headers with no exact hit, add a similarity pass:

- Score an unmapped header against each field's alias set using normalized edit-distance + substring/token containment (e.g. `1 - levenshtein(headerKey, aliasKey) / max(len)`, with a containment bonus when one is a substring of the other — catches "Business Name" containing "business"-adjacent tokens against `company`'s aliases).
- Auto-fill the best-scoring field whose score clears a threshold (tuned against real header variants, not just current tests).
- Once a header is claimed by any field (exact or fuzzy), remove it from the pool so a later field can't also claim it.
- Track how a field was matched: `'exact'` (today's behavior) or `'guessed'` (new). Headers scoring below threshold stay unmapped, exactly as today.

Wire shape: `LeadCsvPreview` gains `mappingConfidence?: Partial<Record<LeadField, 'exact' | 'guessed'>>`. The existing `mapping` field (plain header strings actually sent to import) is unchanged — fully additive, no breaking change to `importLinkedInManagerLeadCsv` or the override flow.

UI (`LinkedInManagerLeadConfig.tsx`): fields tagged `'guessed'` show a small inline "guessed — check this" tag next to the column select, using the same override control that exists today. Exact matches look exactly as they do now (no new UI noise on the common path).

## Fix 3 — Default campaign name

In `LinkedInManagerCampaignConfig.tsx`, add a `nameTouched` boolean (starts `false`, flips `true` on the first user edit to the name field, resets to `false` after a successful create alongside the existing `setName('')`). While untouched, an effect keyed on `[list?.name, workflow?.name]` sets `name` to `"{list name} → {workflow name}"` (truncated if long) whenever both are chosen. Fully editable at any time — this only stops filling in once the operator types.

## Fix 4 — Card picker for lead list + workflow

Replace the two `<select>` fields in `LinkedInManagerCampaignConfig.tsx`'s form with a card grid each, reusing the existing `.li-template-card` style (already used elsewhere in the LinkedIn UI, so no new visual language):

- **Workflow cards**: name, step count, and a compact chip trail of the sequence (e.g. `View → Invite → wait 3d → Message`) built from `workflow.steps` + the existing `ACTION_LABEL` map — no new data fetch.
- **Lead list cards**: name, lead count, source kind.
- Selection is which card is active (radiogroup semantics for keyboard/screen-reader users, not just a click target). The right-hand "what will happen" preview pane is unchanged.

## Fix 5 — Disabled buttons always say why

Reported directly: _"when buttons are disabled show at least a message why it is disabled. like right now Import button is disabled and I have no way to know why."_

Audited all three files in scope. `LinkedInManagerWorkflowConfig.tsx`'s Save button already does this right — its footer conditionally reads `brokenCount > 0` / `steps.length === 0` / `!name.trim()` / else a neutral status line, right next to the button. That's the pattern to match everywhere else:

- **`LinkedInManagerCampaignConfig.tsx` — Create campaign button.** Confirmed bug: the footer `<span>` is a single static string ("Creating a campaign queues nothing...") regardless of why `disabled={busy !== '' || !name.trim() || !listId || !workflowId}` is true. Make it conditional like the workflow Save button: missing name → "Name the campaign", no list chosen → "Choose a lead list", no workflow chosen → "Choose a workflow", otherwise the existing "queues nothing" line.
- **`LinkedInManagerLeadConfig.tsx` — Import button.** The `blocker` value IS already wired into the footer (`{blocker || (preview ? ... : ...)}`), so the mechanism exists, but it has two real gaps: (1) `blocker`'s ternary chain never checks `destination !== 'new' && destinationList === null` — falls through to the generic "ready" message even though `canImport` is false, i.e. the text can say "ready" while the button stays disabled; (2) while the first automatch preview fetch is still in flight (`busy === 'preview'`), `missingRequired` is computed against an empty mapping and can flash "Point first name..." before the real automatch result arrives. Fix both: add the missing branch, and gate the required-fields message on `busy !== 'preview'`.
- Add a `title` attribute mirroring the shown reason on both buttons, so the explanation also surfaces as a native hover tooltip, not just adjacent text.
- "Start it now" is left as-is — its only disabled state is `busy !== ''` (a request in flight), which is self-evident from the spinner it already shows.

## Explicitly out of scope

- The legacy Campaigns/brief/sequence-template flow (`LinkedInCampaigns.tsx`) — untouched.
- Toast/"saved feedback" on CSV import, lead edits, and workflow save already exist (`setToast(...)` calls already present in both prerequisite builders) — confirmed by reading the code, not assumed. No changes needed there.
- Starter-template creation inline on the campaign screen (considered, explicitly declined) — the existing "Build a workflow" path (now reachable at any time per Fix 1) still owns starter templates.

## Testing

- `lead-import.test.ts`: typo/synonym headers ("Buisness", "Business Name", "Cell #", "LI Profile") now auto-match with `'guessed'`; existing exact-alias cases still tag `'exact'`; a header with no reasonable match stays unmapped; no header is ever claimed by two fields.
- Component/behavior checks: default name fills from list+workflow and stops once edited; a completed onboarding step reopens on click and its editor is fully usable (can switch to a different list/workflow, not just view); card picker selection drives the existing preview pane identically to the old `<select>`; Create campaign and Import footers show the specific blocking reason for each disabled combination (no name / no list / no workflow; missing required column / zero usable rows / unnamed new list / stale destination list).
