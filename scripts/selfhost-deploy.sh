#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --env-file "${ROOT_DIR}/.env.selfhost" -f "${ROOT_DIR}/compose.selfhost.yml")

"${ROOT_DIR}/scripts/selfhost-init.sh"

# Build first so migrate/app/worker all execute the exact same immutable local
# image. Compose then runs the migration job to completion before either long-
# lived process is allowed to start.
# A production image must reflect the audited lockfile exactly. Reusing a stale
# npm-ci layer can make `npm sbom` compare current metadata with old modules, so
# this path deliberately trades a little build time for reproducibility.
"${COMPOSE[@]}" build --no-cache app
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 120

PORT="$(awk -F= '$1=="TREVRA_SELFHOST_PORT" {print $2}' "${ROOT_DIR}/.env.selfhost")"
PORT="${PORT:-43900}"
curl --fail --silent --show-error "http://localhost:${PORT}/api/health" >/dev/null
printf 'Trevra self-hosted production is healthy at http://localhost:%s\n' "${PORT}"
