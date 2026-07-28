variable "tenancy_ocid" {
  type        = string
  description = "OCID of the tenancy. Always Free resources must live in the tenancy home region."
}

variable "compartment_ocid" {
  type        = string
  description = "OCID of the compartment that owns the instance. Use the tenancy OCID for the root compartment."
}

variable "region" {
  type        = string
  description = "Tenancy home region. Always Free resources created outside the home region are billed."
}

variable "user_ocid" {
  type        = string
  description = "OCID of the user the API key belongs to."
}

variable "api_key_fingerprint" {
  type        = string
  description = "Fingerprint of the uploaded API public key, as shown in the console."
}

variable "private_key_path" {
  type        = string
  description = "Path to the API private key .pem. Read at plan time; never stored in state."
  default     = "~/.oci/oci_api_key.pem"
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of the SSH public key authorised for the ubuntu user."

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-) ", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key, not a file path or a private key."
  }
}

variable "ssh_allowed_cidr" {
  type        = string
  description = "CIDR permitted to reach port 22. Nothing else is opened: app traffic arrives over the Cloudflare tunnel, which dials outbound."
  default     = "0.0.0.0/0"
}

variable "instance_name" {
  type    = string
  default = "trevra"
}

variable "ocpus" {
  type        = number
  description = "Always Free ceiling is 2 OCPUs across all A1 instances in the tenancy."
  default     = 2

  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 4
    error_message = "ocpus must be 1-4; anything above the Always Free allowance of 2 is billed."
  }
}

variable "memory_in_gbs" {
  type        = number
  description = "Always Free ceiling is 12 GB across all A1 instances in the tenancy."
  default     = 12

  validation {
    condition     = var.memory_in_gbs >= 6 && var.memory_in_gbs <= 24
    error_message = "memory_in_gbs must be 6-24; anything above the Always Free allowance of 12 is billed."
  }
}

variable "boot_volume_size_in_gbs" {
  type        = number
  description = "Counts against the 200 GB Always Free block storage allowance, together with data_volume_size_in_gbs."
  default     = 50
}

variable "data_volume_size_in_gbs" {
  type        = number
  description = "Separate volume for Postgres data, mounted at /mnt/data so a rebuilt instance does not destroy the database."
  default     = 100
}

variable "availability_domain_index" {
  type        = number
  description = "Which availability domain to launch in. A1 capacity is frequently exhausted; retry with a different index on 'Out of host capacity'."
  default     = 0
}
