variable "region" {
  description = "AWS region to launch the spot instance in. eu-west-1 is faster to Geofabrik than us-east-1."
  type        = string
  default     = "eu-west-1"
}

variable "instance_type" {
  description = "EC2 instance type. m6i.2xlarge gives 8 vCPU / 32 GB RAM — RAM headroom matters more than CPU for Tilemaker --store on planet."
  type        = string
  default     = "m6i.2xlarge"
}

variable "key_name" {
  description = "Name of an existing EC2 key pair in the target region. SSH access only — no operational dependency."
  type        = string
}

variable "ssh_cidr" {
  description = "CIDR block allowed SSH access to the build instance. Set to your operator IP, e.g. \"203.0.113.5/32\"."
  type        = string
}

variable "build_branch" {
  description = "Git branch the spot instance clones to assemble the build image. Defaults to the unmerged feat branch so launches from this branch's checkout work without overrides. TODO(post-merge): change default to \"main\" once feat/planet-build-tilemaker lands."
  type        = string
  default     = "feat/planet-build-tilemaker"
}