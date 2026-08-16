#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${TREVRA_BACKUP_DIR:-${ROOT_DIR}/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/trevra-${STAMP}.dump"
COMPOSE=(docker compose --env-file "${ROOT_DIR}/.env.selfhost" -f "${ROOT_DIR}/compose.selfhost.yml")

mkdir -p "${BACKUP_DIR}"
umask 077
"${COMPOSE[@]}" exec -T postgres pg_dump -U trevra -d trevra -Fc >"${DEST}"
chmod 600 "${DEST}"
printf '%s\n' "${DEST}"
