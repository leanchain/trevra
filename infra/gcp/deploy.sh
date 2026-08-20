#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_REGION:=europe-west6}"
: "${TF_STATE_BUCKET:?Set TF_STATE_BUCKET}"
: "${APP_ORIGIN:?Set APP_ORIGIN to the public HTTPS app URL}"
: "${BETTER_AUTH_URL:=${APP_ORIGIN}}"
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID from the Google OAuth web client}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET from the Google OAuth web client}"
: "${PUBLIC_LEGAL_NAME:=Trevra}"
: "${PUBLIC_SUPPORT_EMAIL:?Set PUBLIC_SUPPORT_EMAIL to a monitored inbox}"
: "${ALERT_EMAIL:=${PUBLIC_SUPPORT_EMAIL}}"
: "${SECURITY_CONTACT_EMAIL:?Set SECURITY_CONTACT_EMAIL to a monitored vulnerability inbox}"
: "${GOOGLE_SITE_VERIFICATION:=}"
: "${BING_SITE_VERIFICATION:=}"
: "${NANGO_HOST:?Set NANGO_HOST to the public self-hosted Nango API URL}"
: "${NANGO_API_KEY:?Set NANGO_API_KEY}"
: "${NANGO_WEBHOOK_SIGNING_KEY:?Set NANGO_WEBHOOK_SIGNING_KEY}"
: "${TREVRA_ORCHESTRATOR:=postgres}"
: "${TEMPORAL_ADDRESS:=}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=trevra-playbooks}"
: "${TEMPORAL_TLS:=true}"
: "${TEMPORAL_API_KEY:=}"
: "${TREVRA_SANDBOX_GATEWAY_URL:=}"
: "${TREVRA_SANDBOX_GATEWAY_TOKEN:=}"
: "${PUBLIC_REGISTRY_CORS_ORIGIN:=${APP_ORIGIN}}"

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
export TF_VAR_smtp_server="${SMTP_SERVER}"
export TF_VAR_smtp_port="${SMTP_PORT}"
export TF_VAR_smtp_username="${SMTP_USERNAME}"
export TF_VAR_smtp_password="${SMTP_PASSWORD}"
export TF_VAR_email_from="${EMAIL_FROM}"
export TF_VAR_email_from_name="${EMAIL_FROM_NAME}"
export TF_VAR_legal_name="${PUBLIC_LEGAL_NAME}"}]}
export TF_VAR_support_email="${PUBLIC_SUPPORT_EMAIL}"
export TF_VAR_alert_email="${ALERT_EMAIL}"
export TF_VAR_security_contact_email="${SECURITY_CONTACT_EMAIL}"
export TF_VAR_google_site_verification="${GOOGLE_SITE_VERIFICATION}"
export TF_VAR_bing_site_verification="${BING_SITE_VERIFICATION}"
export TF_VAR_nango_host="${NANGO_HOST}"
export TF_VAR_nango_api_key="${NANGO_API_KEY}"
export TF_VAR_nango_webhook_signing_key="${NANGO_WEBHOOK_SIGNING_KEY}"
export TF_VAR_orchestrator="${TREVRA_ORCHESTRATOR}"
export TF_VAR_temporal_address="${TEMPORAL_ADDRESS}"
export TF_VAR_temporal_namespace="${TEMPORAL_NAMESPACE}"
export TF_VAR_temporal_task_queue="${TEMPORAL_TASK_QUEUE}"
export TF_VAR_temporal_tls="${TEMPORAL_TLS}"
export TF_VAR_temporal_api_key="${TEMPORAL_API_KEY}"
export TF_VAR_sandbox_gateway_url="${TREVRA_SANDBOX_GATEWAY_URL}"
export TF_VAR_sandbox_gateway_token="${TREVRA_SANDBOX_GATEWAY_TOKEN}"
export TF_VAR_registry_cors_origin="${PUBLIC_REGISTRY_CORS_ORIGIN}"

gcloud config set project "${GCP_PROJECT_ID}"
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com monitoring.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com

terraform -chdir="${TF_DIR}" init \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=trevra/production"

terraform -chdir="${TF_DIR}" apply -auto-approve \
  -target=google_project_service.required \
  -target=google_artifact_registry_repository.trevra

gcloud builds submit "${ROOT_DIR}" --tag "${IMAGE}" --project "${GCP_PROJECT_ID}"
terraform -chdir="${TF_DIR}" apply -auto-approve

INDEXNOW_KEY="$(terraform -chdir="${TF_DIR}" output -raw indexnow_key)"
PUBLIC_SITE_URL="${APP_ORIGIN}" INDEXNOW_KEY="${INDEXNOW_KEY}" npm --prefix "${ROOT_DIR}" run seo:submit || \
  printf 'Warning: IndexNow submission failed; run npm run seo:submit after DNS is live.\n' >&2

printf '\nTrevra deployed.\nURL: %s\nImage: %s\nGoogle callback: %s/api/auth/callback/google\nSitemap: %s/sitemap.xml\nTraction token: terraform -chdir=%s output -raw traction_admin_token\n' \
  "$(terraform -chdir="${TF_DIR}" output -raw cloud_run_url)" "${IMAGE}" "${BETTER_AUTH_URL%/}" "${APP_ORIGIN%/}" "${TF_DIR}"
