#!/usr/bin/env bash
# Deploys the current checkout to the Oracle Always Free box.
#
# Builds on the instance rather than locally: the target is ARM64 and the
# Dockerfile pulls arm64 base images there natively, which avoids either
# cross-building or shipping an emulated image.
#
# Usage:  ./deploy.sh <public-ip>
#
# Expects .env.oracle to already exist on the box at /opt/trevra/.env.oracle.
# It is never copied from here -- secrets stay on the instance.
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <public-ip>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE="ubuntu@${HOST}"
APP_DIR=/opt/trevra

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" true 2>/dev/null; then
  echo "cannot reach ${REMOTE} over SSH" >&2
  exit 1
fi

if ! ssh "$REMOTE" "test -f ${APP_DIR}/.env.oracle"; then
  echo "${APP_DIR}/.env.oracle is missing on the instance." >&2
  echo "Create it from infra/oracle/.env.oracle.example (see gen-secrets.sh), chmod 600." >&2
  exit 1
fi

echo "==> syncing source"
# Excludes keep local build output and any local env file from ever landing on
# the box; .env.oracle there is authoritative.
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'dist-server' \
  --exclude 'spike' \
  --exclude '.env*' \
  "${REPO_ROOT}/" "${REMOTE}:${APP_DIR}/src-tree/"

# compose.oracle.yml builds with context ../.. relative to infra/oracle, so the
# compose files are run from inside the synced tree.
echo "==> building image on the instance (ARM64, native)"
ssh "$REMOTE" "cd ${APP_DIR}/src-tree/infra/oracle && ln -sf ${APP_DIR}/.env.oracle .env.oracle && docker compose --env-file ${APP_DIR}/.env.oracle -f compose.oracle.yml build"

echo "==> starting stack"
ssh "$REMOTE" "cd ${APP_DIR}/src-tree/infra/oracle && docker compose --env-file ${APP_DIR}/.env.oracle -f compose.oracle.yml up -d --remove-orphans"

echo "==> waiting for health"
for _ in $(seq 1 30); do
  if ssh "$REMOTE" "docker compose -f ${APP_DIR}/src-tree/infra/oracle/compose.oracle.yml ps --format json 2>/dev/null | grep -q healthy"; then
    echo "stack is healthy"
    exit 0
  fi
  sleep 10
done

echo "stack did not report healthy within 5 minutes; check:" >&2
echo "  ssh ${REMOTE} 'cd ${APP_DIR}/src-tree/infra/oracle && docker compose logs --tail=100'" >&2
exit 1
