#!/usr/bin/env bash
# Deploy Trevra on one Always Free VM.Standard.E2.1.Micro. The durable block
# volume is attached to this host and Postgres is run as a separate Compose
# project so the same app compose file can also be used by the split-micro
# topology.
#
# Usage: ./deploy-single-micro.sh <app-public-ip> [image-tag] [companion-version]
set -euo pipefail

HOST="${1:-${TREVRA_ORACLE_APP_IP:-}}"
TAG="${2:-${TREVRA_ORACLE_TAG:-main}}"
COMPANION_VERSION="${3:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <app-public-ip> [image-tag] [companion-version]" >&2
  exit 1
fi
if [ -n "$COMPANION_VERSION" ] && [[ ! "$COMPANION_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "companion-version must look like 0.2.3" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/trevra
REMOTE="ubuntu@${HOST}"
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
  echo "${APP_DIR}/.env.oracle is missing on the instance" >&2
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
  echo "Hosted environment is incomplete; refusing deployment." >&2
  exit 1
fi

# The data volume must already be mounted. Never format or invent an empty
# database during a release: absence is a recovery event, not a deploy action.
if ! ssh "$REMOTE" "mountpoint -q /mnt/data && sudo test -f /mnt/data/postgres/PG_VERSION"; then
  echo "durable Postgres volume is not mounted at /mnt/data; refusing deployment" >&2
  exit 1
fi

PRIVATE_IP="$(ssh "$REMOTE" "ip route get 1.1.1.1 | sed -n 's/.* src \\([^ ]*\\).*/\\1/p'")"
if [ -z "$PRIVATE_IP" ]; then
  echo "could not determine the instance private IP" >&2
  exit 1
fi

# Keep DATABASE_URL pointed at the host-private address. Containers reach the
# published Postgres port without exposing it to the public internet; OCI's
# security list permits 5432 only from inside the VCN.
ssh "$REMOTE" python3 - "$PRIVATE_IP" <<'REMOTE_PY'
from pathlib import Path
import re, sys
host=sys.argv[1]
p=Path('/opt/trevra/.env.oracle')
s=p.read_text()
new,n=re.subn(r'^(DATABASE_URL=postgres(?:ql)?://[^@\n]+@)[^:/\n]+', rf'\g<1>{host}', s, count=1, flags=re.M)
if n == 0:
    raise SystemExit('DATABASE_URL is missing or malformed')
t=Path('/opt/trevra/.env.oracle.tmp')
t.write_text(new)
t.chmod(0o600)
t.replace(p)
REMOTE_PY

if [ -n "$COMPANION_VERSION" ]; then
  ssh "$REMOTE" "set -eu; f='${APP_DIR}/.env.oracle'; tmp=\$(mktemp); grep -v '^TREVRA_COMPANION_RELEASE_VERSION=' \"\$f\" > \"\$tmp\"; printf '%s\\n' 'TREVRA_COMPANION_RELEASE_VERSION=${COMPANION_VERSION}' >> \"\$tmp\"; chmod 600 \"\$tmp\"; mv \"\$tmp\" \"\$f\""
fi

LOCK="${APP_DIR}/.deploy-lock"
TOKEN="$(hostname)-$$-$(date +%s)"
ssh "$REMOTE" bash -s -- "$LOCK" "$TOKEN" <<'REMOTE_LOCK'
set -euo pipefail
lock="$1"; token="$2"
if mkdir "$lock" 2>/dev/null; then
  printf '%s\n' "$token" > "$lock/owner"
  exit 0
fi
if find "$lock" -maxdepth 0 -mmin +45 -print -quit 2>/dev/null | grep -q .; then
  rm -rf "$lock"; mkdir "$lock"; printf '%s\n' "$token" > "$lock/owner"; exit 0
fi
echo "another Trevra deploy is already running" >&2
exit 75
REMOTE_LOCK
release_lock() {
  ssh "$REMOTE" bash -s -- "$LOCK" "$TOKEN" <<'REMOTE_UNLOCK' >/dev/null 2>&1 || true
set -euo pipefail
lock="$1"; token="$2"
if [ -d "$lock" ] && [ "$(cat "$lock/owner" 2>/dev/null || true)" = "$token" ]; then rm -rf "$lock"; fi
REMOTE_UNLOCK
}
trap release_lock EXIT

echo "==> syncing single-micro compose files"
scp -q "${HERE}/compose.micro-app.yml" "${HERE}/compose.micro-db.yml" "${REMOTE}:${APP_DIR}/"

echo "==> ensuring postgres is running from the attached data volume"
ssh "$REMOTE" "cd ${APP_DIR} && DB_BIND_IP='${PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml up -d --no-recreate"
postgres_ready=false
for _ in $(seq 1 30); do
  if ssh "$REMOTE" "cd ${APP_DIR} && DB_BIND_IP='${PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_isready -U trevra -d trevra" >/dev/null 2>&1; then
    postgres_ready=true; break
  fi
  sleep 2
done
if [ "$postgres_ready" != true ]; then
  echo "postgres did not become ready" >&2
  exit 1
fi

echo "==> pre-deploy database backup"
BACKUP="/mnt/data/backups/trevra-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
ssh "$REMOTE" "sudo install -d -m 700 -o ubuntu -g ubuntu /mnt/data/backups && cd ${APP_DIR} && DB_BIND_IP='${PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_dump -U trevra -d trevra -Fc > '${BACKUP}' && chmod 600 '${BACKUP}' && DB_BIND_IP='${PRIVATE_IP}' docker compose --env-file .env.oracle -f compose.micro-db.yml exec -T postgres pg_restore -l < '${BACKUP}' >/dev/null && find /mnt/data/backups -type f -name 'trevra-predeploy-*.dump' -mtime +14 -delete"

if [ "${TREVRA_SKIP_PULL:-false}" = true ]; then
  ssh "$REMOTE" "docker image inspect 'ghcr.io/leanchain/trevra:${TAG}' >/dev/null"
else
  echo "==> pulling ghcr.io/leanchain/trevra:${TAG}"
  ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml pull"
fi

# The 1 GB host cannot safely run the old worker plus the migration process at
# their configured cgroup ceilings. Stop only the worker; the old API keeps
# serving against the same database while the migration gate runs.
WORKER_WAS_RUNNING="$(ssh "$REMOTE" "docker inspect -f '{{.State.Running}}' trevra-worker-1 2>/dev/null || true")"
if [ "$WORKER_WAS_RUNNING" = true ]; then
  echo "==> pausing worker for migration headroom"
  ssh "$REMOTE" "docker stop -t 30 trevra-worker-1 >/dev/null"
fi

ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml rm -sf migrate >/dev/null 2>&1 || true"
if ! ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate"; then
  echo "migration/readiness failed; leaving the old API in place" >&2
  if [ "$WORKER_WAS_RUNNING" = true ]; then ssh "$REMOTE" "docker start trevra-worker-1 >/dev/null" || true; fi
  exit 1
fi

echo "==> recreating API, worker and tunnel"
ssh "$REMOTE" "cd ${APP_DIR} && TREVRA_IMAGE_TAG='${TAG}' docker compose --env-file .env.oracle -f compose.micro-app.yml up -d --remove-orphans"

for _ in $(seq 1 40); do
  api="$(ssh "$REMOTE" "docker inspect -f '{{.State.Health.Status}}' trevra-trevra-1 2>/dev/null || true")"
  worker="$(ssh "$REMOTE" "docker inspect -f '{{.State.Health.Status}}' trevra-worker-1 2>/dev/null || true")"
  pg="$(ssh "$REMOTE" "docker inspect -f '{{.State.Health.Status}}' trevra-db-postgres-1 2>/dev/null || true")"
  if [ "$api" = healthy ] && [ "$worker" = healthy ] && [ "$pg" = healthy ]; then
    echo "single-micro stack is healthy"
    exit 0
  fi
  sleep 3
done

echo "single-micro stack did not become healthy" >&2
ssh "$REMOTE" "docker ps --format '{{.Names}} {{.Status}}'" >&2 || true
exit 1
