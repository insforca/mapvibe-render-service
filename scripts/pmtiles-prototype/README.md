# PMTiles prototype — DC validation

A **gate** before committing to a planet PMTiles build. Builds a DC-only
tile archive with the same Tilemaker profile that would be used for the
planet, renders DC two ways (OSMnx baseline vs PMTiles prototype), writes
both side-by-side as a single PNG.

If LEFT and RIGHT match, the Tilemaker profile is correct and you can
commit to the planet build. If they diverge, the bug is cheap to fix here
(rebuild a 50 MB DC archive in minutes) instead of after a 24-hour planet
build.

## Why this exists

Production renders today go: studio → Vercel → Railway → OSMnx →
Overpass / regional PBF → matplotlib → PNG. The Overpass path is rate-
limited; the regional-PBF fallback is fragile (Bangalore / Lagos crashed
on 500 MB PBF loads in production 2026-06-21 logs).

A PMTiles archive on R2 replaces both data-source paths with HTTP range
reads against a single addressable archive. The matplotlib draw code
stays untouched — only the data-fetch layer changes.

The whole question is **does the PMTiles-sourced data render visually
identically to the OSMnx-sourced data**. This prototype answers exactly
that, for one city, before any production code changes.

## Prerequisites

- `tilemaker` — https://github.com/systemed/tilemaker
  - macOS: `brew install tilemaker`
  - Linux: build from source (a few minutes)
- `osmium-tool`
  - macOS: `brew install osmium-tool`
  - Linux: `apt install osmium-tool`
- The same Python venv that runs `python/mapvibe_render.py`, plus:
  ```
  pip install pmtiles mapbox-vector-tile
  ```

## Run

```bash
cd scripts/pmtiles-prototype/

# Step 1 — build the DC PMTiles archive (~5-15 minutes incl. download)
./build-dc.sh

# Step 2 — render comparison (~10-30 seconds)
python render-comparison.py

# Step 3 — open out/comparison.png and eyeball it
open out/comparison.png      # macOS
xdg-open out/comparison.png  # Linux
```

## What "matches" means

The comparison passes if, at DC at a 9 km radius / 12.5×16.7 in poster:

- All road tiers visible in both panels (motorway, primary, secondary,
  tertiary, residential)
- Potomac + Anacostia coastlines have the same shape
- DC Metro / Amtrak NE Corridor rail lines present in both
- National Mall + Rock Creek Park polygons match
- Residential street density is comparable (PMTiles may show very slightly
  fewer dead-end stubs — that's the simplification kicking in)

If anything looks off:

| Symptom | Likely fix |
|---|---|
| A road tier missing in PMTiles panel | `tilemaker-process.lua` — value not in `STREET_HIGHWAY_VALUES` |
| Coastline too polygonal | `tilemaker-config.json` — lower `simplify_level` for `water` |
| No rail | `tilemaker-process.lua` — `RAIL_RAILWAY_VALUES` or `relation_scan_function` |
| Whole layer empty | Check `tilemaker-config.json` `minzoom`/`maxzoom` covers z14 |
| Tiles cut off at the edges | bbox in `build-dc.sh` too tight — widen it and rebuild |

## Throwaway-ness

Everything here is throwaway. Do NOT import `render-comparison.py` from
production code; do NOT inline the MVT decode into `mapvibe_render.py`
yet. The point is to validate the profile; the production integration is
a separate step that happens only after the comparison is clean.

## Cost recap

- DC PMTiles archive: ~30-80 MB. R2 storage: ~$0.001/month.
- Planet PMTiles archive (eventual goal): ~80-130 GB. R2 storage:
  ~$2/month.
- R2 egress: $0 (this is R2's whole pitch vs S3).
- Class B reads (each render fetches ~10-50 tiles): negligible at
  current order volume.