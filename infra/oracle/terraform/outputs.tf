output "public_ip" {
  description = "Public IP of the instance. Used for SSH only; no application port is open."
  value       = oci_core_instance.trevra.public_ip
}

output "ssh_command" {
  value = "ssh ubuntu@${oci_core_instance.trevra.public_ip}"
}

output "availability_domain" {
  description = "Retry with a different availability_domain_index if provisioning fails with 'Out of host capacity'."
  value       = oci_core_instance.trevra.availability_domain
}

output "data_volume_id" {
  value = oci_core_volume.data.id
}
