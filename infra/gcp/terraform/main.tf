locals {
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com"
  ])

  secret_values = {
    "database-url"              = "postgresql://${var.database_user}:${urlencode(random_password.database.result)}@/${var.database_name}?host=/cloudsql/${google_sql_database_instance.trevra.connection_name}"
    "better-auth-secret"        = random_password.better_auth.result
    "google-client-id"          = var.google_client_id
    "google-client-secret"      = var.google_client_secret
    "nango-api-key"             = var.nango_api_key
    "nango-webhook-signing-key" = var.nango_webhook_signing_key
    "ingest-api-key"            = random_password.ingest.result
  }
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = local.required_apis
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "trevra" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository
  description   = "Trevra production containers"
  format        = "DOCKER"

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "remove-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "cloud_run" {
  project      = var.project_id
  account_id   = "trevra-cloud-run"
  display_name = "Trevra Cloud Run runtime"
}

resource "google_project_iam_member" "cloud_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "google_artifact_registry_repository_iam_member" "runtime_reader" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.trevra.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "google_project_iam_member" "cloud_build_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"
}

resource "random_password" "database" {
  length           = 40
  special          = true
  override_special = "-._~"
}

resource "random_password" "better_auth" {
  length  = 64
  special = false
}

resource "random_password" "ingest" {
  length  = 64
  special = false
}

resource "google_sql_database_instance" "trevra" {
  project             = var.project_id
  name                = "trevra-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.database_tier
    availability_type = "REGIONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.database_disk_size_gb
    disk_autoresize   = true
    edition           = "ENTERPRISE"

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      record_client_address   = false
      query_string_length     = 2048
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "trevra" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.trevra.name
}

resource "google_sql_user" "trevra" {
  project  = var.project_id
  name     = var.database_user
  instance = google_sql_database_instance.trevra.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "application" {
  for_each  = local.secret_values
  project   = var.project_id
  secret_id = "trevra-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "application" {
  for_each    = local.secret_values
  secret      = google_secret_manager_secret.application[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.application
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "google_cloud_run_v2_service" "trevra" {
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  deletion_protection = var.deletion_protection
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.cloud_run.email
    timeout                          = "300s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.trevra.connection_name]
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "APP_ORIGIN"
        value = var.app_origin
      }
      env {
        name  = "BETTER_AUTH_URL"
        value = var.better_auth_url
      }
      env {
        name  = "COOKIE_SECURE"
        value = "true"
      }
      env {
        name  = "DATABASE_POOL_MAX"
        value = tostring(var.database_pool_max)
      }
      env {
        name  = "NANGO_HOST"
        value = var.nango_host
      }
      env {
        name  = "NANGO_PUBLIC_SERVER_URL"
        value = var.nango_host
      }
      env {
        name  = "ALLOW_DEMO_AUTH"
        value = "false"
      }
      env {
        name  = "ALLOW_SIMULATED_EXECUTION"
        value = "false"
      }

      dynamic "env" {
        for_each = local.secret_values
        content {
          name = upper(replace(env.key, "-", "_"))
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.application[env.key].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 5
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 24
        http_get {
          path = "/api/health"
          port = 8080
        }
      }

      liveness_probe {
        initial_delay_seconds = 30
        timeout_seconds       = 5
        period_seconds        = 30
        failure_threshold     = 3
        http_get {
          path = "/api/health"
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.cloud_sql_client,
    google_secret_manager_secret_iam_member.runtime,
    google_secret_manager_secret_version.application,
    google_sql_database.trevra,
    google_sql_user.trevra
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.trevra.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
