# scripts/planet-build/terraform/main.tf
#
# IaC alternative to launch-bash.sh. Same spot instance + same user-data
# script + same R2 credential flow. Use this if your team wants the launch
# version-controlled, drift-checkable, and integrated with whatever
# state-management you already run for AWS.
#
# Quick start:
#   cp terraform.tfvars.example terraform.tfvars  # edit values
#   terraform init
#   terraform apply
#
# The spot instance self-terminates on build completion (build-planet.sh
# calls `shutdown -h now`). Run `terraform destroy` afterwards to remove
# the security group, IAM resources, and the (already-terminated)
# instance state from the local tfstate.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ── Latest Ubuntu 22.04 AMI ───────────────────────────────────────────────────
# Resolves at apply time so we don't pin to a stale image. If you want a
# pinned AMI for reproducibility, replace this data block with a hardcoded id.
data "aws_ami" "ubuntu_22_04" {
  most_recent = true
  owners      = ["099720109477"]  # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── Security group ─────────────────────────────────────────────────────────────
# SSH inbound from the IP you set in var.ssh_cidr; egress unrestricted (the
# instance needs to reach Geofabrik + GitHub + R2).
resource "aws_security_group" "planet_build" {
  name        = "mapvibe-planet-build"
  description = "SSH access for the planet PMTiles build instance"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
    description = "SSH from operator IP"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    "mapvibe:job" = "planet-pmtiles"
  }
}

# ── IAM instance profile ───────────────────────────────────────────────────────
# Only permission needed: read the four R2 SSM parameters at startup. No S3
# access (R2 is reached via Cloudflare creds, not AWS IAM), no EC2 perms.

resource "aws_iam_role" "planet_build" {
  name = "mapvibe-planet-build"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ssm_read" {
  name = "ssm-read-r2-credentials"
  role = aws_iam_role.planet_build.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = [
        "arn:aws:ssm:${var.region}:*:parameter/mapvibe/r2-access-key-id",
        "arn:aws:ssm:${var.region}:*:parameter/mapvibe/r2-secret-access-key",
        "arn:aws:ssm:${var.region}:*:parameter/mapvibe/r2-bucket",
        "arn:aws:ssm:${var.region}:*:parameter/mapvibe/r2-account-id",
      ]
    },
    {
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = "*"
      Condition = {
        StringEquals = {
          "kms:ViaService" = "ssm.${var.region}.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_instance_profile" "planet_build" {
  name = "mapvibe-planet-build"
  role = aws_iam_role.planet_build.name
}

# ── Spot instance ──────────────────────────────────────────────────────────────
# user-data mirrors launch-bash.sh's flow: install Docker → fetch R2 creds
# from SSM → clone repo → docker build → docker run → self-terminate.

locals {
  user_data = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    exec > >(tee -a /var/log/planet-build.log) 2>&1

    apt-get update
    apt-get install -y docker.io awscli git
    systemctl enable --now docker

    mkfs.ext4 -F /dev/nvme1n1 || true
    mkdir -p /work
    mount /dev/nvme1n1 /work

    R2_ACCESS_KEY=$(aws ssm get-parameter --region ${var.region} \
      --name /mapvibe/r2-access-key-id --with-decryption --query Parameter.Value --output text)
    R2_SECRET=$(aws ssm get-parameter --region ${var.region} \
      --name /mapvibe/r2-secret-access-key --with-decryption --query Parameter.Value --output text)
    R2_BUCKET=$(aws ssm get-parameter --region ${var.region} \
      --name /mapvibe/r2-bucket --query Parameter.Value --output text)
    R2_ACCOUNT_ID=$(aws ssm get-parameter --region ${var.region} \
      --name /mapvibe/r2-account-id --query Parameter.Value --output text)

    cd /opt
    git clone --branch feat/planet-build-tilemaker --depth 1 \
      https://github.com/insforca/mapvibe-render-service.git
    cd mapvibe-render-service
    docker build -f scripts/planet-build/Dockerfile -t mapvibe-planet-build:latest .

    docker run --rm \
      -v /work:/work \
      -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY" \
      -e AWS_SECRET_ACCESS_KEY="$R2_SECRET" \
      -e R2_BUCKET="$R2_BUCKET" \
      -e R2_ACCOUNT_ID="$R2_ACCOUNT_ID" \
      mapvibe-planet-build:latest

    shutdown -h now
  EOT
}

resource "aws_instance" "planet_build" {
  ami                    = data.aws_ami.ubuntu_22_04.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [aws_security_group.planet_build.id]
  iam_instance_profile   = aws_iam_instance_profile.planet_build.name
  user_data_base64       = base64encode(local.user_data)

  instance_market_options {
    market_type = "spot"
    spot_options {
      spot_instance_type             = "persistent"
      instance_interruption_behavior = "stop"
    }
  }

  root_block_device {
    volume_size           = 100
    volume_type           = "gp3"
    delete_on_termination = true
  }

  ebs_block_device {
    device_name           = "/dev/sdb"
    volume_size           = 500
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name          = "mapvibe-planet-build"
    "mapvibe:job" = "planet-pmtiles"
  }

  # Don't replace the instance when AMI updates upstream — we want this to be
  # a one-shot deploy, not constantly drifting against Canonical's release
  # cadence.
  lifecycle {
    ignore_changes = [ami]
  }
}