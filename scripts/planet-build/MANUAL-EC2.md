# Manual EC2 console launch — planet PMTiles build

Step-by-step for launching the build via the AWS web console. No code, no
Terraform. Use this for the one-time first run; switch to `launch-bash.sh`
or the Terraform module for the next quarterly rebuild.

**Time**: ~10 min in the console, ~25-32 h instance runtime.
**Cost**: ~$3-5 (m6i.2xlarge spot in eu-west-1 × 30h).

## Before you start

1. **Quota approved.** Confirm your EC2 Spot vCPU quota in eu-west-1 is at
   least 8. Service Quotas → EC2 → "All Standard (A, C, D, H, I, M, R, T, Z)
   Spot Instance Requests" must show 8 or higher.
2. **SSH key pair** exists in eu-west-1. EC2 → Key Pairs → create one if
   not, download the `.pem` file. Note the name; you'll select it during
   launch.
3. **R2 credentials in SSM Parameter Store** (one-time, eu-west-1):
   ```
   aws ssm put-parameter --region eu-west-1 \
     --name /mapvibe/r2-access-key-id \
     --type SecureString --value <CF_R2_ACCESS_KEY_ID>

   aws ssm put-parameter --region eu-west-1 \
     --name /mapvibe/r2-secret-access-key \
     --type SecureString --value <CF_R2_SECRET_ACCESS_KEY>

   aws ssm put-parameter --region eu-west-1 \
     --name /mapvibe/r2-bucket \
     --type String --value <your-bucket-name>

   aws ssm put-parameter --region eu-west-1 \
     --name /mapvibe/r2-account-id \
     --type String --value <cloudflare-account-id>
   ```
   Get the R2 access keys from the Cloudflare dashboard: R2 → Manage R2 API
   Tokens → Create API Token with "Object Read & Write" scope on the
   destination bucket.
4. **IAM instance profile** named `mapvibe-planet-build`. IAM → Roles →
   Create role:
   - Trusted entity: EC2
   - Permissions: attach an inline policy with:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": "ssm:GetParameter",
           "Resource": [
             "arn:aws:ssm:eu-west-1:*:parameter/mapvibe/r2-*"
           ]
         },
         {
           "Effect": "Allow",
           "Action": "kms:Decrypt",
           "Resource": "*",
           "Condition": {
             "StringEquals": {
               "kms:ViaService": "ssm.eu-west-1.amazonaws.com"
             }
           }
         }
       ]
     }
     ```
   - Name: `mapvibe-planet-build`

## Launch

EC2 → Launch instances:

1. **Name**: `mapvibe-planet-build`
2. **AMI**: Ubuntu 22.04 LTS (HVM), 64-bit (x86)
3. **Instance type**: `m6i.2xlarge` (8 vCPU, 32 GB RAM)
   - If unavailable as spot in your AZ, try `m6a.2xlarge` (AMD) or `m6in.2xlarge`
4. **Key pair**: select the key created in pre-flight
5. **Network settings → Edit**:
   - VPC: default is fine
   - Security group: Create new
     - Inbound: SSH (port 22) from "My IP"
     - Outbound: leave default (all traffic)
6. **Configure storage → Add new volume**:
   - Root: 100 GB gp3
   - Add another EBS volume: 500 GB gp3, device `/dev/sdb`, delete on termination ✓
     (Nitro instances — m6i / m7i / c6i / c7i — surface this as `/dev/nvme1n1`
     inside the OS, which is what the user-data `mkfs`/`mount` lines assume.
     If you switch to a non-Nitro family later, run `lsblk` on first boot
     and adjust the device path before letting the build run.)
7. **Advanced details**:
   - **IAM instance profile**: `mapvibe-planet-build`
   - **Purchasing option**: Request Spot instances ✓
     - Maximum price: leave at on-demand (~$0.30/hr)
     - Persistent request ✓
     - Interruption behavior: Stop
   - **User data** (paste exactly):

```bash
#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/planet-build.log) 2>&1

apt-get update
apt-get install -y docker.io awscli git
systemctl enable --now docker

mkfs.ext4 -F /dev/nvme1n1 || true
mkdir -p /work
mount /dev/nvme1n1 /work

R2_ACCESS_KEY=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-access-key-id --with-decryption --query Parameter.Value --output text)
R2_SECRET=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-secret-access-key --with-decryption --query Parameter.Value --output text)
R2_BUCKET=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-bucket --query Parameter.Value --output text)
R2_ACCOUNT_ID=$(aws ssm get-parameter --region eu-west-1 \
  --name /mapvibe/r2-account-id --query Parameter.Value --output text)

cd /opt
git clone --branch feat/planet-build-tilemaker --depth 1 \
  https://github.com/insforca/mapvibe-render-service.git
# TODO(post-merge): change "feat/planet-build-tilemaker" → "main"
# (or a release tag) once the planet-build branch lands on main.
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
```

8. **Launch instance.**

## Monitor

Once running:

```
ssh -i ~/.ssh/your-key.pem ubuntu@<public-ip>
tail -f /var/log/planet-build.log
```

Expected phases in the log:
1. `[1/3] Downloading planet.osm.pbf from Geofabrik` → ~6-8 h
2. `[2/3] Running Tilemaker` → ~22-25 h
3. `[3/3] Uploading mapvibe-planet-YYYYMMDD.pmtiles to R2` → ~30 min

Total: ~28-33 h. Instance self-terminates on the final `shutdown -h now`.

## After completion

Confirm the archive landed in R2:

```
aws s3 ls s3://<your-bucket>/ \
  --endpoint-url https://<cf-account-id>.r2.cloudflarestorage.com
```

Should list `mapvibe-planet-YYYYMMDD.pmtiles` at ~80-130 GB.

## If something goes wrong

- **Spot interruption mid-build**: persistent spot request will restart the
  instance. EBS volume persists, so phase 1 (PBF download) and phase 2
  (Tilemaker output if completed) survive. Re-run resumes from where it
  stopped — `build-planet.sh` is idempotent on the file-existence checks.
- **OOM during Tilemaker**: shouldn't happen on m6i.2xlarge with `--store`,
  but if it does, upgrade to m6i.4xlarge (16 vCPU, 64 GB RAM, ~$0.30/hr
  spot) when your quota allows.
- **Stuck instance**: terminate manually from the console. EBS volumes
  auto-delete on terminate (we set `DeleteOnTermination=true`), no
  orphaned storage.