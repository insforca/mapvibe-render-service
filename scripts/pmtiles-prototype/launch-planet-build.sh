#!/usr/bin/env bash
# =============================================================================
# launch-planet-build.sh
#
# One-shot Spot instance launch for the MapVibe planet PMTiles build.
# Kicks off an r6i.2xlarge Spot in us-east-1, bootstraps Docker + Tilemaker,
# downloads the planet PBF, runs the build, and uploads planet.pmtiles to S3.
#
# Usage:
#   ./launch-planet-build.sh [--dry-run] [--region <region>]
#
# Prerequisites:
#   • aws CLI v2 configured with a profile that has EC2 + S3 access
#   • An IAM instance profile with s3:PutObject on $S3_BUCKET
#   • A key pair already created in the target region
#   • A security group that allows outbound 443 (Docker pull, PBF download, S3)
#
# Build estimate (from spike validation):
#   ~24h wall-clock on r6i.2xlarge, ~$5 total at current us-east-1 Spot prices
#   Output: planet.pmtiles  ≈ 50–80 GB in S3
#
# RAM note:
#   r6i.2xlarge = 64 GB. Tilemaker planet builds need ≥ 60 GB for its in-memory
#   node store on the first pass. 64 GB is tight — if you see OOM kills, bump
#   to r6i.4xlarge (128 GB, ~$10 Spot total) and update INSTANCE_TYPE below.
# =============================================================================

set -euo pipefail

# ── Configuration — edit before first run ────────────────────────────────────

REGION="${REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-r6i.2xlarge}"
SPOT_MAX_PRICE="${SPOT_MAX_PRICE:-0.30}"          # on-demand ~$0.504; set headroom

KEY_NAME="${KEY_NAME:?Set KEY_NAME to your EC2 key pair name}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:?Set SECURITY_GROUP_ID}"
IAM_INSTANCE_PROFILE="${IAM_INSTANCE_PROFILE:?Set IAM_INSTANCE_PROFILE (name, not ARN)}"

S3_BUCKET="${S3_BUCKET:?Set S3_BUCKET}"
S3_PREFIX="${S3_PREFIX:-mapvibe/pmtiles}"

# Spike branch to pull Tilemaker config + Lua from
GH_REPO="insforca/mapvibe-render-service"
GH_BRANCH="spike/pmtiles-prototype-dc"

# Planet PBF source (OpenStreetMap official mirror, ~80 GB)
# Replace with a Geofabrik regional mirror or an S3-cached copy to save time.
PLANET_PBF_URL="${PLANET_PBF_URL:-https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf}"

# EBS volume — 500 GB gp3 covers PBF (80 GB) + working space + output
EBS_SIZE_GB=500
EBS_TYPE=gp3
EBS_IOPS=3000
EBS_THROUGHPUT=125    # MB/s

# Optional: SNS topic ARN for completion notification (leave empty to skip)
SNS_TOPIC_ARN="${SNS_TOPIC_ARN:-}"

# ── Argument parsing ──────────────────────────────────────────────────────────

DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --region)  REGION="$2"; shift ;;
  esac
done

# ── Resolve latest Amazon Linux 2023 AMI ─────────────────────────────────────

echo "Resolving latest Amazon Linux 2023 AMI in $REGION..."
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-2023.*-x86_64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)
echo "  AMI: $AMI_ID"

# ── UserData bootstrap ────────────────────────────────────────────────────────
# Injected as base64. Runs as root on first boot.
# Logs to /var/log/planet-build.log — tail it with:
#   ssh ec2-user@<ip> sudo tail -f /var/log/planet-build.log

USERDATA=$(base64 -w 0 << USERDATA_EOF
#!/bin/bash
set -euo pipefail
exec > /var/log/planet-build.log 2>&1

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] === MapVibe planet build starting ==="

# ── Docker ────────────────────────────────────────────────────────────────────
yum update -y
yum install -y docker git
systemctl enable --now docker

# ── Working directory ─────────────────────────────────────────────────────────
WORKDIR=/data
mkdir -p \$WORKDIR
cd \$WORKDIR

# ── Pull Tilemaker config + Lua from spike branch ─────────────────────────────
echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Fetching Tilemaker config from GitHub..."
curl -fsSL \
  "https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/scripts/pmtiles-prototype/tilemaker-config.json" \
  -o tilemaker-config.json
curl -fsSL \
  "https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/scripts/pmtiles-prototype/tilemaker-process.lua" \
  -o tilemaker-process.lua

# ── Download planet PBF ───────────────────────────────────────────────────────
echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Downloading planet PBF (~80 GB)..."
curl -fL --retry 5 --retry-delay 10 \
  "${PLANET_PBF_URL}" \
  -o planet.osm.pbf

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] PBF download complete (\$(du -sh planet.osm.pbf | cut -f1))"

