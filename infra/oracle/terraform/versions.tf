terraform {
  required_version = ">= 1.8.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

# Credentials are passed explicitly rather than read from ~/.oci/config so a
# run is reproducible from tfvars alone. The private key is referenced by path
# and never enters Terraform state.
provider "oci" {
  auth             = "ApiKey"
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.api_key_fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
