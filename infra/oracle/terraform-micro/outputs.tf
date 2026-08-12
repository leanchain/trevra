output "app_public_ip" {
  description = "Runs the API, the automation worker, and the Cloudflare tunnel."
  value       = oci_core_instance.app.public_ip
}

output "db_public_ip" {
  description = "Runs Postgres only. Reachable on 5432 from inside the VCN, never from the internet."
  value       = oci_core_instance.db.public_ip
}

output "db_private_ip" {
  description = "Value for DATABASE_URL on the app instance."
  value       = oci_core_instance.db.private_ip
}

output "deploy_command" {
  value = "./deploy-micro.sh ${oci_core_instance.app.public_ip} ${oci_core_instance.db.public_ip} ${oci_core_instance.db.private_ip}"
}
