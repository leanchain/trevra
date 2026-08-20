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
    condition     = can(regex("^https://[^/]+/?$", var.app_origin))
    error_message = "app_origin must be an HTTPS origin without a path."
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

variable "legal_name" {
  description = "Public legal or operating name shown in policy pages."
  type        = string
  default     = "Trevra"
}

variable "support_email" {
  description = "Monitored public support email."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.support_email))
    error_message = "support_email must be a valid email address."
  }
}

variable "alert_email" {
  description = "Email for uptime and certificate alerts. Defaults to support_email when empty."
  type        = string
  default     = ""
  validation {
    condition     = var.alert_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be empty or a valid email address."
  }
}

variable "security_contact_email" {
  description = "Monitored vulnerability disclosure email."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.security_contact_email))
    error_message = "security_contact_email must be a valid email address."
  }
}

variable "google_site_verification" {
  description = "Optional Google Search Console HTML verification token."
  type        = string
  default     = ""
}

variable "bing_site_verification" {
  description = "Optional Bing Webmaster Tools meta verification token."
  type        = string
  default     = ""
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

variable "smtp_server" {
  description = "SMTP server used for hosted operational and transactional email."
  type        = string
}

variable "smtp_port" {
  description = "SMTP port; 465 uses implicit TLS, other ports use STARTTLS."
  type        = number
  default     = 587
}

variable "smtp_username" {
  description = "SMTP username."
  type        = string
  sensitive   = true
}

variable "smtp_password" {
  description = "SMTP password."
  type        = string
  sensitive   = true
}

variable "email_from" {
  description = "From address for Trevra transactional email."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.email_from))
    error_message = "email_from must be a valid email address."
  }
}

variable "email_from_name" {
  description = "Display name for Trevra transactional email."
  type        = string
  default     = "Trevra"
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

variable "orchestrator" {
  description = "Durable playbook orchestrator: postgres or temporal."
  type        = string
  default     = "postgres"
  validation {
    condition     = contains(["postgres", "temporal"], var.orchestrator)
    error_message = "orchestrator must be postgres or temporal."
  }
}

variable "temporal_address" {
  description = "Temporal frontend address for hosted orchestration."
  type        = string
  default     = ""
}

variable "temporal_namespace" {
  type    = string
  default = "default"
}

variable "temporal_task_queue" {
  type    = string
  default = "trevra-playbooks"
}

variable "temporal_tls" {
  type    = bool
  default = true
}

variable "temporal_api_key" {
  description = "Optional Temporal Cloud API key."
  type        = string
  sensitive   = true
  default     = ""
}

variable "sandbox_gateway_url" {
  description = "HTTPS endpoint of the isolated community-module execution service."
  type        = string
  default     = ""
  validation {
    condition     = var.sandbox_gateway_url == "" || startswith(var.sandbox_gateway_url, "https://")
    error_message = "sandbox_gateway_url must be empty or use HTTPS."
  }
}

variable "sandbox_gateway_token" {
  description = "Bearer token used only for the isolated sandbox gateway."
  type        = string
  sensitive   = true
  default     = ""
}

variable "remote_action_adapters_json" {
  description = "JSON array of approved proprietary action adapters. Adapter tokenEnv should be TREVRA_REMOTE_ACTION_ADAPTER_TOKEN."
  type        = string
  default     = "[]"
  validation {
    condition     = can(jsondecode(var.remote_action_adapters_json)) && can(tolist(jsondecode(var.remote_action_adapters_json)))
    error_message = "remote_action_adapters_json must be a JSON array."
  }
}

variable "remote_action_adapter_token" {
  description = "Shared bearer/HMAC secret for approved proprietary action adapters."
  type        = string
  sensitive   = true
  default     = ""
}


variable "registry_cors_origin" {
  description = "Marketing origin allowed to read the public hosted registry API."
  type        = string
  default     = ""
  validation {
    condition     = var.registry_cors_origin == "" || startswith(var.registry_cors_origin, "https://")
    error_message = "registry_cors_origin must be empty or use HTTPS."
  }
}

variable "worker_min_instances" {
  description = "Always-on worker instances. Temporal workers require at least one."
  type        = number
  default     = 1
}

variable "worker_max_instances" {
  description = "Maximum independent workflow worker instances."
  type        = number
  default     = 3
}
