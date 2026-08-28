# Release automation

Trevra releases are driven from `main` and use immutable Git SHAs as the deployment source of truth.

## Pipeline

1. Pull requests and `main` run `.github/workflows/ci.yml`:
   - full PostgreSQL application suite;
   - production build and dependency audit;
   - companion CLI tests, audit and package-content check;
   - self-hosted Compose configuration validation.
2. Pushes to `main` run `.github/workflows/image.yml`. Its release gate runs a dependency audit and production build (the full PostgreSQL suite itself runs pre-push via `.githooks/pre-push`, not in this workflow) before publishing the amd64 + arm64 GHCR manifest under `sha-<full-git-sha>`, `main` and `latest`.
3. A successful `Container image` run on `main` triggers `.github/workflows/release.yml`:
   - resolves the next app patch release from existing `v*` tags;
   - detects whether publishable companion files changed since the latest `companion-v*` tag;
   - creates the next companion GitHub release tarball when needed;
   - independently catches npm up to that exact companion version through npm Trusted Publishing/OIDC;
   - deploys the immutable `sha-<git-sha>` image to Oracle through the guarded two-micro deploy script;
   - writes the non-secret required companion version into the app VM immediately before rollout, so the new relay never advertises a package that does not exist;
   - creates `v<version>` and `<version>` GHCR aliases and a GitHub app release only after Oracle reports healthy.
4. `.github/workflows/cloudflare-pages.yml` builds the marketing bundle on pull requests and deploys `main` through the `marketing` GitHub Environment.

A failed npm publish does not make the already-published GitHub companion tarball unsafe and does not stop the Oracle rollout. The workflow still reports the npm job failure so registry drift is visible, and the next release retries npm idempotently.

## GitHub Environments

### `production`

Branch policy: `main` only.

Secret:

- `ORACLE_SSH_PRIVATE_KEY` — dedicated Oracle deployment key.

Variables:

- `ORACLE_APP_IP`
- `ORACLE_DB_IP`
- `ORACLE_DB_PRIVATE_IP`
- `ORACLE_DEPLOY_TOPOLOGY` — `single-micro` when Postgres shares the app E2 micro, or `split-micro` when the second E2 boot slot is available.

The application/database secrets do **not** live in GitHub. They remain in `/opt/trevra/.env.oracle` on the two Oracle instances, mode `0600`. The deploy job can replace images and the non-secret companion release version but does not receive database/auth/Nango/Google/Cloudflare-tunnel secret values.

### `marketing`

Branch policy: `main` only.

Secret:

- `CLOUDFLARE_API_TOKEN` — a narrowly scoped Cloudflare API token allowed to deploy the `trevra` Pages project.

Variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT`

The public build variables (`PUBLIC_SITE_URL`, `HOSTED_APP_URL`, `PUBLIC_GITHUB_URL`, `PUBLIC_SUPPORT_EMAIL`, `CATALOG_API_URL`) are repository variables because they are intentionally public values embedded in the static bundle.

## npm Trusted Publishing

The automated npm publisher is the `Publish companion to npm` job in `.github/workflows/release.yml`. The npm package must trust:

- owner/organization: `leanchain`
- repository: `trevra`
- workflow: `release.yml`

The workflow requests only `id-token: write` and does not consume an npm token. Long-lived npm tokens must not be added back to GitHub Actions.

## Cloudflare authentication

External GitHub Actions deployment with Wrangler requires a Cloudflare API token; the interactive Wrangler OAuth session on a developer laptop is deliberately not copied into GitHub. Scope the CI token to the account/project needed for Pages deployment and store it only in the `marketing` environment.

## Self-hosted releases

Self-hosted Trevra does not receive a remote deployment from this repository: each operator owns their machine and `.env.selfhost`. CI validates its Compose contract on every change, and the multi-arch GHCR image is the centrally released artifact. Operators deploy/update with `scripts/selfhost-deploy.sh` or an immutable GHCR release tag as appropriate.
