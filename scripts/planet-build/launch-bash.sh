#!/usr/bin/env bash
# scripts/planet-build/launch-bash.sh
#
# Launches the planet build as a one-shot spot instance via `aws ec2
# run-instances`. No Terraform, no state — for a quarterly job, this is
# enough. Re-run produces an independent spot instance; no orphan resources
# to clean up because the instance terminates itself on completion (or
# interruption).
#
# Pre-flight (one-time setup):
#   1. AWS CLI installed and configured for eu-west-1
#   2. SSH key pair created in eu-west-1 — set KEY_NAME below
#   3. R2 credentials stored in SSM Parameter Store (NOT in this script):
#        aws ssm put-parameter --name /mapvibe/r2-access-key-id --type SecureString --value AKIA...
#        aws ssm put-parameter --name /mapvibe/r2-secret-access-key --type SecureString --value ...
#        aws ssm put-parameter --name /mapvibe/r2-bucket --type String --value mapvibe-pmtiles
#        aws ssm put-parameter --name /mapvibe/r2-account-id --type String --value <cf-account-id>
#   4. IAM instance profile that grants ssm:GetParameter for the four
#      parameters above (see iam-instance-profile.md sibling doc — TODO)

set -euo pipefail

REGION="${REGION:-eu-west-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-m6i.2xlarge}"
KEY_NAME="${KEY_NAME:?Set KEY_NAME to your EC2 SSH key pair name}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:?Set to a SG allowing SSH from your IP}"
INSTANCE_PROFILE="${INSTANCE_PROFILE:-mapvibe-planet-build}"
SUBNET_ID="${SUBNET_ID:-}"  # optional; lets EC2 pick if empty

# Latest Ubuntu 22.04 LTS for eu-west-1 (HVM, SSD, x86_64). Refresh quarterly
# from https://cloud-images.ubuntu.com/locator/ec2/ if this build branch
# ages.
AMI_ID="${AMI_ID:-ami-0fd8802f94ed1c969}"

# Sanity — surface what we're about to spend.
echo "Launching planet build:"
echo "  region        : ${REGION}"
echo "  instance type : ${INSTANCE_TYPE}"
echo "  AMI           : ${AMI_ID}"
echo "  key pair      : ${KEY_NAME}"
echo "  SG            : ${SECURITY_GROUP_ID}"
echo "  profile       : ${INSTANCE_PROFILE}"
echo ""

# User-data script runs as root on first boot. Installs Docker, pulls our
# build image, fetches R2 creds from SSM, runs the build, then terminates
# the instance. Output streams to /var/log/cloud-init-output.log on the
# instance (and the spot-instance system log via the EC2 console).
USER_DATA="$(cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/planet-build.log) 2>&1

apt-get update
apt-get install -y docker.io awscli
systemctl enable --now docker

# Format and mount the 500 GB EBS volume at /work
mkfs.ext4 -F /dev/nvme1n1 || true
mkdir -p /work
mount /dev/nvme1n1 /work

# Fetch R2 credentials from SSM Parameter Store (instance profile must allow this)
R2_ACCESS_KEY=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-access-key-id --with-decryption --query Parameter.Value --output text)
R2_SECRET=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-secret-access-key --with-decryption --query Parameter.Value --output text)
R2_BUCKET=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-bucket --query Parameter.Value --output text)
R2_ACCOUNT_ID=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-account-id --query Parameter.Value --output text)

# Clone the build branch and assemble the Docker image
cd /opt
git clone --branch feat/planet-build-tilemaker --depth 1 \
  https://github.com/insforca/mapvibe-render-service.git
cd mapvibe-render-service
docker build -f scripts/planet-build/Dockerfile -t mapvibe-planet-build:latest .

# Run the planet build. --rm so the container doesn't leak; -v mounts /work
# from the EBS volume into the container so Tilemaker's --store has the disk
# headroom it needs.
docker run --rm \
  -v /work:/work \
  -e AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY}" \
  -e AWS_SECRET_ACCESS_KEY="${R2_SECRET}" \
  -e R2_BUCKET="${R2_BUCKET}" \
  -e R2_ACCOUNT_ID="${R2_ACCOUNT_ID}" \
  mapvibe-planet-build:latest

# Self-terminate the spot instance once the upload completes.
shutdown -h now
EOF
)"

# Block device mapping: 100 GB root + 500 GB gp3 data volume at /dev/sdb
# (Nitro exposes this as /dev/nvme1n1 inside the OS). Auto-deletes when the
# spot instance terminates.
BLOCK_DEVICE_MAPPINGS='[
  {"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 100, "VolumeType": "gp3", "DeleteOnTermination": true}},
  {"DeviceName": "/dev/sdb",  "Ebs": {"VolumeSize": 500, "VolumeType": "gp3", "DeleteOnTermination": true}}
]'

# Persistent spot request so AWS replaces interrupted instances. For a
# 30-hour job a one-time request might get killed and lose work — the
# persistent flavor keeps trying. Sane max price = on-demand for the type.
SPOT_OPTIONS='{
  "MarketType": "spot",
  "SpotOptions": {
    "SpotInstanceType": "persistent",
    "InstanceInterruptionBehavior": "stop"
  }
}'

SUBNET_ARG=()
[[ -n "${SUBNET_ID}" ]] && SUBNET_ARG=(--subnet-id "${SUBNET_ID}")

INSTANCE_ID=$(aws ec2 run-instances \
  --region "${REGION}" \
  --image-id "${AMI_ID}" \
  --instance-type "${INSTANCE_TYPE}" \
  --key-name "${KEY_NAME}" \
  --security-group-ids "${SECURITY_GROUP_ID}" \
  --iam-instance-profile "Name=${INSTANCE_PROFILE}" \
  --block-device-mappings "${BLOCK_DEVICE_MAPPINGS}" \
  --instance-market-options "${SPOT_OPTIONS}" \
  --user-data "${USER_DATA}" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=mapvibe-planet-build},{Key=mapvibe:job,Value=planet-pmtiles}]' \
  "${SUBNET_ARG[@]}" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "✓ Launched ${INSTANCE_ID}"
echo ""
echo "Watch progress:"
echo "  aws ec2 describe-instances --region ${REGION} --instance-ids ${INSTANCE_ID} --query 'Reservations[0].Instances[0].State.Name'"
echo ""
echo "SSH (once it boots):"
echo "  PUBLIC_IP=\$(aws ec2 describe-instances --region ${REGION} --instance-ids ${INSTANCE_ID} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
echo "  ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@\$PUBLIC_IP"
echo "  tail -f /var/log/planet-build.log"
echo ""
echo "Instance self-terminates on completion. To cancel manually:"
echo "  aws ec2 terminate-instances --region ${REGION} --instance-ids ${INSTANCE_ID}"