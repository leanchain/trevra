# Marketing Page Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cut the landing page to three sections with one anchor list and three CTAs, and stop hand-maintaining a second copy of it in `index.html` by prerendering that file from the component.

**Architecture:** `src/client/MarketingScreen.tsx` keeps every capability it has today but renders Hero, Gate, and Deploy only; the module catalog moves inside a collapsed `<details>` in Deploy. The root `index.html` becomes a head-only template with an empty `#root`, and `scripts/prerender-marketing.tsx` fills that root in `dist/index.html` after the marketing build using `renderToStaticMarkup`.

**Tech Stack:** React 19 + TypeScript (Vite), Express, vitest, Prettier via a pre-commit hook.

**Design spec:** `docs/superpowers/specs/2026-08-20-marketing-simplification-design.md`

## Global Constraints

- **Never commit to `main`.** Every task starts by proving the working directory: `git rev-parse --show-toplevel && git branch --show-current`. The branch must be `marketing-simplification`.
- **The pre-commit hook runs Prettier and ABORTS the commit if it reformats anything.** Re-run `git add <files>` and commit again. Never use `--no-verify`.
- **Copy is not rewritten.** Sentences that survive a cut move verbatim. Do not reword headlines, ledes, or card copy.
- **Every real CTA keeps `data-hosted-cta`** and an href of `#hosted` (or `/login` for the nav button). `src/server/public-site.ts` rewrites those attributes per request and `src/server/public-site.test.ts` asserts on them.
- **`<!-- TREVRA_VERIFICATION -->` and `<!-- TREVRA_JSON_LD -->` stay in `index.html`'s head, byte for byte.** The server replaces them at request time.
- **No new dependencies.** `react-dom/server` is already available.
- **Commands:** `npm run typecheck`; `npx vitest run <path>`; `npm run build:marketing`.
- **Scope:** the landing page only. Do not touch `public/privacy`, `public/terms`, `public/security`, `llms.txt`, `sitemap.xml`, or the app shell.

## File Structure

| File                                    | Responsibility                                                    | Task    |
| --------------------------------------- | ----------------------------------------------------------------- | ------- |
| `src/client/MarketingScreen.tsx`        | Three sections, one nav list, three CTAs, catalog in a disclosure | 1, 2, 3 |
| `index.html`                            | Head + empty `#root` template                                     | 4       |
| `scripts/prerender-marketing.tsx` (new) | Renders `MarketingApp` into `dist/index.html`                     | 4       |
| `package.json`                          | `build:marketing` runs the prerender step                         | 4       |
| `src/server/public-site.test.ts`        | Asserts against rendered markup, not the template file            | 4       |
| `src/client/styles.css`                 | Dead marketing rules removed                                      | 5       |
| `src/client/api.ts`                     | Unused `PublicConfig` export removed                              | 5       |

---

## Task 1: Three sections

**Files:** Modify `src/client/MarketingScreen.tsx`

- [ ] **Step 1: Fold "How it runs" into the gate.** Delete the whole `<section className="launch-section run-section" id="how-it-works">` block, including its `<figure className="ledger">`, table, and `ledger-note`. Delete the now-unused `LEDGER_SAMPLE` constant and its doc comment. Move the section's `<p>` ("Research, scoring, sequencing, and drafting can run automatically. Trevra records each run, its inputs, evidence, and result.") verbatim into the gate's `.gate-head`, directly after the existing `<p>` there.

- [ ] **Step 2: Fold the final CTA into Deploy.** Delete `<section className="launch-final">`. Append its `<div className="launch-actions">` markup (both anchors, unchanged, including `data-hosted-cta` on the primary) to the end of `<section className="launch-section deploy-section" id="deploy">`, after `.deploy-grid`, wrapped in `<div className="deploy-close">`. Drop the deleted section's `<h2>`/`<p>`.

- [ ] **Step 3: Typecheck.** Run `npm run typecheck`. Expected: clean, no unused-symbol errors.

- [ ] **Step 4: Commit.** `git add src/client/MarketingScreen.tsx && git commit -m "marketing: three sections"`

---

## Task 2: One anchor list, three CTAs

**Files:** Modify `src/client/MarketingScreen.tsx`

