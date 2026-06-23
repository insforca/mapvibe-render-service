#!/usr/bin/env bash
# scripts/planet-build/build-planet.sh
#
# Runs inside the Docker container on the spot instance. Three phases:
#   1. Download latest planet.osm.pbf from Geofabrik (~80 GB)
#   2. Run Tilemaker with the spike-validated config (~25-32h on m6i.2xlarge)
#   3. Upload mapvibe-planet-{YYYYMMDD}.pmtiles to R2
#
# Idempotent on phase 1 and 3 — re-running won't re-download or re-upload a
# completed step. Phase 2 will redo the whole tile generation if interrupted;
# Tilemaker doesn't checkpoint mid-build.

set -euo pipefail

WORK=/work
PBF="${WORK}/planet.osm.pbf"
PMTILES="${WORK}/mapvibe-planet-$(date +%Y%m%d).pmtiles"
STORE_DIR="${WORK}/tilemaker-store"

# ── 1. Download planet PBF ────────────────────────────────────────────────────
# Geofabrik publishes the planet weekly. EU-hosted (Hetzner, Germany) so EU
# instances pull this faster than US ones. ~80 GB compressed, ~6-8h on a
# 1 Gbps link, less with parallel transfer if Geofabrik supports it.
if [[ ! -f "${PBF}" ]]; then
  echo "[1/3] Downloading planet.osm.pbf from Geofabrik..."
  curl --fail --location --retry 3 --retry-delay 30 --progress-bar \
    "https://planet.osm.org/pbf/planet-latest.osm.pbf" \
    -o "${PBF}.tmp"
  mv "${PBF}.tmp" "${PBF}"
  echo "    Done. Size: $(du -h "${PBF}" | cut -f1)"
else
  echo "[1/3] Planet PBF already present, skipping download."
fi

# ── 2. Tilemaker planet build ─────────────────────────────────────────────────
# --store mode spills intermediate data to disk instead of RAM. Critical on
# 8 vCPU / 16-32 GB RAM instances; without --store, Tilemaker OOMs on planet.
# Materialise at z0-z14 (poster crops never exceed z14 detail).
if [[ ! -f "${PMTILES}" ]]; then
  echo "[2/3] Running Tilemaker (this is the long step, expect 25-32h)..."
  mkdir -p "${STORE_DIR}"

  tilemaker \
    --input  "${PBF}" \
    --output "${PMTILES}.tmp" \
    --config  /opt/tilemaker-config.json \
    --process /opt/tilemaker-process.lua \
    --store  "${STORE_DIR}" \
    --threads "$(nproc)"

  mv "${PMTILES}.tmp" "${PMTILES}"

  # Tilemaker's --store can leave behind ~200-300 GB of intermediate data.
  # Free the disk so the upload step doesn't fight for space.
  rm -rf "${STORE_DIR}"

  echo "    Done. Archive size: $(du -h "${PMTILES}" | cut -f1)"
else
  echo "[2/3] PMTiles archive already present, skipping tile build."
fi

# ── 3. Upload to R2 ───────────────────────────────────────────────────────────
# R2 uses the S3 API. Credentials must be present as:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (from Cloudflare R2 dashboard)
#   R2_BUCKET                                  (your bucket name)
#   R2_ACCOUNT_ID                              (used to build the endpoint URL)
#
# launch-bash.sh / Terraform / MANUAL-EC2.md all wire these in via the
# instance's environment — never bake credentials into this script.
: "${R2_BUCKET:?R2_BUCKET must be set}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID must be set}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set (R2 access key)}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set (R2 secret)}"

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
KEY="$(basename "${PMTILES}")"

echo "[3/3] Uploading ${KEY} to R2 bucket ${R2_BUCKET}..."
aws s3 cp "${PMTILES}" "s3://${R2_BUCKET}/${KEY}" \
  --endpoint-url "${R2_ENDPOINT}" \
  --no-progress

echo ""
echo "✓ Planet build complete."
echo "  Archive: s3://${R2_BUCKET}/${KEY}"
echo "  Size:    $(du -h "${PMTILES}" | cut -f1)"
echo ""
echo "Next: update the render-service env var pointing at the new archive."
echo "  e.g. PMTILES_URL=${R2_ENDPOINT}/${R2_BUCKET}/${KEY}"