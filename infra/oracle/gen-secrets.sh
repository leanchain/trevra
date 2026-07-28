#!/usr/bin/env bash
# Generates the random secrets .env.oracle needs and prints them ready to paste.
# Values are printed to stdout only -- nothing is written to disk or logged, so
# redirect deliberately:  ./gen-secrets.sh >> .env.oracle && chmod 600 .env.oracle
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

# 32 bytes of entropy, base64url, no padding -- satisfies both the 32-char
# minimum in config.ts and the URL-safe charset INDEXNOW_KEY is checked against.
secret() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }

cat <<EOF
TREVRA_DB_PASSWORD=$(secret)
BETTER_AUTH_SECRET=$(secret)
MARKETING_HASH_SALT=$(secret)
TRACTION_ADMIN_TOKEN=$(secret)
TREVRA_AGENT_TOKEN_PEPPER=$(secret)
INDEXNOW_KEY=$(secret)
EOF

# Nango's encryption key must be exactly 32 bytes of standard base64.
cat <<EOF
# Only needed with the self-hosted Nango overlay:
# NANGO_DB_PASSWORD=$(secret)
# NANGO_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
