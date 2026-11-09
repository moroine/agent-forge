# Canonical's documented SSM layout for Ubuntu 26.04. Not verifiable without
# AWS credentials: if Canonical publishes the parameter elsewhere, the create
# command fails clearly on this lookup.
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

# A network of its own: one public subnet, no NAT gateway, no IPv6.
# Never around forge's bridge (10.77.0.1/24 by default, cli/lib/config.ts):
# AWS puts the VPC's resolver at its base + 2 and DHCP routes the VM to it,
# so a 10.77.0.0/16 VPC would send forge-proxy's traffic (10.77.0.2) away
# from the bridge.
resource "aws_vpc" "dev" {
  cidr_block           = "10.100.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_subnet" "dev" {
  vpc_id     = aws_vpc.dev.id
  cidr_block = "10.100.1.0/24"
}

resource "aws_internet_gateway" "dev" {
  vpc_id = aws_vpc.dev.id
}

resource "aws_route_table" "dev" {
  vpc_id = aws_vpc.dev.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.dev.id
  }
}

resource "aws_route_table_association" "dev" {
  subnet_id      = aws_subnet.dev.id
  route_table_id = aws_route_table.dev.id
}

# Rules are inline blocks on purpose: a CIDR change stays an in-place update
# of the group, not a destroy and create of separate rule resources.
resource "aws_security_group" "dev" {
  name_prefix = "${var.name}-"
  description = "Dev VM: SSH from the maintainer only"
  vpc_id      = aws_vpc.dev.id

  # The maintainer's laptop reaches the VM over SSH, from one address only.
  ingress {
    description = "SSH from the maintainer"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }

  # The VM downloads packages, images and git data from the internet; nothing
  # narrower is practical (the agent's own egress is limited by Incus ACLs).
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "dev" {
  ami                    = data.aws_ssm_parameter.ami.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.dev.id
  vpc_security_group_ids = [aws_security_group.dev.id]

  # Incus virtual machines and KVM need nested virtualization.
  cpu_options {
    nested_virtualization = "enabled"
  }

  # IMDSv2 only, one hop: a container cannot reach the metadata service.
  # No instance profile: no AWS credential on the VM.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.disk_gb
    encrypted   = true
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_public_key = var.admin_public_key
  })

  lifecycle {
    # A newer AMI or a changed template must never replace the VM; a
    # -replace still picks both up.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "dev" {
  domain   = "vpc"
  instance = aws_instance.dev.id

  # AWS documents that an EIP may need the internet gateway to exist first:
  # without this, the first apply can race it.
  depends_on = [aws_internet_gateway.dev]
}

# Start and stop without touching the rest of the stack.
resource "aws_ec2_instance_state" "dev" {
  instance_id = aws_instance.dev.id
  state       = var.running ? "running" : "stopped"
}
