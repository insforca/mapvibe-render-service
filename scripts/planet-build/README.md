# Planet PMTiles build

Produces the planet-wide PMTiles archive that the production render-service
will read from R2. Same Tilemaker config + Lua process file as the
validated DC spike (`scripts/pmtiles-prototype/`); the only differences
are scale (planet vs DC bbox) and orchestration (spot instance vs local).

## Three launch paths

All three produce the **same artifact** — pick whichever fits your
operational style. Files in this directory:

| File | Use when |
|---|---|
| `launch-bash.sh` | Quarterly rebuild, you trust the script, no team coordination needed |
| `terraform/` | You want the launch version-controlled and drift-checkable |
| `MANUAL-EC2.md` | First run; want to see every checkbox in the console; no CLI/Terraform setup yet |

Internally they all do the same thing:

1. Spot instance (`m6i.2xlarge` in eu-west-1) with 100 GB root + 500 GB data EBS
2. User-data installs Docker, clones this repo at `feat/planet-build-tilemaker`,
   builds the Docker image from `scripts/planet-build/Dockerfile`
3. Container runs `build-planet.sh`: download planet PBF → Tilemaker →
   upload PMTiles to R2 with date-versioned filename
4. Instance self-terminates on completion

## Cost & time

| Item | Estimate |
|---|---|
| Instance (`m6i.2xlarge` spot, eu-west-1) | ~$0.10/h × ~30 h = **~$3** |
| EBS (600 GB gp3 for ~30 h) | ~$0.50 |
| Planet PBF download (Geofabrik) | $0 (egress to AWS is free for them) |
| R2 upload (~80-130 GB at $0 egress) | $0 |
| R2 storage (the archive itself, ongoing) | ~$2/month |
| **Total one-time** | **~$3.50** |
| **Total recurring** | **~$2/month** |

## What's in the archive

Built from `scripts/pmtiles-prototype/tilemaker-config.json` +
`tilemaker-process.lua` — validated against the OSMnx baseline for DC at
z14. Carries every OSM tag value that `python/mapvibe_render.py` reads:

- All `highway=` values from motorway down through steps (full Clean /
  Detailed tier hierarchy preserved)
- `natural=water/bay/strait` + `waterway=riverbank` for the water layer
- `leisure=park` + `landuse=grass` for parks
- `railway=rail/light_rail/subway/tram/monorail` for rail

z0-14. Higher zooms aren't needed for poster-scale rendering.

## After the build completes

The render-service production code (separate PR, after this branch
merges) will read from `s3://<r2-bucket>/<archive-name>.pmtiles`. Cutover
flow:

1. Confirm archive exists in R2 (see `MANUAL-EC2.md` § After completion)
2. Set env var on render-service: `PMTILES_URL=https://<account>.r2.cloudflarestorage.com/<bucket>/<archive>.pmtiles`
3. Deploy render-service code that reads from PMTiles (separate PR)
4. Eyeball a few production renders; if anything looks wrong, flip the
   env var back to the previous archive — instant rollback

## Rebuild cadence

Quarterly is fine for static maps. OSM updates daily, but city-scale
posters don't visibly change on day-to-day edits — a road that opened
last Tuesday won't be missed by a customer who orders next Friday.

For an off-cycle rebuild (e.g. a new region opens to customers and we
want fresh data), re-run any of the three launch paths. They produce a
new date-versioned archive next to the previous one; the env var swap
gives you cut-over and rollback in seconds.