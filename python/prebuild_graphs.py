#!/usr/bin/env python3
"""
prebuild_graphs.py — Pre-warm R2 L2 graph cache at deploy / service startup.
=============================================================================
For every PBF-covered city in top_cities.json whose L2 key is absent from R2,
this script downloads the regional PBF (if not already local), extracts the
OSMnx graph, and writes the pickle directly to the R2 L2 bucket — so the
first user /preview always finds the graph already cached (~2–3 s) instead
of paying the full cold-build cost (~20–30 s).

Groups cities by PBF region to avoid downloading the same .osm.pbf twice.
Sorts regions by size (smallest first) so DC / small metros are warm within
~30 s of boot while large regions (France, Germany …) continue in background.

Usage (called by server.ts at startup, or manually from CI/Railway one-offs):
    python python/prebuild_graphs.py [options]

    --workers N      Parallel city workers per PBF region (default: 2)
    --max-size-mb M  Skip regions larger than M MB (default: 200)
    --force          Rebuild even if R2 key already exists
    --dry-run        Print plan without building anything

Required env vars (inherited from the Railway service environment):
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    R2_BUCKET_NAME  (optional, default: mapvibe-graph-cache)

Exit codes: 0 = all done (or nothing to do), 1 = at least one city failed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ── Path setup ────────────────────────────────────────────────────────────────
# mapvibe_render.py lives in the same directory as this script.
_HERE = Path(__file__).parent.resolve()
sys.path.insert(0, str(_HERE))

import mapvibe_render as mv  # noqa: E402  (sets up R2 client + constants)

# ── Constants ─────────────────────────────────────────────────────────────────
PREVIEW_DIST_CAP = 20_000   # must match server.ts PREVIEW_DIST_CAP
_LOG_PREFIX = '[prebuild]'


def _log(msg: str) -> None:
    print(f'{_LOG_PREFIX} {msg}', flush=True)


# ── R2 existence check (head_object — avoids downloading the full pickle) ─────
def _r2_key_exists(cache_key: str) -> bool:
    try:
        obj_key = mv._r2_obj_key(cache_key)
        mv.client.head_object(Bucket=mv._R2_BUCKET_NAME, Key=obj_key)
        return True
    except Exception:
        return False


# ── Per-city build ────────────────────────────────────────────────────────────
def _build_city(city: dict, force: bool) -> tuple[str, str]:
    """
    Returns (status, label) where status ∈ {'ok', 'skip', 'fail'}.
    Writes the graph to R2 L2 on 'ok'.
    """
    name = f"{city['city']}, {city.get('country', '')}"
    try:
        lat  = float(city['lat'])
        lon  = float(city['lon'])
        # Always warm at PREVIEW_DIST_CAP so the L2 cache key matches what the
        # /preview route requests (server.ts caps previewDist to PREVIEW_DIST_CAP).
        # Using city['dist'] (e.g. 8 000 m for DC) produces a key that never
        # matches the 20 000 m preview request — every first preview is cold.
        dist = PREVIEW_DIST_CAP

        qlat, qlng, qdist = mv._graph_cache_quantize(lat, lon, dist)
        # mirror what the seed/warm endpoint does: minor_roads=False, network_type='drive'
        cache_key = mv._graph_cache_key('streets', qlat, qlng, qdist, 'major', 'drive')

        if not force and _r2_key_exists(cache_key):
            return 'skip', f'SKIP  {name} (R2 L2 hit)'

        # _try_pbf_extraction: downloads PBF if needed, builds graph, writes L1+L2.
        # Returns None when no PBF region matches (handled by caller — city shouldn't
        # appear in PBF list if _coord_to_pbf_region returned None).
        G = mv._try_pbf_extraction(qlat, qlng, qdist, minor_roads=False, cache_key=cache_key)
        if G is not None:
            return 'ok', f'OK    {name} ({len(G.nodes)} nodes, {len(G.edges)} edges)'

        return 'skip', f'SKIP  {name} (extraction returned None — region mismatch?)'

    except Exception as e:
        return 'fail', f'FAIL  {name}: {e}'


# ── pview warm phase ─────────────────────────────────────────────────────────
# 3.75×5 poster at 96 DPI — must match server.ts preview params.
_PVIEW_ASPECT    = 4.0 / 3.0
_PVIEW_WIDTH_IN  = 3.75
_PVIEW_HEIGHT_IN = 5.0
_PVIEW_DPI       = 96

import math as _math


def _build_preview(city: dict, force: bool) -> tuple[str, str]:
    """Warm the pview cache for this city via render(pview_only=True)."""
    name = f"{city['city']}, {city.get('country', '')}"
    try:
        lat = float(city['lat'])
        lon = float(city['lon'])
        # Reproduce server.ts crop_dist:
        user_osm_dist     = float(city.get('dist', 15_000))
        comp              = user_osm_dist * 4.0 / _PVIEW_ASPECT
        scale             = min(1.0, PREVIEW_DIST_CAP / comp) if comp > 0 else 1.0
        crop_override     = user_osm_dist / _math.sqrt(1 + _PVIEW_ASPECT ** 2)
        preview_crop_dist = round(crop_override * scale)
        # Check pview key
        qlat, qlng, qdist = mv._graph_cache_quantize(lat, lon, PREVIEW_DIST_CAP)
        round_cd  = round(preview_crop_dist / 500) * 500
        pview_key = mv._graph_cache_key('pview', qlat, qlng, qdist, round_cd, 'major', 'drive')
        if not force and _r2_key_exists(pview_key):
            return 'skip', f'SKIP  {name} (pview R2 hit)'
        mv.render({
            'lat': lat, 'lng': lon,
            'display_city': city['city'], 'display_country': city.get('country', ''),
            'dist': PREVIEW_DIST_CAP, 'crop_dist': preview_crop_dist,
            'width_in': _PVIEW_WIDTH_IN, 'height_in': _PVIEW_HEIGHT_IN, 'dpi': _PVIEW_DPI,
            'show_text': False, 'full_bleed': True, 'no_fade': True,
            'minor_roads': False, 'pview_only': True,
        })
        return 'ok', f'OK    {name} (pview warmed)'
    except Exception as e:
        return 'fail', f'FAIL  {name} preview: {e}'


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(
        description='Pre-warm R2 L2 graph cache for PBF-covered cities.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument('--workers',      type=int,  default=2,
                    help='parallel city workers')
    ap.add_argument('--max-size-mb',  type=int,  default=200,
                    help='skip PBF regions larger than this (MB)')
    ap.add_argument('--force',        action='store_true',
                    help='rebuild even when R2 key already exists')
    ap.add_argument('--dry-run',      action='store_true',
                    help='show plan without building')
    args = ap.parse_args()

    cities_path = _HERE / 'top_cities.json'
    try:
        all_cities: list[dict] = json.loads(cities_path.read_text())
    except Exception as e:
        _log(f'Cannot load top_cities.json: {e}')
        sys.exit(1)

    # ── Group cities by PBF region, filter by size ────────────────────────────
    region_groups: dict[str, list[dict]] = defaultdict(list)
    region_meta: dict[str, dict] = {}

    for city in all_cities:
        # Skip cities explicitly flagged as Overpass-only (e.g. Buenos Aires,
        # La Plata: Argentina PBF is 420 MB and has no Geofabrik sub-regions,
        # so no prebuilt graph is possible — fall through to Overpass at runtime).
        if city.get('overpass_only'):
            continue
        region = mv._coord_to_pbf_region(city['lat'], city['lon'])
        if region is None:
            continue
        size_mb = region.get('size_mb', 9999)
        if size_mb > args.max_size_mb:
            continue
        rk = region['region_key']
        region_groups[rk].append(city)
        region_meta[rk] = region

    total_cities = sum(len(v) for v in region_groups.values())
    _log(
        f'Plan: {total_cities} cities across {len(region_groups)} PBF regions '
        f'(≤ {args.max_size_mb} MB each), {args.workers} workers'
    )

    if args.dry_run:
        for rk, meta in sorted(region_meta.items(), key=lambda kv: kv[1].get('size_mb', 0)):
            _log(f'  {rk} ({meta.get("size_mb", "?")} MB) — {len(region_groups[rk])} cities')
            for c in region_groups[rk]:
                _log(f'      {c["city"]}, {c.get("country", "")}')
        return

    # ── Process regions smallest-first so tiny regions (DC=7MB) are done fast ─
    ordered_regions = sorted(
        region_groups.keys(),
        key=lambda rk: region_meta[rk].get('size_mb', 9999),
    )

    t0 = time.monotonic()
    counts = {'ok': 0, 'skip': 0, 'fail': 0}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        # Submit all cities; ThreadPoolExecutor handles parallelism.
        # _try_pbf_extraction uses its own per-region threading.Lock so concurrent
        # calls for the same PBF region serialise on the download and then each
        # extract their own bbox — safe to submit all at once.
        futures = {
            pool.submit(_build_city, city, args.force): city
            for rk in ordered_regions
            for city in region_groups[rk]
        }
        for fut in as_completed(futures):
            status, label = fut.result()
            counts[status] += 1
            _log(label)

    # ── Phase 2: warm pview cache ────────────────────────────────────────
    _log(f'Phase 2: warming pview for {total_cities} cities ({args.workers} workers) ...')
    with ThreadPoolExecutor(max_workers=args.workers) as pool2:
        p2_futs = {
            pool2.submit(_build_preview, city, args.force): city
            for rk in ordered_regions for city in region_groups[rk]
        }
        for fut in as_completed(p2_futs):
            status, label = fut.result()
            counts[status] += 1
            _log(label)

    elapsed = time.monotonic() - t0
    _log(
        f'Done in {elapsed:.0f}s — '
        f'{counts["ok"]} built, {counts["skip"]} skipped, {counts["fail"]} failed'
    )
    sys.exit(1 if counts['fail'] > 0 else 0)


if __name__ == '__main__':
    main()
