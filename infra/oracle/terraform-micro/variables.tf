variable "tenancy_ocid" { type = string }
variable "compartment_ocid" { type = string }
variable "user_ocid" { type = string }
variable "api_key_fingerprint" { type = string }
variable "region" { type = string }

variable "private_key_path" {
  type    = string
  default = "~/.oci/oci_api_key.pem"
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of the SSH public key authorised on both instances."

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-) ", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key, not a path or a private key."
  }
}

variable "ssh_allowed_cidr" {
  type        = string
  description = "CIDR permitted to reach port 22 on either instance."
  default     = "0.0.0.0/0"
}

variable "name_prefix" {
  type    = string
  default = "trevra-micro"
}

variable "data_volume_size_in_gbs" {
  type        = number
  description = "Postgres data volume, attached to the db instance. Counts against the 200 GB Always Free block storage allowance alongside both 50 GB boot volumes."
  default     = 60
}

variable "availability_domain_index" {
  type        = number
  description = "E2.1.Micro can only be created in a single availability domain per tenancy; if capacity is short, try another index."
  default     = 0
}
