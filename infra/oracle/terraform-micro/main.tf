# Trevra across two Always Free AMD micro instances.
#
# Fallback for when VM.Standard.A1.Flex capacity is unavailable. E2.1.Micro is
# always-free-eligible and usually obtainable, but gives only 1 GB of RAM each,
# so the stack is split rather than stacked:
#
#   db  -- Postgres only, with the data volume attached
#   app -- API + automation worker + cloudflared
#
# The split is deliberate: the research skills parse multi-megabyte HTML pages
# and are the most likely thing to exhaust memory. Keeping them off the
# database host means an OOM kill takes out a replaceable app container rather
# than Postgres.
#
# Neither instance builds anything -- images come prebuilt from ghcr.io, which
# is what makes 1 GB viable at all.

data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu_x86" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.E2.1.Micro"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  availability_domain = data.oci_identity_availability_domains.available.availability_domains[var.availability_domain_index].name
  image_id            = data.oci_core_images.ubuntu_x86.images[0].id
  vcn_cidr            = "10.1.0.0/16"
}

resource "oci_core_vcn" "micro" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [local.vcn_cidr]
  display_name   = "${var.name_prefix}-vcn"
  dns_label      = "micro"
}

resource "oci_core_internet_gateway" "micro" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.micro.id
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
}

resource "oci_core_route_table" "micro" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.micro.id
  display_name   = "${var.name_prefix}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.micro.id
  }
}

resource "oci_core_security_list" "micro" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.micro.id
  display_name   = "${var.name_prefix}-sl"

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

  # Postgres is reachable only from inside the VCN -- that is how the app
  # instance reaches the db instance. It is never exposed to the internet.
  ingress_security_rules {
    source      = local.vcn_cidr
    protocol    = "6"
    description = "Postgres, VCN-internal only"

    tcp_options {
      min = 5432
      max = 5432
    }
  }
}

resource "oci_core_subnet" "micro" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.micro.id
  cidr_block                 = "10.1.1.0/24"
  display_name               = "${var.name_prefix}-subnet"
  dns_label                  = "micro"
  route_table_id             = oci_core_route_table.micro.id
  security_list_ids          = [oci_core_security_list.micro.id]
  prohibit_public_ip_on_vnic = false
}

# E2.1.Micro is a fixed shape: no shape_config, 1/8 OCPU burstable, 1 GB RAM.
resource "oci_core_instance" "db" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.name_prefix}-db"
  shape               = "VM.Standard.E2.1.Micro"

  source_details {
    source_type = "image"
    source_id   = local.image_id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.micro.id
    assign_public_ip = true
    hostname_label   = "db"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/../cloud-init-micro-db.yaml"))
  }

  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }
}

resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.name_prefix}-app"
  shape               = "VM.Standard.E2.1.Micro"

  source_details {
    source_type = "image"
    source_id   = local.image_id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.micro.id
    assign_public_ip = true
    hostname_label   = "app"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/../cloud-init-micro-app.yaml"))
  }

  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }
}

resource "oci_core_volume" "data" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.name_prefix}-data"
  size_in_gbs         = var.data_volume_size_in_gbs
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.db.id
  volume_id       = oci_core_volume.data.id
}
