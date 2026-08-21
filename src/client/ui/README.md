# Trevra client UI system

This directory owns reusable interaction patterns for the authenticated Trevra console. The goal is not a large component library; it is one small, predictable visual and accessibility contract that every screen reuses.

## Default primitives

Import ordinary controls from `./primitives` (or `../ui/primitives`):

```tsx
import { Button, Field, Input, Select, Textarea } from './ui/primitives';

<Field label="Source name" hint="Shown to workspace operators.">
  <Input value={name} onChange={(event) => setName(event.target.value)} />
</Field>

<Field label="Type">
  <Select value={kind} onChange={(event) => setKind(event.target.value)}>
    <option value="website">Website</option>
    <option value="form">Form</option>
  </Select>
</Field>

<Button variant="primary">Save</Button>
<Button variant="secondary">Cancel</Button>
```

Use `ConfirmDrawer` for confirmation/destructive flows, `ActionMenu` for secondary row actions, and `ChoiceMenu` for a compact bounded choice. Reuse `page-panel`, `section-heading`, `panel-footer`, and `li-table` for page structure.

## Decision rules

1. **Start with a primitive.** Raw `<input>`, `<select>`, `<textarea>`, and locally skinned ordinary buttons should be exceptional in new authenticated UI.
2. **One local primary action.** The action that completes the current task is primary; alternatives are secondary or ghost. Destructive actions use danger styling and confirmation when consequences are meaningful.
3. **Feature CSS lays things out; shared CSS skins controls.** A screen may define columns, gaps, responsive breakpoints, cards, and domain-specific visualization. It should not redefine the standard input border, select arrow, focus ring, button radius, or tap height.
4. **Use tokens, not guesses.** Pull color, radius, type, shadow, and control height from `--t-*` variables in `styles.css`.
5. **Prefer native semantics.** A styled native select is better than a custom dropdown until search, async results, grouping, or multi-select makes a combobox necessary.
6. **Keep keyboard behavior visible.** Never remove the shared focus outline. Icon-only buttons need `aria-label`; controls need visible labels; disabled state must remain legible.
7. **Keep density humane.** Standard actions remain at least `--t-tap` high. Do not make important controls tiny to fit more chrome on screen.
8. **Progressively disclose complexity.** Advanced or rare options belong in an existing details/drawer pattern instead of permanently expanding the default form.
9. **Check both themes and mobile.** Any new control or state must make sense in light/dark themes and below the common narrow breakpoints.
10. **Do not fork the design language.** If two screens need the same visual behavior, move it into a shared primitive/class instead of copying CSS.

## Allowed raw controls

Raw HTML controls are fine when their browser-native presentation is the point (for example a hidden file input, checkbox/radio semantics wired into a specialized control, or an accessibility-focused internal element). They should not be used merely to avoid the shared primitives.

## Migration rule

Legacy screens can be migrated incrementally. When editing an existing form, migrate the controls you touch to shared primitives instead of adding more local CSS. The authenticated shell also carries the legacy polished-control scope so untouched screens stay visually coherent during that migration.
