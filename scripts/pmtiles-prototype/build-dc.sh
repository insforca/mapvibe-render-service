#!/usr/bin/env bash
# scripts/pmtiles-prototype/build-dc.sh
#
# One-shot DC-only PMTiles build. Validates the Tilemaker config + Lua
# process file produce a visually-correct render BEFORE committing to a
# planet build (~$5 of spot compute + 12-24 h wall clock).
#
# Output: scripts/pmtiles-prototype/out/dc.pmtiles  (~30-80 MB expected)
#
# Required: tilemaker, osmium-tool, curl  on PATH.
#   macOS: brew install tilemaker osmium-tool
#   Debian/Ubuntu: apt install osmium-tool && build tilemaker from source
#                  (https://github.com/systemed/tilemaker)
#
# Storage cost sanity check: ~50 MB DC archive × $0.015/GB/month = $0.00075
# /month. The whole planet at the same profile is ~80-130 GB = ~$2/month.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/out"
PBF="${OUT}/dc.osm.pbf"
PMTILES="${OUT}/dc.pmtiles"
EXTRACT_SOURCE="${OUT}/us-northeast.osm.pbf"

mkdir -p "${OUT}"

# ── 1. Source PBF ─────────────────────────────────────────────────────────────
# Geofabrik publishes regional extracts daily. us-northeast.osm.pbf is ~700 MB
# and contains DC + a comfortable surrounding bbox. We bbox-trim it down to
# the DC metro before Tilemaker — saves 5-10x build time and tile count.
if [[ ! -f "${EXTRACT_SOURCE}" ]]; then
  echo "[1/4] Downloading us-northeast.osm.pbf from Geofabrik (~700 MB)..."
  curl --fail --location --progress-bar \
    "https://download.geofabrik.de/north-america/us-northeast-latest.osm.pbf" \
    -o "${EXTRACT_SOURCE}"
else
  echo "[1/4] Source extract already present, skipping download."
fi

# ── 2. Bbox crop ──────────────────────────────────────────────────────────────
# Generous DC metro bbox — Capitol at 38.89,-77.03, plus ~30 km in every
# direction so wide-zoom posters (15 km cap on osmDist) are fully covered.
#   SW = 38.73, -77.21
#   NE = 39.05, -76.85
if [[ ! -f "${PBF}" ]]; then
  echo "[2/4] Cropping to DC metro bbox..."
  osmium extract \
    --bbox -77.21,38.73,-76.85,39.05 \
    --strategy complete_ways \
    --output "${PBF}" \
    "${EXTRACT_SOURCE}"
else
  echo "[2/4] DC PBF already present, skipping crop."
fi

# ── 3. Tilemaker build ────────────────────────────────────────────────────────
echo "[3/4] Building PMTiles archive..."
tilemaker \
  --input  "${PBF}" \
  --output "${PMTILES}" \
  --config  "${HERE}/tilemaker-config.json" \
  --process "${HERE}/tilemaker-process.lua"

# ── 4. Sanity print ───────────────────────────────────────────────────────────
SIZE_MB=$(du -m "${PMTILES}" | cut -f1)
echo "[4/4] Done."
echo "  PMTiles : ${PMTILES}"
echo "  Size    : ${SIZE_MB} MB"
echo ""
echo "Next: python scripts/pmtiles-prototype/render-comparison.py"
echo "      to render DC both ways (OSMnx vs PMTiles) for visual diff."