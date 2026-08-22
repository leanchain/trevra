# Trevra client UI system

This directory owns reusable interaction patterns for the authenticated Trevra console. The goal is not a large component library; it is one small, predictable visual and accessibility contract that every screen reuses.

## Default primitives

Import ordinary controls from `./primitives` (or `../ui/primitives`) and compose forms with `./forms`:

```tsx
import { Button, Field, Input, Select, SwitchField, Textarea } from './ui/primitives';
import { ActionRow, FormGrid, FormSection } from './ui/forms';

<FormSection title="Source" description="Where this data comes from.">
  <FormGrid layout="split">
    <Field label="Source name" hint="Shown to workspace operators.">
      <Input value={name} onChange={(event) => setName(event.target.value)} />
    </Field>
    <Field label="Type">
      <Select value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="website">Website</option>
        <option value="form">Form</option>
      </Select>
    </Field>
  </FormGrid>
  <FormGrid>
    <Field label="Instructions">
      <Textarea
        rows={4}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
      />
    </Field>
  </FormGrid>
  <ActionRow>
    <Button variant="primary">Save</Button>
  </ActionRow>
</FormSection>;
```

`FormGrid` is full-width by default. Use `single` for full-width fields, `split` for two peer fields, `wide-narrow` when the first field clearly deserves more room, and `triple` only when three peer controls genuinely belong on one row. All variants collapse to one column on narrow screens.

Use `SwitchField` for product state that is understandable as on/off. It keeps the label, consequence, and switch together; do not place a bare toggle in a section header and make the reader infer what it controls.

Use `ConfirmDrawer` for confirmation/destructive flows, `ActionMenu` for secondary row actions, and `ChoiceMenu` for a compact bounded choice. Use `FilterToolbar` + `FilterGroup` from `ui/filters.tsx` when a page needs multiple filter dimensions; labels should describe human questions such as “Status”, “Run by”, and “When”, not implementation terms.

## Page and card composition

New authenticated pages should start from `ui/layout.tsx`, not from feature-specific wrappers:

```tsx
import { EmptyState, PageGrid, Panel } from './ui/layout';

<PageGrid columns={2}>
  <Panel
    title="Connections"
    description="External services this workspace can use."
    actions={<Button>Add connection</Button>}
  >
    <EmptyState description="Nothing connected yet." />
  </Panel>
  <Panel title="Hard limits" description="Workspace-wide guardrails." />
</PageGrid>;
```

The default desktop page rhythm is a balanced two-column grid. Cards that genuinely need the whole viewport use `GridSpan full`; do not create a one-off 1.45fr/0.85fr page for a feature. `Panel` owns card padding, border/radius, title/description spacing, and the gap between copy and actions. `EmptyState` owns the gap between empty-state copy and its action. `InlineActions` owns compact action/status groups. `FormSection`, `FormGrid`, and `ActionRow` own form spacing inside a panel.

The reference implementations are **Setup → Workspace** for page/card geometry and **Setup → Access → Hosted agent** for a complex settings panel. A `Panel` names one product capability; each `FormSection` inside it should represent one human decision or task. Mutually exclusive setup methods reveal one form at a time, and each section owns the action that saves that concern.

## Decision rules

1. **Start with a primitive.** Raw `<input>`, `<select>`, `<textarea>`, and locally skinned ordinary buttons should be exceptional in new authenticated UI.
2. **One local primary action.** The action that completes the current task is primary; alternatives are secondary or ghost. Destructive actions use danger styling and confirmation when consequences are meaningful.
3. **Feature CSS lays things out; shared CSS skins controls.** A screen may define columns, gaps, responsive breakpoints, cards, and domain-specific visualization. It should not redefine the standard input border, select arrow, focus ring, button radius, or tap height.
4. **Use tokens, not guesses.** Pull color, radius, type, shadow, and control height from `--t-*` variables in `styles.css`.
5. **Use the shared dropdown.** `Select` keeps native-select call-site ergonomics (`value`, `onChange`, `<option>`) but renders Trevra's accessible listbox so triggers and opened menus look and behave consistently across browsers. Do not add raw `<select>` controls to authenticated UI.
6. **Keep keyboard behavior visible.** Never remove the shared focus outline. Icon-only buttons need `aria-label`; controls need visible labels; disabled state must remain legible.
7. **Keep density humane.** Standard actions remain at least `--t-tap` high. Do not make important controls tiny to fit more chrome on screen.
8. **Progressively disclose complexity.** Advanced or rare options belong in an existing details/drawer pattern instead of permanently expanding the default form.
9. **Check both themes and mobile.** Any new control or state must make sense in light/dark themes and below the common narrow breakpoints.
10. **Do not fork the design language.** If two screens need the same visual behavior, move it into a shared primitive/class instead of copying CSS.

## Allowed raw controls

Raw HTML controls are fine when their browser-native presentation is the point (for example a hidden file input, checkbox/radio semantics wired into a specialized control, or an accessibility-focused internal element). They should not be used merely to avoid the shared primitives.

## Migration rule

Legacy screens can be migrated incrementally. When editing an existing form, migrate the controls you touch to shared primitives instead of adding more local CSS. The authenticated shell also carries the legacy polished-control scope so untouched screens stay visually coherent during that migration.
