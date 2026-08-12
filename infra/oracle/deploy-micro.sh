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

echo "==> database instance"
scp -q "${HERE}/compose.micro-db.yml" "ubuntu@${DB_IP}:${APP_DIR}/"
# DB_BIND_IP binds Postgres to the private address only -- never 0.0.0.0, which
# would expose it on the instance's public interface.
ssh "ubuntu@${DB_IP}" "cd ${APP_DIR} && DB_BIND_IP='${DB_PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml up -d --remove-orphans"

echo "==> waiting for postgres"
for _ in $(seq 1 30); do
  if ssh "ubuntu@${DB_IP}" "docker exec \$(docker ps -q -f name=postgres) pg_isready -U trevra -d trevra" >/dev/null 2>&1; then
    echo "postgres ready"
    break
  fi
  sleep 5
done

echo "==> app instance"
scp -q "${HERE}/compose.micro-app.yml" "ubuntu@${APP_IP}:${APP_DIR}/"
ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml pull"
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
