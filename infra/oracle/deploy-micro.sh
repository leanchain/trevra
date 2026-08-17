#!/usr/bin/env bash
# Deploys the split two-micro layout: Postgres on one instance, app + worker +
# tunnel on the other. Both pull prebuilt images from ghcr.io; neither builds.
#
# Usage:  ./deploy-micro.sh <app-ip> <db-ip> <db-private-ip> [image-tag] [companion-version]
#         (terraform-micro prints the base command as `deploy_command`)
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
COMPANION_VERSION="${5:-}"

if [ -z "$APP_IP" ] || [ -z "$DB_IP" ] || [ -z "$DB_PRIVATE_IP" ]; then
  echo "usage: $0 <app-ip> <db-ip> <db-private-ip> [image-tag] [companion-version]" >&2
  exit 1
fi
if [ -n "$COMPANION_VERSION" ] && [[ ! "$COMPANION_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "companion-version must look like 0.2.3" >&2
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

# The companion package is released before the app rollout. Put the exact
# version into the server-local environment atomically so the new relay only
# advertises an asset that already exists. The value is non-secret, but the env
# file also contains secrets and therefore stays mode 0600.
if [ -n "$COMPANION_VERSION" ]; then
  ssh "ubuntu@${APP_IP}" "set -eu; f='${APP_DIR}/.env.oracle'; tmp=\$(mktemp); grep -v '^TREVRA_COMPANION_RELEASE_VERSION=' \"\$f\" > \"\$tmp\"; printf '%s\\n' 'TREVRA_COMPANION_RELEASE_VERSION=${COMPANION_VERSION}' >> \"\$tmp\"; chmod 600 \"\$tmp\"; mv \"\$tmp\" \"\$f\""
fi

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
# The app micro is deliberately small. Keep the OLD API serving, but quiesce the
# old worker while the one-shot migration/readiness process runs so the two
# memory-heavy Node workers never compete with it. Remember whether a worker
# actually existed/running so a failed migration can restore the previous
# release before this script exits.
WORKER_WAS_RUNNING="$(ssh "ubuntu@${APP_IP}" "docker inspect -f '{{.State.Running}}' trevra-worker-1 2>/dev/null || true")"
if [ "$WORKER_WAS_RUNNING" = "true" ]; then
  echo "==> pausing old worker for migration headroom"
  ssh "ubuntu@${APP_IP}" "docker stop -t 30 trevra-worker-1 >/dev/null"
fi

# A completed one-shot migrate container can survive an interrupted Compose
# replacement under a temporary name. Remove only that service before the new
# one-shot run; the old API remains serving throughout this gate.
ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml rm -sf migrate >/dev/null 2>&1 || true"

# `docker compose up migrate` can print `exited with code 137` and still return
# zero itself. --exit-code-from makes the container's exit code the SSH command
# exit code, so set -e can finally mean fail-fast. Do NOT replace API/worker on
# anything except an explicit migration exit 0.
if ! ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate"; then
  echo "migration/readiness failed; keeping the old API and restoring the old worker" >&2
  if [ "$WORKER_WAS_RUNNING" = "true" ]; then
    ssh "ubuntu@${APP_IP}" "docker start trevra-worker-1 >/dev/null" || true
  fi
  exit 1
fi

echo "==> rolling hosted app and worker"
# Migration has already succeeded. Target only the long-lived processes so
# Compose does not recreate the one-shot migration container a second time.
# Cloudflared remains up and reconnects to the newly healthy API.
ssh "ubuntu@${APP_IP}" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up -d --no-deps --force-recreate trevra worker"

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
