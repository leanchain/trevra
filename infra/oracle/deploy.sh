#!/usr/bin/env bash
# Deploys to the Oracle box by pulling a prebuilt image.
#
# The image is built by .github/workflows/image.yml as a multi-arch manifest
# (amd64 + arm64) and published to ghcr.io. Nothing is built on the instance:
# an E2.1.Micro has 1 GB of RAM and cannot run tsc + vite, and even the A1 box
# would spend several minutes per deploy doing work a runner does for free.
#
# Usage:  ./deploy.sh <public-ip> [image-tag]
#
# Expects /opt/trevra/.env.oracle to exist on the box. It is never copied from
# here -- secrets stay on the instance.
set -euo pipefail

HOST="${1:-}"
TAG="${2:-main}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <public-ip> [image-tag]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE="ubuntu@${HOST}"
APP_DIR=/opt/trevra

# Terraform authorises a dedicated key rather than a default identity.
SSH_KEY="${SSH_KEY:-$HOME/.ssh/trevra_oracle}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
scp() { command scp "${SSH_OPTS[@]}" "$@"; }

if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key not found at ${SSH_KEY}; set SSH_KEY=/path/to/key" >&2
  exit 1
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" true 2>/dev/null; then
  echo "cannot reach ${REMOTE} over SSH" >&2
  exit 1
fi

if ! ssh "$REMOTE" "test -f ${APP_DIR}/.env.oracle"; then
  echo "${APP_DIR}/.env.oracle is missing on the instance." >&2
  echo "Create it from infra/oracle/.env.oracle.example (see gen-secrets.sh), chmod 600." >&2
  exit 1
fi
if ! ssh "$REMOTE" bash -s -- "${APP_DIR}/.env.oracle" <<'REMOTE_ENV'
set -euo pipefail
file="$1"
required=(
  TREVRA_DB_PASSWORD CLOUDFLARE_TUNNEL_TOKEN
  APP_ORIGIN BETTER_AUTH_URL PUBLIC_SITE_URL
  BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  PUBLIC_SUPPORT_EMAIL SECURITY_CONTACT_EMAIL
  MARKETING_HASH_SALT TRACTION_ADMIN_TOKEN TREVRA_AGENT_TOKEN_PEPPER INDEXNOW_KEY
  NANGO_API_KEY NANGO_WEBHOOK_SIGNING_KEY TREVRA_SECRETS_KEY
  SMTP_SERVER SMTP_PORT SMTP_USERNAME SMTP_PASSWORD EMAIL_FROM
  TREVRA_COMPANION_RELEASE_VERSION
)
missing=()
for key in "${required[@]}"; do
  grep -Eq "^${key}=.+$" "$file" || missing+=("$key")
done
if ((${#missing[@]})); then
  printf 'missing managed environment: %s\n' "${missing[*]}" >&2
  exit 1
fi
REMOTE_ENV
then
  echo "${APP_DIR}/.env.oracle is incomplete; hosted deployment refuses to proceed." >&2
  exit 1
fi

# Only the compose files need to be on the box now that the image is prebuilt.
echo "==> syncing compose files"
scp -q "${REPO_ROOT}/infra/oracle/compose.oracle.yml" \
       "${REPO_ROOT}/infra/oracle/compose.oracle.nango.yml" \
       "${REMOTE}:${APP_DIR}/"

if [ "${TREVRA_SKIP_PULL:-false}" = "true" ]; then
  echo "==> using preloaded ghcr.io/leanchain/trevra:${TAG}"
  ssh "$REMOTE" "docker image inspect 'ghcr.io/leanchain/trevra:${TAG}' >/dev/null"
else
  echo "==> pulling ghcr.io/leanchain/trevra:${TAG}"
  ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.oracle.yml pull"
fi

# Snapshot the attached-volume database before a schema change.
echo "==> pre-deploy database backup"
BACKUP="/mnt/data/backups/trevra-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
ssh "$REMOTE" "sudo install -d -m 700 -o ubuntu -g ubuntu /mnt/data/backups && cd ${APP_DIR} && docker compose --env-file .env.oracle -f compose.oracle.yml exec -T postgres pg_dump -U trevra -d trevra -Fc > '${BACKUP}' && chmod 600 '${BACKUP}' && docker compose --env-file .env.oracle -f compose.oracle.yml exec -T postgres pg_restore -l < '${BACKUP}' >/dev/null && find /mnt/data/backups -type f -name 'trevra-predeploy-*.dump' -mtime +14 -delete"

echo "==> release migrations and hosted data hardening"
# Clear only the completed one-shot migration service before recreating it. This
# avoids Docker's temporary-name conflict after an interrupted previous deploy
# without touching the running API or worker.
ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.oracle.yml rm -sf migrate >/dev/null 2>&1 || true"
ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.oracle.yml up --no-deps --force-recreate migrate"

echo "==> starting stack"
ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.oracle.yml up -d --remove-orphans"

echo "==> waiting for health"
# --env-file is required even to read status: the compose file uses ${VAR:?}
# guards, so without it interpolation fails and ps never runs. Silently losing
# that error made this loop time out against an already-healthy stack.
PS_CMD="cd ${APP_DIR} && docker compose --env-file .env.oracle -f compose.oracle.yml ps --format json 2>/dev/null"
for _ in $(seq 1 30); do
  status="$(ssh "$REMOTE" "$PS_CMD" || true)"
  # Every container with a healthcheck must be healthy -- not merely one of
  # them, which a bare grep for "healthy" would accept.
  if [ -n "$status" ] &&
     ! grep -q '"Health":"unhealthy"' <<<"$status" &&
     ! grep -q '"Health":"starting"' <<<"$status" &&
     grep -q '"Health":"healthy"' <<<"$status"; then
    echo "stack is healthy"
    exit 0
  fi
  sleep 10
done

echo "stack did not report healthy within 5 minutes; check:" >&2
echo "  ssh ${REMOTE} 'cd ${APP_DIR} && docker compose --env-file .env.oracle -f compose.oracle.yml logs --tail=100'" >&2
exit 1
