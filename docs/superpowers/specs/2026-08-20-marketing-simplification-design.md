# Marketing page simplification — design

**Date:** 2026-08-20
**Scope:** the public landing page — `src/client/MarketingScreen.tsx`, the hand-authored `index.html`, and the marketing CSS.

## Goals

1. The page's copy lives in one file, not two.
2. Three sections, one CTA label, one anchor list.
3. Nothing on the page that repeats something already above it.

## Current state

`MarketingScreen.tsx` is 593 lines rendering six sections plus a footer. `index.html` is 297 lines that hand-duplicate every one of those sections — including all twenty module rows — as pre-JS markup for crawlers. Every copy change is two edits, and the file already carries comments explaining how to keep the two in step.

Repetition on the rendered page: four calls to action to the same destination under three labels, six GitHub links, the catalog JSON link three times, the SBOM link three times, and the same four section anchors in the desktop nav, the burger `<details>`, and the footer.

## Target shape

### Three sections

1. **Hero** (`#top`) — headline, lede, primary CTA (_Open Trevra_), secondary (_See approvals_ → `#approval`), the facts row (source · N modules · SBOM), and the `workspace.policy.yaml` figure.
2. **The gate** (`#approval`) — absorbs the former _How it runs_ section. Keeps the split heading, the `POLICY_CHECKS` table, the payload-hash line, the approve `<details>` with its released draft, and the three gate points. The `LEDGER_SAMPLE` table and its `<figure>` are deleted: the gate's own run already carries the ledger claim, and the _Full run ledger_ gate point states it.
3. **Deploy** (`#deploy`) — the hosted card (keeps `id="hosted"`) and the self-host card, then a collapsed `<details>` titled _See the N modules_ holding the module list, and the closing CTA line absorbed from the deleted `launch-final` section.

The footer stays; its Product column shrinks to the two live anchors.

### One anchor list

A single `NAV_LINKS` constant — `[{ href: '#approval', label: 'The gate' }, { href: '#deploy', label: 'Deploy' }]` — feeds the desktop nav, the burger `<details>`, and the footer's Product column. Three hand-kept copies become one.

### Calls to action

Three, each in a different place and each with a distinct job:

| Where       | Label                                                      | Destination                    |
| ----------- | ---------------------------------------------------------- | ------------------------------ |
| Nav         | Login                                                      | hosted `/login`, else `/login` |
| Hero        | Open Trevra                                                | `hostedAppUrl` or `#hosted`    |
| Hosted card | Launch managed workspace / Ask the founder for a workspace | hosted `/login` or `mailto:`   |

The closing CTA in Deploy reuses the hero's _Open Trevra_ anchor. GitHub links drop from six to three: nav, burger, footer. The hero facts row keeps the catalog JSON and SBOM links; the footer keeps its Source column; the third copy in the deleted catalog bar goes with it.

### Catalog

The live-registry read stays. Inside the Deploy `<details>`: `getPublicConfig` → `VITE_CATALOG_API_URL` → `/api/public/modules`, merged over the built-in `public/catalog/modules.json` by `normalizeRegistryModule`, rendered as `ModuleRow` with `SUMMARIES` and `SOURCE_FILES`, sorted by name.

Deleted: `MODULE_GROUPS`, `groupIndexOf`, `byGroupThenName`, the module search filter and its `moduleQuery` state, the `catalog-empty` branch, `SHOW_SYSTEM_MODULES`, and the `installable` filter it made a no-op. The hero's module count reads `liveModules.length`.

## index.html becomes generated

The root `index.html` keeps only what a template needs: `<head>` (every meta, canonical, Open Graph, Twitter, manifest, stylesheet, `theme.js`, and both `<!-- TREVRA_VERIFICATION -->` / `<!-- TREVRA_JSON_LD -->` placeholders), the skip link, an empty `<div id="root"></div>`, the `<noscript>`, and the module script tag. Every section of hand-written body markup is deleted.

A new `scripts/prerender-marketing.tsx` runs after the marketing build:

```
build:marketing = npm run catalog:build && npm run typecheck && vite build --mode marketing
  && tsx scripts/prerender-marketing.tsx dist/index.html
  && tsx scripts/build-marketing-headers.ts dist/_headers
```

It imports `MarketingApp`, renders it with `renderToStaticMarkup` from `react-dom/server` (React 19 is already a dependency), and replaces `<div id="root"></div>` in `dist/index.html` with `<div id="root">…</div>`. The head, the placeholders, and `_headers` generation are untouched.

### Contracts the prerender must preserve

- Every real CTA keeps `data-hosted-cta` and a `#hosted`-or-`/login` fallback href. `src/server/public-site.ts:383-391` rewrites those attributes per request, and `#hosted` remains the deploy card's id.
- `<!-- TREVRA_VERIFICATION -->` and `<!-- TREVRA_JSON_LD -->` survive verbatim; the server replaces them at request time.
- `src/server/public-site.test.ts` currently reads the repo-root `index.html` and asserts against its markup. It changes to render `MarketingApp` the same way the prerender script does, so the test guards the shipped contract rather than a file that is now a template.
- Dev (`vite`) serves the template with an empty root and hydrates normally; the prerendered markup exists only in `dist`.

## Sweep

Dead CSS after the cuts: `.run-section`, `.ledger`, `.ledger-cap`, `.ledger-cap-note`, `.ledger-table`, `.ledger-note`, `.row-gate`, `.row-blocked`, `.state-*`, `.catalog-section`, `.catalog-bar`, `.catalog-links`, `.catalog-filter`, `.catalog-empty`, `.module-group`, `.launch-final`, and any rule left with no matching class. Unused `PublicConfig` export in `src/client/api.ts`.

## Out of scope

`public/privacy`, `public/terms`, `public/security`, `llms.txt`, `sitemap.xml`, the SBOM and catalog build scripts, and the app shell served outside marketing mode.

## Milestones

1. **Sections** — fold _How it runs_ into the gate, delete `LEDGER_SAMPLE`, fold _final_ into Deploy.
2. **Nav, CTAs, links** — `NAV_LINKS`, three CTAs, three GitHub links.
3. **Catalog** — move into the Deploy `<details>`, delete groups/filter/dead flag.
4. **Prerender** — template `index.html`, `scripts/prerender-marketing.tsx`, `build:marketing`, `public-site.test.ts` rewritten.
5. **Sweep** — CSS, dead export, docs.

## Verification

- `npm run typecheck` clean; `npx vitest run src/server/public-site.test.ts src/client` green.
- `npm run build:marketing` succeeds and `dist/index.html` contains the rendered hero, gate, and deploy markup plus both untouched placeholders.
- `grep -c data-hosted-cta dist/index.html` matches the number of real CTAs.
- The page renders and every anchor scrolls with JavaScript disabled.

## Expected size

`MarketingScreen.tsx` 593 → ≈ 330 lines; `index.html` 297 → ≈ 60; ≈ −200 lines of CSS.
