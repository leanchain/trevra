#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_REGION:=europe-west6}"
: "${TF_STATE_BUCKET:?Set TF_STATE_BUCKET}"
: "${APP_ORIGIN:?Set APP_ORIGIN to the public HTTPS app URL}"
: "${BETTER_AUTH_URL:=${APP_ORIGIN}}"
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID from the Google OAuth web client}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET from the Google OAuth web client}"
: "${NANGO_HOST:?Set NANGO_HOST to the public self-hosted Nango API URL}"
: "${NANGO_API_KEY:?Set NANGO_API_KEY}"
: "${NANGO_WEBHOOK_SIGNING_KEY:?Set NANGO_WEBHOOK_SIGNING_KEY}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/gcp/terraform"
REPOSITORY="trevra"
TAG="${IMAGE_TAG:-$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPOSITORY}/trevra:${TAG}"

export TF_VAR_project_id="${GCP_PROJECT_ID}"
export TF_VAR_region="${GCP_REGION}"
export TF_VAR_image="${IMAGE}"
export TF_VAR_app_origin="${APP_ORIGIN}"
export TF_VAR_better_auth_url="${BETTER_AUTH_URL}"
export TF_VAR_google_client_id="${GOOGLE_CLIENT_ID}"
export TF_VAR_google_client_secret="${GOOGLE_CLIENT_SECRET}"
export TF_VAR_nango_host="${NANGO_HOST}"
export TF_VAR_nango_api_key="${NANGO_API_KEY}"
export TF_VAR_nango_webhook_signing_key="${NANGO_WEBHOOK_SIGNING_KEY}"

gcloud config set project "${GCP_PROJECT_ID}"
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com

terraform -chdir="${TF_DIR}" init \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=trevra/production"

terraform -chdir="${TF_DIR}" apply -auto-approve \
  -target=google_project_service.required \
  -target=google_artifact_registry_repository.trevra

gcloud builds submit "${ROOT_DIR}" --tag "${IMAGE}" --project "${GCP_PROJECT_ID}"
terraform -chdir="${TF_DIR}" apply -auto-approve

printf '\nTrevra deployed.\nURL: %s\nImage: %s\nGoogle callback: %s/api/auth/callback/google\n' \
  "$(terraform -chdir="${TF_DIR}" output -raw cloud_run_url)" "${IMAGE}" "${BETTER_AUTH_URL%/}"
