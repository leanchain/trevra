# SEO / GEO Hardening Design

**Goal:** give the production landing page — Cloudflare Pages, static `dist/` — the full SEO/GEO surface the Express server already renders, from one shared source of truth.

## Why the gap exists

`usetrevra.com` is the static marketing build (`.github/workflows/cloudflare-pages.yml` → `npm run build:marketing` → `wrangler pages deploy dist`). Everything in `src/server/public-site.ts` — JSON-LD injection, verification meta, `robots.txt`, `sitemap.xml`, `llms.txt`, `/how-it-works`, `/security` — only runs on the Express origin (`app.usetrevra.com`), where `renderAppIndex` deliberately bails out for the app shell. The public site therefore gets none of it.

## Audit findings

| #   | Finding                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Production ships **no JSON-LD and no verification meta**; `dist/index.html` carries the literal `<!-- TREVRA_JSON_LD -->` comment.                                                |
| 2   | `public/og/trevra-social.png` reads "AI revenue chief of staff for freelancers" — stale positioning on every share and LLM preview.                                               |
| 3   | `public/_redirects` sends `/how-it-works` to `/#how-it-works`, an anchor deleted in the marketing simplification.                                                                 |
| 4   | `public/sitemap.xml` omits `/security`, has no `lastmod`, diverges from the server sitemap.                                                                                       |
| 5   | Two titles compete: `index.html` "GTM infrastructure for AI agents" vs `getSiteConfig().title` "agent-run go-to-market that stops for your approval".                             |
| 6   | `https://usetrevra.com` is hardcoded in canonical / `og:url` / `og:image`; `PUBLIC_SITE_URL` is ignored, so preview deploys advertise the production canonical.                   |
| 7   | `structuredData()` `featureList`, `description`, and `llms.txt` still describe the pre-simplification product ("Revenue Proof Packs", "scope-creep detection", "source to paid"). |
| 8   | `FAQPage` JSON-LD has no visible counterpart on the page — Google requires the Q&A be visible, and answer engines have nothing quotable.                                          |
| 9   | `Organization` has no `sameAs`; no entity links to GitHub.                                                                                                                        |
| 10  | `public/{privacy,terms,security}/index.html` carry no `og:*`, no `twitter:*`, no JSON-LD.                                                                                         |
| 11  | Pages deploy has no `humans.txt`, no `llms-full.txt`, no `/.well-known/security.txt` — the server origin has all three.                                                           |

## Decisions

- **Canonical copy:** `Trevra — GTM infrastructure for AI agents` / `Trevra is open-source GTM infrastructure for Claude Code and Codex. Agents do the work, external actions require approval, and every run is logged.` One title and one description everywhere: `<title>`, `og:title`, `twitter:title`, `og:description`, `twitter:description`, JSON-LD, server config default. The "three deliberately different descriptions" rule is retired.
- **FAQ:** four Q&As ship visibly, collapsed, inside the Deploy section, sourced from the same array the `FAQPage` JSON-LD is built from.
- **OG image:** regenerated from a checked-in HTML source so it can be rebuilt when the copy changes.
- **`/how-it-works`:** ships as a real static page (`public/how-it-works/index.html`), so the redirect and the dead anchor both disappear.

## Shape

**`src/shared/site-metadata.ts`** — no node, express, db, or React imports, so the client bundle, the server, and the build scripts can all import it. Owns: `SITE_NAME`, `SITE_TITLE`, `SITE_DESCRIPTION`, `SOCIAL_IMAGE`, `FAQ_ITEMS`, `PUBLIC_PATHS`, `buildStructuredData()`, `buildWebPageStructuredData()`.

**`scripts/prerender-marketing.tsx`** — after filling `#root`, replaces `<!-- TREVRA_JSON_LD -->` and `<!-- TREVRA_VERIFICATION -->` and rewrites the hardcoded origin from `VITE_PUBLIC_SITE_URL`. Throws when a marker is missing, as it already does for `#root`.

**`scripts/build-marketing-seo.ts`** (new) — writes `dist/sitemap.xml`, `dist/llms.txt`, `dist/llms-full.txt`, `dist/humans.txt`, `dist/.well-known/security.txt` from the shared module. The `public/` copies of these files are deleted; generated is the only version.

**`scripts/build-marketing-headers.ts`** — reads the finished `dist/index.html`, hashes every inline `<script>` body, and adds the `'sha256-…'` sources to `script-src`, so the injected JSON-LD does not violate the CSP.

**`src/server/public-site.ts`** — imports the shared module instead of defining its own copies; `renderAppIndex` also rewrites `og:description` and `twitter:description`.

**Static pages** — `public/{privacy,terms,security,how-it-works}/index.html` get a uniform head: canonical, robots, full `og:*` and `twitter:*`, and a `WebPage` JSON-LD block. A test asserts every `public/**/index.html` has all four.

## Verification

- `npm run typecheck`
- `npx vitest run src/client src/shared`
- `npx tsx scripts/test-with-postgres.ts src/server/public-site.test.tsx`
- `npm run build:marketing`, then on `dist/index.html`: one `application/ld+json` block, no `TREVRA_` markers left, canonical/og/twitter titles all equal `SITE_TITLE`, and the `_headers` `script-src` carries a matching `sha256-` source.
