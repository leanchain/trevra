# Cloudflare Pages deployment

Trevra uses one repository with two production targets:

- **Marketing edge:** the public landing page and generated module catalog are a Vite static build deployed to Cloudflare Pages.
- **Product runtime:** the authenticated Express/PostgreSQL application remains deployable as the hosted Trevra service or as a self-hosted installation.

This split keeps the public site fast and globally cached without pretending the PostgreSQL application is a static Pages application.

## GitHub repository configuration

Create a Cloudflare Pages project, then configure these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: a scoped token allowed to edit Cloudflare Pages projects.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account identifier.

Configure these GitHub Actions variables:

- `CLOUDFLARE_PAGES_PROJECT`: the exact Pages project name.
- `PUBLIC_SITE_URL`: the canonical marketing origin, for example `https://usetrevra.com`.
- `HOSTED_APP_URL`: the hosted Trevra application entry point, for example `https://app.usetrevra.com/#get-started`.
- `PUBLIC_GITHUB_URL`: the public repository or organization URL used by source and self-host CTAs.
- `PUBLIC_SUPPORT_EMAIL`: the founder or support address shown on the static site.
- `CATALOG_API_URL`: the hosted Trevra API origin used to load live module popularity and community releases.
- `SECURITY_CONTACT_EMAIL`: the address published in `/.well-known/security.txt` and `llms.txt`. Never the support address. Defaults to `security@<site hostname>` when unset.
- `GOOGLE_SITE_VERIFICATION`: optional Search Console token, injected into the built `index.html` as `meta[name=google-site-verification]`.
- `BING_SITE_VERIFICATION`: optional Bing Webmaster token, injected as `meta[name=msvalidate.01]`.

The last three are read by the build scripts rather than by Vite, so they are passed to the workflow under their own names, without the `VITE_` prefix. Unset means "no verification meta" and the `security@<hostname>` default, not a build failure.

The workflow in `.github/workflows/cloudflare-pages.yml` validates TypeScript, regenerates the public module catalog from the executable registry, builds the marketing-only bundle, stores a short-lived build artifact, and deploys pushes to `main`.

## Local build

```bash
npm ci
VITE_HOSTED_APP_URL=http://localhost:43173/#get-started \
VITE_GITHUB_URL=https://github.com/your-org/trevra \
VITE_SUPPORT_EMAIL=founder@example.com \
VITE_CATALOG_API_URL=http://localhost:43887 \
npm run build:marketing
```

The output is written to `dist/`. Serve it locally with any static server:

```bash
npx vite preview --host 0.0.0.0
```

## Module publishing flow

1. Add or update a typed skill in `src/server/skills` or `src/server/channels`.
2. Register the skill in `src/server/skills/registry.ts`.
3. Add tests for its contract, deterministic behavior, side-effect class, and approval requirement.
4. Run `npm run catalog:build`. This publishes the safe public fields to:
   - `src/generated/public-modules.json`, consumed by the landing page.
   - `public/catalog/modules.json`, consumed by people and agents.
5. Open a pull request. CI builds the exact catalog that will ship.
6. Merge to `main`. GitHub Actions deploys the landing page and catalog to Cloudflare Pages.

Installing or publishing a module never grants it external-write permission. Runtime policy and workspace approval still control execution.

## Agent and MCP routing

Cloudflare Pages hosts only the public marketing surface and generated module catalog. The restricted agent API and Streamable HTTP MCP endpoint run on the product service because they require PostgreSQL, workspace authentication, the skill runner, and the approval ledger.

Use the hosted product origin for MCP, for example:

```text
https://app.usetrevra.com/api/agent/mcp
```

Do not proxy agent bearer tokens into public Pages environment variables. DNS may remain behind Cloudflare, but `/api/agent/*` requests must reach the Express runtime.

## Hosted application routing

The marketing build calls only the public, aggregate registry routes when `VITE_CATALOG_API_URL` is configured. Set `PUBLIC_REGISTRY_CORS_ORIGIN` on the product runtime to the exact marketing origin. No authenticated API or customer data is exposed.

The marketing build never calls the private application API. `VITE_MARKETING_ONLY=true` renders the public page immediately, and `HOSTED_APP_URL` sends the primary CTA to the hosted application.

The hosted application can remain on Cloud Run or another Node/PostgreSQL platform. A custom hostname such as `app.usetrevra.com` may be proxied through Cloudflare DNS without moving the application runtime into Pages.

## Cache and security policy

`public/_headers` applies a restrictive browser policy. Hashed Vite assets are cached for one year. The generated catalog has a short browser cache with stale-while-revalidate so GitHub releases propagate quickly.

Update the `connect-src` value in `public/_headers` when the hosted application uses a different origin.
