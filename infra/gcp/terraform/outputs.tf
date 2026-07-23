output "cloud_run_url" {
  value = google_cloud_run_v2_service.trevra.uri
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.trevra.connection_name
}

output "artifact_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.trevra.repository_id}"
}

output "runtime_service_account" {
  value = google_service_account.cloud_run.email
}