- [ ] **Step 1: Add the constant** near the other module-level constants:

```tsx
/** The page's own anchors, in one place: the nav, the burger menu, and the footer all read this. */
const NAV_LINKS = [
  { href: '#approval', label: 'The gate' },
  { href: '#deploy', label: 'Deploy' }
] as const;
```

- [ ] **Step 2: Replace the three hand-kept copies.** In `<nav aria-label="Primary navigation">`, in the burger `<details className="launch-nav-menu">`'s `<nav aria-label="Sections">` (which keeps its extra Source link after the mapped links), and in the footer's Product column, render `NAV_LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)`. The footer column keeps its `<strong>Product</strong>` heading.

- [ ] **Step 3: Cut CTA and link duplicates.** In the hero's `.launch-actions`, keep both anchors as they are. Delete the `hero-facts` GitHub link ("Read the source") — the nav, burger, and footer already carry Source — keeping the catalog-JSON and SBOM links and their `trackEvent` calls. The deploy self-host card keeps its `Read the deployment guide` link.

- [ ] **Step 4: Typecheck and eyeball.** `npm run typecheck` clean. Confirm by grep that exactly three anchors carry `data-hosted-cta` (nav Login, hero primary, deploy closing) and that `#hosted` still exists as the deploy card's id.

- [ ] **Step 5: Commit.** `git commit -m "marketing: one anchor list, fewer duplicate links"`

---

## Task 3: Catalog into Deploy

**Files:** Modify `src/client/MarketingScreen.tsx`

- [ ] **Step 1: Delete the catalog section.** Remove `<section className="launch-section catalog-section" id="modules">` entirely: its split heading, `.catalog-bar` (links row and filter input), the `catalog-empty` branch, and the `moduleGroups` map.

- [ ] **Step 2: Delete the grouping and filter machinery.** Remove `MODULE_GROUPS`, `groupIndexOf`, `byGroupThenName`, `SHOW_SYSTEM_MODULES`, the `moduleQuery` state, the `query` / `installable` / `catalogModules` / `moduleGroups` locals, and the `Search` icon import if it becomes unused. Replace the sort in `STATIC_MODULES` and in the live-registry effect with a name sort:

```tsx
const byName = (left: PublicModule, right: PublicModule) => left.id.localeCompare(right.id);
```

- [ ] **Step 3: Render the list inside Deploy.** After `.deploy-grid` and before the closing CTA added in Task 1, add:

```tsx
<details className="deploy-modules">
  <summary>See the {liveModules.length} modules</summary>
  <ul className="module-list">
    {liveModules.map((module) => (
      <ModuleRow module={module} key={module.id} />
    ))}
  </ul>
</details>
```

- [ ] **Step 4: Fix the hero count.** The hero facts row's module link reads `{liveModules.length} modules in the catalog`.

- [ ] **Step 5: Style the disclosure.** In `src/client/styles.css`, next to the existing `.deploy-card` rules, add rules for `.deploy-modules` and `.deploy-modules > summary` that match the page's existing disclosure styling (`.launch-nav-menu > summary` is the model). No new colours or tokens.

- [ ] **Step 6: Typecheck.** `npm run typecheck` clean.

- [ ] **Step 7: Commit.** `git commit -m "marketing: catalog moves into deploy"`

---

## Task 4: Prerender `index.html`

**Files:** Modify `index.html`, `package.json`, `src/server/public-site.test.ts`; Create `scripts/prerender-marketing.tsx`

- [ ] **Step 1: Reduce `index.html` to a template.** Keep the doctype, `<html>`, the entire `<head>` unchanged (every meta, canonical, OG/Twitter tag, manifest, stylesheet, `theme.js`, and both HTML comment placeholders), the `skip-link`, `<div id="root"></div>`, the existing `<noscript>`, and the module `<script>`. Delete every hand-written `<main class="static-launch">` … `</main>` section and any inline `<script>` that only served that markup. Do not delete `theme.js` or the skip link.

- [ ] **Step 2: Write the prerender script** at `scripts/prerender-marketing.tsx`:

