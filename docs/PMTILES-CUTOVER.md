# PMTiles production cut-over

How to flip the production render path from OSMnx/Overpass to range-request
reads against the planet PMTiles archive on R2.

**Status when this doc lands**: `USE_PMTILES=false` (OSMnx path live). The
cut-over is a Railway env-var change away.

## TL;DR

```
# Set on Railway (one-time):
USE_PMTILES=true
PMTILES_BUCKET=mapvibe-tiles
PMTILES_KEY=planet.pmtiles/planet.pmtiles
PMTILES_ENDPOINT_URL=https://95c914fe76e4b9b14314d3b60efe5ca7.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<from-cloudflare-r2-dashboard>
R2_SECRET_ACCESS_KEY=<from-cloudflare-r2-dashboard>

# Rollback (any time):
USE_PMTILES=false
```

Redeploy after either change; takes effect on the next render. No code
push required for either direction.

## What changes when the flag is true

| Phase | OSMnx path (default) | PMTiles path (USE_PMTILES=true) |
|---|---|---|
| Streets fetch | `ox.graph_from_point` → Overpass | R2 range request → MVT decode |
| Water / parks / rail | `ox.features_from_point` → Overpass | R2 range request → MVT decode |
| Cold-cache latency | 60-90 s (Overpass cold) | 1-3 s (R2 + decode) |
| Cache layer | Local on-disk pickle (TTL 7d, 512 MB LRU) | In-process LRU on decoded tiles |
| Fallback for missing region | 500 MB regional PBF download (fragile) | None needed — planet archive covers everything |
| Failure surface | Overpass outages, per-IP rate limits, PBF L4 crashes | R2 availability (Cloudflare's, not ours) |

Downstream theme / typography / save code is identical. The visual output
is what the spike validated against OSMnx for DC at z14 — four-panel
comparison passed; tile-grid overlay confirmed continuity.

## Pre-flight checklist

Before flipping `USE_PMTILES=true` on Railway:

1. **Archive exists in R2.** Confirm with:
   ```
   aws s3 ls s3://mapvibe-tiles/planet.pmtiles/ \
     --endpoint-url https://95c914fe76e4b9b14314d3b60efe5ca7.r2.cloudflarestorage.com
   ```
   Should list `planet.pmtiles` at ~136 GB.

2. **Cloudflare R2 access token created.** R2 dashboard → Manage R2 API
   Tokens → Create token with permissions:
   - **Object Read** scope on the `mapvibe-tiles` bucket
   - **No write permissions** — production only reads
   Output gives you the Access Key ID + Secret Access Key. Paste both into
   Railway env vars.

3. **Smoke render passes.** With all env vars set but `USE_PMTILES=false`
   (so the OSMnx path still serves), exec into a Railway shell and verify
   the credentials work:
   ```
   python -c "from pmtiles_reader import get_reader; r = get_reader(); print('OK')"
   ```
   Successful import means the env vars are right. Errors at this stage
   are credential / endpoint typos — fix before flipping the flag.

4. **Pre-customer state confirmed.** Per PRESETS-SPEC.md cut-over
   sequence, you chose Option A (immediate flip, no canary) because no
   customers depend on fulfillment yet. If that changes before flipping,
   switch to a sampled canary (10% → 100% over a week).

## Flip the flag

Railway dashboard → render-service → Variables → set `USE_PMTILES=true`
→ trigger redeploy. New container picks up the flag; existing renders in
flight complete on the OSMnx path; subsequent renders use PMTiles.

## Verify it's serving from PMTiles

Tail Railway logs for a render after deploy. Healthy PMTiles render log:

```
[mapvibe_render] Washington, United States @ 38.8856,-77.0295 dist=9900m ...
[mapvibe_render.pmtiles] PMTilesR2Reader initialised — bucket=mapvibe-tiles key=planet.pmtiles/planet.pmtiles
[mapvibe_render] Fetch phase 1.2s — PMTiles bbox=(-77.18, 38.78, -76.88, 38.99)
[mapvibe_render.pmtiles] PMTiles layer=streets z=14 bbox=(...) tiles=16/16 feats=4823 in 0.6s
[mapvibe_render.pmtiles] PMTiles layer=water z=14 bbox=(...) tiles=16/16 feats=12 in 0.2s
[mapvibe_render.pmtiles] PMTiles layer=parks z=14 bbox=(...) tiles=16/16 feats=89 in 0.2s
[mapvibe_render.pmtiles] PMTiles layer=rail z=14 bbox=(...) tiles=16/16 feats=47 in 0.2s
[mapvibe_render] Rendering figure...
[mapvibe_render] Done — 754,909 bytes (96 DPI, 12.5×16.666666666666668in)
[osm] render done in 3s
```

Key signals:
- `PMTilesR2Reader initialised` appears once per container boot (the
  module-level singleton).
- Per-render: `PMTiles layer=…` lines for each of streets/water/parks/rail.
- `tiles=16/16` — all requested tiles returned data. A line like
  `tiles=14/16` (some misses) is normal at archive edges or rare regions;
  `tiles=0/16` means a config / archive problem (wrong bbox math or
  missing planet coverage at that lat/lng).

## Rollback

Set `USE_PMTILES=false` → redeploy → done. Existing OSMnx pipeline is
intact, unchanged from pre-cutover. The Overpass mirror failover (patch
0029) + graph cache (0024) are still in place; cold renders pay the
60-90 s latency they did before. Acceptable for an emergency revert.

Do NOT delete the R2 archive or revoke the access token during a
rollback. The fastest re-flip-forward path is the same one-env-var
change in the other direction.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `PMTILES_BUCKET env var must be set` on render start | Env var missing | Set it on Railway |
| `botocore.exceptions.ClientError: ... AccessDenied` | Wrong access key, or token scope is write-only / wrong bucket | Regenerate R2 token with Object Read on `mapvibe-tiles` |
| `PMTiles get failed` warnings in log | Transient R2 read failure | Logged + swallowed; renders complete with whatever tiles loaded. If persistent (>5% of tiles), R2 outage — check Cloudflare status |
| `tiles=0/N` on every layer | Wrong endpoint URL or wrong key path | Check `PMTILES_ENDPOINT_URL` matches your CF account ID; `PMTILES_KEY` should be `planet.pmtiles/planet.pmtiles` (the nested key from the 2026-06-25 build's `aws s3 sync` upload) |
| Render times >5s consistently | Tile cache cold OR slow R2 region | Check `PMTilesR2Reader initialised` only fires once per container (if it fires every render, the singleton's broken); R2 latency from eu-west-1 to your Railway region should be <50 ms |
| Visual regression vs OSMnx render | Profile mismatch | Compare against the spike's `comparison.png` — top-row identity (Clean) and bottom-row identity (Detailed) were the validation gates. If they passed and production differs, the planet build profile drifted from the spike's |

## Next cleanups (post-cut-over)

After ~2 weeks of stable PMTiles operation with no rollback needed:

1. **Delete the OSMnx fetch path** from `mapvibe_render.py`. The `if
   use_pmtiles:` branch becomes unconditional; the OSMnx-specific
   `_fetch_streets/_fetch_water/_fetch_parks/_fetch_rail` functions and
   `ThreadPoolExecutor` go away.
2. **Remove the on-disk graph cache** (`_graph_cache_quantize`,
   `_graph_cache_get/set`, the 512 MB pickle store). PMTiles makes it
   redundant.
3. **Drop the Overpass mirror env var** (`OVERPASS_URLS`) and patch 0029
   failover code.
4. **Studio side**: complete the `minorRoads` → `preset` migration on
   `mapvibe-studio` (separate PR, after this lands).
5. **Remove the build script's `aws s3 sync` upload** in favour of a flat
   `aws s3 cp` so the next quarterly build uploads to
   `mapvibe-planet-YYYYMMDD.pmtiles` directly instead of the nested
   `planet.pmtiles/planet.pmtiles` path. PMTILES_KEY env var changes when
   you do this — coordinate the upload + env var swap in one Railway
   deploy.
