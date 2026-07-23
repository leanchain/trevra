variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region shared by Cloud Run, Cloud SQL, and Artifact Registry."
  type        = string
  default     = "europe-west6"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "trevra"
}

variable "artifact_repository" {
  description = "Artifact Registry repository ID."
  type        = string
  default     = "trevra"
}

variable "image" {
  description = "Fully qualified Trevra container image."
  type        = string
}

variable "app_origin" {
  description = "Public HTTPS origin, preferably the production custom domain."
  type        = string

  validation {
    condition     = startswith(var.app_origin, "https://")
    error_message = "app_origin must use HTTPS."
  }
}

variable "better_auth_url" {
  description = "Public Better Auth base URL. Usually identical to app_origin."
  type        = string

  validation {
    condition     = startswith(var.better_auth_url, "https://")
    error_message = "better_auth_url must use HTTPS."
  }
}

variable "google_client_id" {
  description = "Google OAuth web application client ID."
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth web application client secret."
  type        = string
  sensitive   = true
}

variable "nango_host" {
  description = "Public HTTPS URL of the separately deployed self-hosted Nango API."
  type        = string

  validation {
    condition     = startswith(var.nango_host, "https://")
    error_message = "nango_host must use HTTPS."
  }
}

variable "nango_api_key" {
  description = "Nango environment secret key."
  type        = string
  sensitive   = true
}

variable "nango_webhook_signing_key" {
  description = "Nango webhook signing key."
  type        = string
  sensitive   = true
}

variable "database_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "database_disk_size_gb" {
  description = "Initial Cloud SQL SSD size."
  type        = number
  default     = 20
}

variable "database_name" {
  type    = string
  default = "trevra"
}

variable "database_user" {
  type    = string
  default = "trevra"
}

variable "min_instances" {
  type    = number
  default = 1
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "database_pool_max" {
  description = "Maximum Trevra database connections per Cloud Run instance. Keep max_instances * this value below Cloud SQL limits."
  type        = number
  default     = 10
}

variable "allow_unauthenticated" {
  description = "Allow public HTTP access to the app; application routes still enforce sessions."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protect Cloud Run and Cloud SQL from accidental Terraform deletion."
  type        = bool
  default     = true
}