# ── Run Tilemaker ─────────────────────────────────────────────────────────────
echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Tilemaker..."
docker run --rm \
  -v \$WORKDIR:/data \
  --memory=60g \
  ghcr.io/systemed/tilemaker:master \
  --input  /data/planet.osm.pbf \
  --output /data/planet.pmtiles \
  --config /data/tilemaker-config.json \
  --process /data/tilemaker-process.lua \
  --threads \$(nproc)

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Tilemaker complete (\$(du -sh planet.pmtiles | cut -f1))"

# ── Upload to S3 ──────────────────────────────────────────────────────────────
echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Uploading planet.pmtiles to S3..."
aws s3 cp \$WORKDIR/planet.pmtiles \
  "s3://${S3_BUCKET}/${S3_PREFIX}/planet.pmtiles" \
  --region "${REGION}" \
  --storage-class STANDARD_IA \
  --expected-size \$(stat -c%s \$WORKDIR/planet.pmtiles)

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Upload complete."

# ── Optional SNS notification ─────────────────────────────────────────────────
if [ -n "${SNS_TOPIC_ARN}" ]; then
  aws sns publish \
    --region "${REGION}" \
    --topic-arn "${SNS_TOPIC_ARN}" \
    --subject "MapVibe planet build complete" \
    --message "planet.pmtiles uploaded to s3://${S3_BUCKET}/${S3_PREFIX}/planet.pmtiles"
fi

# ── Self-terminate ────────────────────────────────────────────────────────────
echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Build done. Terminating instance."
TOKEN=\$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=\$(curl -s -H "X-aws-ec2-metadata-token: \$TOKEN" \
  "http://169.254.169.254/latest/meta-data/instance-id")
aws ec2 terminate-instances \
  --region "${REGION}" \
  --instance-ids "\$INSTANCE_ID"
USERDATA_EOF
)

# ── Build launch spec ─────────────────────────────────────────────────────────

LAUNCH_SPEC=$(cat << JSON
{
  "ImageId": "$AMI_ID",
  "InstanceType": "$INSTANCE_TYPE",
  "KeyName": "$KEY_NAME",
  "SecurityGroupIds": ["$SECURITY_GROUP_ID"],
  "IamInstanceProfile": { "Name": "$IAM_INSTANCE_PROFILE" },
  "UserData": "$USERDATA",
  "BlockDeviceMappings": [
    {
      "DeviceName": "/dev/xvda",
      "Ebs": {
        "VolumeSize": $EBS_SIZE_GB,
        "VolumeType": "$EBS_TYPE",
        "Iops": $EBS_IOPS,
        "Throughput": $EBS_THROUGHPUT,
        "DeleteOnTermination": true
      }
    }
  ],
  "TagSpecifications": [
    {
      "ResourceType": "instance",
      "Tags": [
        { "Key": "Name",    "Value": "mapvibe-planet-build" },
        { "Key": "Project", "Value": "mapvibe-studio" },
        { "Key": "Branch",  "Value": "$GH_BRANCH" }
      ]
    }
  ]
}
JSON
)

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Launch summary:"
echo "  Region       : $REGION"
echo "  Instance     : $INSTANCE_TYPE  (Spot max \$$SPOT_MAX_PRICE/hr)"
echo "  AMI          : $AMI_ID"
echo "  Key pair     : $KEY_NAME"
echo "  Sec group    : $SECURITY_GROUP_ID"
echo "  IAM profile  : $IAM_INSTANCE_PROFILE"
echo "  EBS          : ${EBS_SIZE_GB} GB $EBS_TYPE"
echo "  Output       : s3://$S3_BUCKET/$S3_PREFIX/planet.pmtiles"
echo "  Estimated    : ~24h / ~\$5 Spot"
echo ""

if $DRY_RUN; then
  echo "[DRY RUN] Would run: aws ec2 run-instances ..."
  echo "$LAUNCH_SPEC" | python3 -m json.tool
  exit 0
fi

# ── Fire ─────────────────────────────────────────────────────────────────────

echo "Requesting Spot instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --count 1 \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"MaxPrice":"'"$SPOT_MAX_PRICE"'","SpotInstanceType":"one-time"}}' \
  --cli-input-json "$LAUNCH_SPEC" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo ""
echo "✓ Spot instance launched: $INSTANCE_ID"
echo ""
echo "Monitor build log:"
echo "  # Wait ~2 min for boot, then:"
echo "  INSTANCE_IP=\$(aws ec2 describe-instances --region $REGION \\"
echo "    --instance-ids $INSTANCE_ID \\"
echo "    --query 'Reservations[0].Instances[0].PublicIpAddress' \\"
echo "    --output text)"
echo "  ssh ec2-user@\$INSTANCE_IP sudo tail -f /var/log/planet-build.log"
echo ""
echo "Check S3 on completion:"
echo "  aws s3 ls s3://$S3_BUCKET/$S3_PREFIX/"
