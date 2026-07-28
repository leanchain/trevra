# Trevra on Oracle Cloud Always Free.
#
# One VM.Standard.A1.Flex instance (ARM) runs the whole stack: Trevra API, the
# automation worker, Postgres, and optionally self-hosted Nango. Ingress is
# closed except SSH -- public traffic reaches the box through a Cloudflare
# tunnel, which establishes an outbound connection and needs no open ports.
#
# Always Free allowances this stays inside (home region only):
#   2 OCPU + 12 GB across all A1 instances, 200 GB block storage, 10 TB/mo egress.

data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  availability_domain = data.oci_identity_availability_domains.available.availability_domains[var.availability_domain_index].name
  image_id            = data.oci_core_images.ubuntu_arm.images[0].id
}

resource "oci_core_vcn" "trevra" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "${var.instance_name}-vcn"
  dns_label      = "trevra"
}

resource "oci_core_internet_gateway" "trevra" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.trevra.id
  display_name   = "${var.instance_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "trevra" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.trevra.id
  display_name   = "${var.instance_name}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.trevra.id
  }
}

# Egress is open so the box can pull images, reach Nango/OpenAI, and dial the
# Cloudflare tunnel. Ingress is SSH only; no HTTP port is ever exposed.
resource "oci_core_security_list" "trevra" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.trevra.id
  display_name   = "${var.instance_name}-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source      = var.ssh_allowed_cidr
    protocol    = "6"
    description = "SSH"

    tcp_options {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_subnet" "trevra" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.trevra.id
  cidr_block                 = "10.0.1.0/24"
  display_name               = "${var.instance_name}-subnet"
  dns_label                  = "app"
  route_table_id             = oci_core_route_table.trevra.id
  security_list_ids          = [oci_core_security_list.trevra.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "trevra" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = var.instance_name
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.trevra.id
    assign_public_ip = true
    hostname_label   = var.instance_name
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/../cloud-init.yaml"))
  }

  # The image is refreshed by Canonical regularly; a new one should not force
  # the instance (and its boot volume) to be recreated.
  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }
}

resource "oci_core_volume" "data" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.instance_name}-data"
  size_in_gbs         = var.data_volume_size_in_gbs
}

# Paravirtualized rather than iSCSI so the volume appears as a plain block
# device and cloud-init can mount it without running iscsiadm.
resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.trevra.id
  volume_id       = oci_core_volume.data.id
}