```tsx
/**
 * Fill the built index.html's empty #root with the landing page's markup.
 *
 * The page's copy lives in MarketingScreen.tsx and nowhere else; this renders
 * that component once, at build time, so a crawler and a reader with no
 * JavaScript see the same page React would have drawn. The head, the two
 * server-side placeholders, and every `data-hosted-cta` attribute pass through
 * untouched -- src/server/public-site.ts rewrites those at request time.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from '../src/client/MarketingApp';

const target = process.argv[2];
if (!target) throw new Error('usage: prerender-marketing <path to built index.html>');

const html = await readFile(target, 'utf8');
const ROOT = '<div id="root"></div>';
if (!html.includes(ROOT)) throw new Error(`${target} has no empty ${ROOT} to fill`);

const markup = renderToStaticMarkup(<MarketingApp />);
await writeFile(target, html.replace(ROOT, `<div id="root">${markup}</div>`), 'utf8');
console.log(`prerendered ${markup.length} bytes into ${target}`);
```

- [ ] **Step 3: Wire the build.** In `package.json`, `build:marketing` becomes:

```
npm run catalog:build && npm run typecheck && vite build --mode marketing && tsx scripts/prerender-marketing.tsx dist/index.html && tsx scripts/build-marketing-headers.ts dist/_headers
```

- [ ] **Step 4: Point the public-site test at the render, not the file.** In `src/server/public-site.test.ts`, replace the top-level `readFile(resolve('index.html'))` for the landing page with the same render the script performs:

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from '../client/MarketingApp';

const template = await readFile(resolve('index.html'), 'utf8');
const indexHtml = template.replace(
  '<div id="root"></div>',
  `<div id="root">${renderToStaticMarkup(<MarketingApp />)}</div>`
);
```

Rename the file to `public-site.test.tsx` if JSX in a `.ts` file fails to compile. Keep every existing assertion; they now run against the markup that actually ships. Assertions that counted hand-written CTAs must match the component's three.

- [ ] **Step 5: Run the test.** `npx vitest run src/server/public-site.test.*`. Expected: green, including the `data-hosted-cta` rewrite case and the two placeholder cases.

- [ ] **Step 6: Build.** `npm run build:marketing`. Expected: succeeds, prints the prerender byte count. Then verify: `grep -c 'data-hosted-cta' dist/index.html` is 3, `grep -c 'TREVRA_JSON_LD' dist/index.html` is 1, and `grep -c 'id="hosted"' dist/index.html` is 1.

- [ ] **Step 7: Commit.** `git add index.html scripts/prerender-marketing.tsx package.json src/server/public-site.test.* && git commit -m "marketing: prerender index.html from the component"`

---

## Task 5: Sweep

**Files:** Modify `src/client/styles.css`, `src/client/api.ts`, `docs/`

- [ ] **Step 1: Remove dead CSS.** For each of `.run-section`, `.ledger`, `.ledger-cap`, `.ledger-cap-note`, `.ledger-table`, `.ledger-note`, `.row-gate`, `.row-blocked`, `.state-done`, `.state-ready`, `.state-gate`, `.state-blocked`, `.catalog-section`, `.catalog-bar`, `.catalog-links`, `.catalog-filter`, `.catalog-empty`, `.module-group`, `.launch-final`: confirm with `grep -rn "<class>" src public index.html` that no markup uses it, then delete its rules, including inside media queries.

- [ ] **Step 2: Remove the unused export.** Confirm `grep -rn "PublicConfig" src` shows only the declaration in `src/client/api.ts`, then delete the type (keep `getPublicConfig`, which the page uses).

- [ ] **Step 3: Update docs.** Grep `docs/` for `#how-it-works`, `#modules`, and "catalog section"; correct any sentence that describes the landing page's section list.

- [ ] **Step 4: Verify.** `npm run typecheck` clean; `npx vitest run src/server/public-site.test.*` green; `npm run build:marketing` succeeds.

- [ ] **Step 5: Commit.** `git commit -m "marketing: sweep dead css and docs"`

---

## Final verification

- `npm run typecheck` clean.
- `npx vitest run src/client src/server/public-site.test.*` green.
- `npm run build:marketing` succeeds; `dist/index.html` contains the hero headline, the gate table, the deploy cards, both placeholders, and three `data-hosted-cta` attributes.
- The page still works with JavaScript disabled: anchors scroll, the burger menu opens, the approve disclosure opens.
