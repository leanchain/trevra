#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
: "${GCP_REGION:=europe-west6}"
: "${TF_STATE_BUCKET:?Set TF_STATE_BUCKET to a globally unique bucket name}"

gcloud config set project "${GCP_PROJECT_ID}"
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com storage.googleapis.com

if ! gcloud storage buckets describe "gs://${TF_STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${TF_STATE_BUCKET}" --versioning
printf 'Terraform state bucket ready: gs://%s\n' "${TF_STATE_BUCKET}"
