#!/usr/bin/env bash
# Deploys the split two-micro layout: Postgres on one instance, app + worker +
# tunnel on the other. Both pull prebuilt images from ghcr.io; neither builds.
#
# Usage:  ./deploy-micro.sh <app-ip> <db-ip> <db-private-ip> [image-tag]
#         (terraform-micro prints the exact command as `deploy_command`)
#
# Each instance needs its own /opt/trevra/.env.oracle:
#   db  -- TREVRA_DB_PASSWORD
#   app -- everything else, including a DATABASE_URL pointing at <db-private-ip>
#          and matching TREVRA_DB_PASSWORD
set -euo pipefail

APP_IP="${1:-}"
DB_IP="${2:-}"
DB_PRIVATE_IP="${3:-}"
TAG="${4:-main}"

if [ -z "$APP_IP" ] || [ -z "$DB_IP" ] || [ -z "$DB_PRIVATE_IP" ]; then
  echo "usage: $0 <app-ip> <db-ip> <db-private-ip> [image-tag]" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/trevra

# Terraform authorises a dedicated key rather than a default identity, so both
# ssh and scp are wrapped to use it. Override with SSH_KEY= if you used another.
SSH_KEY="${SSH_KEY:-$HOME/.ssh/trevra_oracle}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
ssh()  { command ssh "${SSH_OPTS[@]}" "$@"; }
scp()  { command scp "${SSH_OPTS[@]}" "$@"; }

if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key not found at ${SSH_KEY}; set SSH_KEY=/path/to/key" >&2
  exit 1
fi

check_host() {
  local remote="$1" label="$2"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$remote" true 2>/dev/null; then
    echo "cannot reach ${label} (${remote}) over SSH" >&2
    exit 1
  fi
  if ! ssh "$remote" "test -f ${APP_DIR}/.env.oracle"; then
    echo "${APP_DIR}/.env.oracle is missing on ${label}." >&2
    exit 1
  fi
}

check_host "ubuntu@${DB_IP}" db
check_host "ubuntu@${APP_IP}" app

# Hosted custody must exist BEFORE the migration job can convert any legacy
# credential-bearing rows. Do not echo the value; only verify presence.
if ! ssh "ubuntu@${APP_IP}" "grep -Eq '^TREVRA_SECRETS_KEY=.+$' ${APP_DIR}/.env.oracle"; then
  echo "${APP_DIR}/.env.oracle on app is missing TREVRA_SECRETS_KEY; generate 32 random base64 bytes before deploying hosted." >&2
  exit 1
fi

echo "==> database instance"
scp -q "${HERE}/compose.micro-db.yml" "ubuntu@${DB_IP}:${APP_DIR}/"
# DB_BIND_IP binds Postgres to the private address only -- never 0.0.0.0, which
# would expose it on the instance's public interface.
# Application releases do not restart a healthy database just because the
# compose file now pins the same image by digest. Database patching is a
# separate maintenance action; preserve the live Postgres process here.
ssh "ubuntu@${DB_IP}" "cd ${APP_DIR} && DB_BIND_IP='${DB_PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml up -d --no-recreate --remove-orphans"

echo "==> waiting for postgres"
postgres_ready=false
for _ in $(seq 1 30); do
  if ssh "ubuntu@${DB_IP}" "cd ${APP_DIR} && DB_BIND_IP='${DB_PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_isready -U trevra -d trevra" >/dev/null 2>&1; then
    echo "postgres ready"
    postgres_ready=true
    break
  fi
  sleep 5
done
if [ "$postgres_ready" != true ]; then
  echo "postgres did not become ready" >&2
  exit 1
fi

# Every hosted rollout gets a restorable database snapshot BEFORE migrations.
# It stays on the attached data volume, mode 0600, and old deploy snapshots are
# pruned after two weeks. A failed migration therefore leaves both the old app
# still serving and a pre-change database archive available.
echo "==> pre-deploy database backup"
BACKUP="/mnt/data/backups/trevra-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
ssh "ubuntu@${DB_IP}" "sudo install -d -m 700 -o ubuntu -g ubuntu /mnt/data/backups && cd ${APP_DIR} && DB_BIND_IP='${DB_PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_dump -U trevra -d trevra -Fc > '${BACKUP}' && chmod 600 '${BACKUP}' && DB_BIND_IP='${DB_PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_restore -l < '${BACKUP}' >/dev/null && find /mnt/data/backups -type f -name 'trevra-predeploy-*.dump' -mtime +14 -delete"
echo "backup: ${BACKUP}"

echo "==> app instance"
scp -q "${HERE}/compose.micro-app.yml" "ubuntu@${APP_IP}:${APP_DIR}/"
if [ "${TREVRA_SKIP_PULL:-false}" = "true" ]; then
  echo "==> using preloaded ghcr.io/leanchain/trevra:${TAG}"
  ssh "ubuntu@${APP_IP}" "docker image inspect 'ghcr.io/leanchain/trevra:${TAG}' >/dev/null"
else
  ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml pull"
fi

echo "==> release migrations and hosted data hardening"
# Foreground and fail-fast. The currently running app/worker are untouched until
# this exits 0. The exited migrate container is then the dependency app/worker
# require below.
ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up --no-deps --force-recreate migrate"

echo "==> rolling hosted app and worker"
ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up -d --remove-orphans"

echo "==> waiting for health"
# --env-file is required even to read status: the compose file uses ${VAR:?}
# guards, so without it interpolation fails and ps never runs. Silently losing
# that error made this loop time out against an already-healthy stack.
PS_CMD="cd ${APP_DIR} && docker compose --env-file .env.oracle -f compose.micro-app.yml ps --format json 2>/dev/null"
for _ in $(seq 1 30); do
  status="$(ssh "ubuntu@${APP_IP}" "$PS_CMD" || true)"
  # Every container with a healthcheck must be healthy -- not merely one of
  # them, which a bare grep for "healthy" would accept.
  if [ -n "$status" ] &&
     ! grep -q '"Health":"unhealthy"' <<<"$status" &&
     ! grep -q '"Health":"starting"' <<<"$status" &&
     grep -q '"Health":"healthy"' <<<"$status"; then
    echo "stack is healthy"
    ssh "ubuntu@${APP_IP}" "free -m | head -2"
    exit 0
  fi
  sleep 10
done

echo "app did not report healthy within 5 minutes; check:" >&2
echo "  ssh ubuntu@${APP_IP} 'cd ${APP_DIR} && docker compose --env-file .env.oracle -f compose.micro-app.yml logs --tail=100'" >&2
exit 1
