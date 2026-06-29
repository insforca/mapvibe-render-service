#!/usr/bin/env python3
"""
mapvibe_render.py â MapVibe OSM render adapter
===============================================
Reads JSON params from stdin, renders a city map poster using
OSMnx + matplotlib, writes PNG bytes to stdout (or a file).

MapVibe customisations vs upstream maptoposter:
  â¢ full_bleed  â no padding, axes fill the entire figure (default True)
  â¢ no_fade     â skip top/bottom gradient vignettes (default True)
  â¢ minor_roads â render residential/service/footway roads (default False)
  â¢ dpi         â 400 for all standard sizes; caller sets 300+ for archival
  â¢ network     â 'drive' by default (faster, cleaner than 'all')

Params (JSON via stdin):
  city            str    city name (geocoding fallback)
  country         str    country name (geocoding fallback)
  lat             float  center latitude (skips geocoding when provided)
  lng             float  center longitude (skips geocoding when provided)
  display_city    str    city label on poster
  display_country str    country label on poster
  theme_name      str    maptoposter theme name (default: midnight_blue)
  theme_json      dict   inline theme override (takes priority over theme_name)
  dist            int    map radius in metres (default: 15000)
  width_in        float  poster width in inches  (default: 12.0)
  height_in       float  poster height in inches (default: 16.0)
  dpi             int    output DPI (default: 400)
  show_text       bool   render city/country/coords text (default: True)
  full_bleed      bool   fill canvas edge-to-edge (default: True)
  no_fade         bool   skip gradient fades (default: True)
  minor_roads     bool   include minor roads (default: False)
  output_path     str    write PNG to file instead of stdout
"""

import sys
import json
import os
import io
import pickle
import time
import hashlib
import math
import math
import threading
import tempfile
import struct

# ââ Headless matplotlib â MUST be set before any pyplot import âââââââââââââ
import matplotlib
matplotlib.use('Agg')
import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
import numpy as np
import osmnx as ox
import geopandas as gpd
import shapely.geometry as sgeom

# ââ Overpass mirror failover ââââââââââââââââââââââââââââââââââââââââââââââââââ
# OSMnx defaults to overpass-api.de which has been observed refusing
# connections (Errno 111) under sustained load â production 2026-06-17 logs:
# every render burning 60 s + then dying because the primary mirror was
# unreachable. Probe alternates at process start and pick the first one whose
# TCP socket accepts a handshake; this Python subprocess is spawned per render
# so the probe runs once per request (worst case +2 s on a cold render when
# the primary is down). Override the candidate list via the OVERPASS_URLS env
# var (comma-separated) when adding/reordering mirrors.

# Module-level candidate list so the per-request failover can rotate through it.
_OVERPASS_CANDIDATES: list[str] = [
    s.strip()
    for s in os.environ.get(
        'OVERPASS_URLS',
        'https://overpass-api.de/api/interpreter,'
        'https://overpass.kumi.systems/api/interpreter,'
        'https://overpass.osm.ch/api/interpreter'
    ).split(',')
    if s.strip()
]
_overpass_idx = 0  # index into _OVERPASS_CANDIDATES; mutated by failover helper


def _select_overpass_mirror() -> str:
    import socket
    from urllib.parse import urlparse

    for url in _OVERPASS_CANDIDATES:
        host = urlparse(url).hostname
        port = urlparse(url).port or 443
        if not host:
            continue
        try:
            with socket.create_connection((host, port), timeout=2):
                return url
        except Exception:
            continue
    # All mirrors unreachable â fall through to the first and let the actual
    # fetch raise a meaningful error instead of swallowing it here.
    return _OVERPASS_CANDIDATES[0] if _OVERPASS_CANDIDATES else 'https://overpass-api.de/api/interpreter'


_OVERPASS_URL = _select_overpass_mirror()
# Align _overpass_idx with whatever the probe chose.
if _OVERPASS_URL in _OVERPASS_CANDIDATES:
    _overpass_idx = _OVERPASS_CANDIDATES.index(_OVERPASS_URL)
ox.settings.overpass_url = _OVERPASS_URL
print(f'[mapvibe_render] Overpass mirror: {_OVERPASS_URL}', file=sys.stderr, flush=True)


def _ox_call_with_mirror_failover(fn, *args, **kwargs):
    """Call fn(*args, **kwargs) (an osmnx Overpass-backed call).

    On ConnectionError / MaxRetryError / timeout, rotate to the next mirror
    from _OVERPASS_CANDIDATES and retry â up to len(_OVERPASS_CANDIDATES)
    attempts total.  This protects against a mirror that passed the startup
    TCP probe but then starts refusing connections under load mid-seeder-run.

    Back-off: 0 s on first failure, 2 s on second, 4 s on third.

    Fast-fail on InsufficientResponseError: this exception means Overpass
    returned no features matching the query â a data gap in OSM, not a
    mirror failure.  All mirrors query the same OSM dataset, so retrying
    other mirrors would return the same empty response.  Re-raise immediately
    without rotating to avoid burning 30 s Ã N per data-gap city.
    """
    global _overpass_idx
    import requests as _req_mod
    backoffs = [0, 2, 4]
    last_exc: Exception | None = None
    for attempt in range(len(_OVERPASS_CANDIDATES)):
        try:
            return fn(*args, **kwargs)
        except (_req_mod.exceptions.ConnectionError,
                _req_mod.exceptions.Timeout,
                OSError) as exc:
            last_exc = exc
            _log(f'Overpass mirror {ox.settings.overpass_url!r} failed '
                 f'(attempt {attempt + 1}/{len(_OVERPASS_CANDIDATES)}): '
                 f'{type(exc).__name__}: {exc}')
            _overpass_idx = (_overpass_idx + 1) % len(_OVERPASS_CANDIDATES)
            ox.settings.overpass_url = _OVERPASS_CANDIDATES[_overpass_idx]
            _log(f'Rotating Overpass mirror â {ox.settings.overpass_url!r}')
            sleep_s = backoffs[min(attempt, len(backoffs) - 1)]
            if sleep_s:
                time.sleep(sleep_s)
        except Exception:
            # InsufficientResponseError (and any other non-network exception)
            # indicates the query itself returned no data â not a mirror issue.
            # Stop immediately; rotating mirrors would only repeat the empty
            # result and waste 30 s per attempt.
            raise
    raise last_exc  # type: ignore[misc]
from geopy.geocoders import Nominatim
from matplotlib.font_manager import FontProperties

# ââ Silence noisy osmnx / shapely logs âââââââââââââââââââââââââââââââââââââ
import logging
logging.getLogger('osmnx').setLevel(logging.WARNING)

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
THEMES_DIR    = os.path.join(SCRIPT_DIR, 'themes')
FONTS_DIR     = os.path.join(SCRIPT_DIR, 'fonts')
CACHE_DIR     = os.environ.get('CACHE_DIR', '/tmp/mapvibe-osm-cache')
os.makedirs(CACHE_DIR, exist_ok=True)

# ââ Cache helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _cache_path(key: str) -> str:
    safe = key.replace(os.sep, '_').replace('/', '_')
    return os.path.join(CACHE_DIR, f'{safe}.pkl')

def cache_get(key: str):
    path = _cache_path(key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'rb') as f:
            return pickle.load(f)
    except Exception:
        return None

def cache_set(key: str, value):
    path = _cache_path(key)
    try:
        with open(path, 'wb') as f:
            pickle.dump(value, f, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass

# ââ Graph cache (TTL + LRU eviction) âââââââââââââââââââââââââââââââââââââââââ
# OSMnx fetches (street network, water polygons, parks) are the dominant time
# cost of a render â even parallelised they're ~4-6 s of Overpass round trips
# per render. Caching them by quantized (lat, lng, dist, filter) reduces a hot
# re-render (theme swap, frame change, pan-back) to essentially the matplotlib
# draw cost (~1-3 s).
#
# Design:
#   - Storage: pickle to /tmp/mapvibe-osm-cache/ (same dir as the geocode
#     cache). Ephemeral per Railway container, which is fine â cache rebuilds
#     on demand and a cold start just means the first render of each location
#     pays the full Overpass cost.
#   - TTL: 7 days. OSM updates daily but a poster of a city centre is
#     insensitive to a new sidewalk. Anything older than the TTL is treated
#     as a miss and overwritten.
#   - Disk budget: 512 MB hard cap. Each cached graph is a few MB; budget
#     comfortably holds ~50-100 cities. LRU eviction by mtime when over.
#   - Quantization: lat/lng to 4 decimals (~11 m), comp_dist rounded UP to
#     the nearest 1 km so adjacent requests share entries. CRUCIAL: fetches
#     ALWAYS use the quantized (rounded-up) radius so the cached value is
#     guaranteed to cover any later request that maps to the same bucket.
#     A smaller real comp_dist served from a larger cached fetch is safe â
#     matplotlib crops to the requested view.
_GRAPH_CACHE_TTL_S      = 7 * 24 * 3600          # 7 days
_GRAPH_CACHE_MAX_BYTES  = 512 * 1024 * 1024      # 512 MB

def _graph_cache_quantize(lat: float, lng: float, comp_dist: float) -> tuple:
    """Quantize the (lat, lng, comp_dist) tuple for cache key derivation AND
    for the actual Overpass fetch. Returning both so the caller fetches at
    the bucket centre/radius, not the raw values â that's what guarantees
    cached entries cover their bucket."""
    qlat = round(lat * 1e4) / 1e4
    qlng = round(lng * 1e4) / 1e4
    # Round comp_dist UP to nearest 1 km so we never under-fetch within a bucket.
    qdist = int(((float(comp_dist) + 999.0) // 1000.0) * 1000.0)
    return qlat, qlng, qdist

def _graph_cache_key(prefix: str, qlat: float, qlng: float, qdist: int, *extras) -> str:
    parts = [prefix, f'{qlat:.4f}', f'{qlng:.4f}', str(qdist), *(str(e) for e in extras)]
    return f'{prefix}_{hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]}'

def graph_cache_get(key: str, *, _pbf_context=None):
    """Return the cached value if fresh (within TTL), else None.
    Lookup order: disk L1 (~1s) â R2 L2 graph (~2s) â local PBF (~5-10s) â
                  R2 PBF download (~15-30s) â None (Overpass fallback).
    _pbf_context: optional dict with keys lat, lon, dist, minor_roads â when
    present, enables the PBF tier (L3/L4) for street-graph lookups.
    Never raises â any error is treated as a cache miss."""
    path = _cache_path(key)
    # L1: disk
    try:
        if os.path.exists(path) and (time.time() - os.path.getmtime(path)) <= _GRAPH_CACHE_TTL_S:
            with open(path, 'rb') as f:
                return pickle.load(f)
    except Exception as e:
        _log(f'Graph cache L1 read failed ({key}): {e}')
    # L2: R2 graph pickle
    r2_value = r2_cache_get(key)
    if r2_value is not None:
        _graph_cache_write_disk(key, r2_value)   # warm L1 from L2
        return r2_value
    # L3/L4: PBF extraction (streets only, when context provided)
    if _pbf_context is not None:
        pbf_value = _try_pbf_extraction(**_pbf_context)
        if pbf_value is not None:
            return pbf_value   # graph_cache_set called inside _try_pbf_extraction
    return None

def graph_cache_set(key: str, value) -> None:
    """Write to disk L1 (atomic) and kick off a non-blocking R2 L2 upload."""
    _graph_cache_write_disk(key, value)
    r2_cache_set(key, value)   # daemon thread â never blocks render


def _graph_cache_write_disk(key: str, value) -> None:
    """Atomically write the entry (tmp + rename) and run an LRU eviction pass
    so a long-running container can't blow past the disk budget. Never raises â
    cache failure must not break the render."""
    path = _cache_path(key)
    tmp = path + '.tmp'
    try:
        with open(tmp, 'wb') as f:
            pickle.dump(value, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    except Exception as e:
        _log(f'Graph cache L1 write failed ({key}): {e}')
        try: os.unlink(tmp)
        except Exception: pass
        return
    _graph_cache_evict_if_over_budget()

def _graph_cache_evict_if_over_budget() -> None:
    try:
        entries = []
        total = 0
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            try:
                st = os.stat(p)
                entries.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            except FileNotFoundError:
                continue
        if total <= _GRAPH_CACHE_MAX_BYTES:
            return
        # Oldest first â drop until we're back under budget.
        entries.sort(key=lambda e: e[0])
        evicted = 0
        for _mtime, size, p in entries:
            if total <= _GRAPH_CACHE_MAX_BYTES:
                break
            try:
                os.unlink(p)
                total -= size
                evicted += 1
            except Exception:
                pass
        if evicted:
            _log(f'Graph cache: evicted {evicted} entries (LRU, budget={_GRAPH_CACHE_MAX_BYTES // 1024 // 1024} MB)')
    except Exception as e:
        _log(f'Graph cache eviction failed: {e}')



# ââ R2 graph cache + PBF tier (Phase 1 + 2) âââââââââââââââââââââââââââââââââ
# Phase 1: graph pickles in R2 (L2) survive Railway restarts.
# Phase 2: Geofabrik PBFs seeded to R2 (~55 GB); pyrosm extracts any city or
#          village locally, eliminating Overpass for all seeded regions.
# Lookup order:
#   disk L1 (~1s) â R2 L2 graph (~2s) â local PBF (~5-10s) â
#   R2 PBF download (~15-30s, warms local PBF) â Overpass (~20-65s)
# R2 writes run in daemon threads â they NEVER block a render.
# Falls back silently if R2 is not configured or any call fails.

_R2_ACCOUNT_ID        = os.environ.get('R2_ACCOUNT_ID', '')
_R2_ACCESS_KEY_ID     = os.environ.get('R2_ACCESS_KEY_ID', '')
_R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY', '')
_R2_BUCKET_NAME       = os.environ.get('R2_BUCKET_NAME', 'mapvibe-graph-cache')
_R2_ENABLED           = bool(_R2_ACCOUNT_ID and _R2_ACCESS_KEY_ID and _R2_SECRET_ACCESS_KEY)
_r2_client = None
_r2_init_lock = threading.Lock()


def _get_r2_client():
    """Lazily initialise and return the boto3 S3 client for R2. Returns None
    if R2 is not configured or boto3 is unavailable."""
    global _r2_client
    if not _R2_ENABLED:
        return None
    if _r2_client is not None:
        return _r2_client
    with _r2_init_lock:
        if _r2_client is not None:
            return _r2_client
        try:
            import boto3
            _r2_client = boto3.client(
                's3',
                endpoint_url=f'https://{_R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
                aws_access_key_id=_R2_ACCESS_KEY_ID,
                aws_secret_access_key=_R2_SECRET_ACCESS_KEY,
                # R2 region is always 'auto'; omitting region_name avoids boto3
                # validation errors on versions that reject non-AWS region strings.
            )
            _log('R2 graph cache client initialised')
        except Exception as e:
            _log(f'R2 client init failed â R2 disabled: {e}')
            _r2_client = None
        return _r2_client


def _r2_obj_key(cache_key: str) -> str:
    return f'graphs/{cache_key}.pkl'


def r2_cache_get(cache_key: str):
    """Try to fetch a graph entry from R2. Returns unpickled value or None."""
    client = _get_r2_client()
    if client is None:
        return None
    try:
        obj = client.get_object(Bucket=_R2_BUCKET_NAME, Key=_r2_obj_key(cache_key))
        data = obj['Body'].read()
        value = pickle.loads(data)
        _log(f'R2 L2 cache hit ({cache_key})')
        return value
    except client.exceptions.NoSuchKey:
        return None
    except Exception as e:
        _log(f'R2 cache get failed ({cache_key}): {e}')
        return None


def r2_cache_set(cache_key: str, value) -> None:
    """Upload a graph entry to R2 in a background daemon thread.

    Serialisation (pickle.dumps) is done **synchronously in the calling thread**
    before the background thread is spawned.  The alternative â serialising
    inside the daemon thread â causes a race condition: the calling thread may
    continue mutating the same NetworkX graph (e.g. ox.project_graph modifies
    node-attribute dicts in-place) while pickle is iterating over those very
    same dicts, raising 'dictionary changed size during iteration'.  Serialising
    eagerly, before control returns to the caller, eliminates the race because
    pickle runs while the graph is still in a consistent, unmutated state.
    Only the S3 upload (pure I/O) stays in the background.
    """
    client = _get_r2_client()
    if client is None:
        return
    try:
        data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as e:
        _log(f'R2 cache serialize failed ({cache_key}): {e}')
        return

    def _upload():
        try:
            client.put_object(
                Bucket=_R2_BUCKET_NAME,
                Key=_r2_obj_key(cache_key),
                Body=data,
                ContentType='application/octet-stream',
            )
            _log(f'R2 L2 cache written ({cache_key}, {len(data) // 1024} KB)')
        except Exception as e:
            _log(f'R2 cache set failed ({cache_key}): {e}')
    threading.Thread(target=_upload, daemon=True).start()




# ââ PBF cache â L3/L4 Geofabrik-based tier (Phase 2) âââââââââââââââââââââââââ
# All Geofabrik regional PBFs are pre-seeded to R2 once by
# scripts/upload_pbfs_to_r2.py (~55 GB total, ~$0.83/mo).
# At runtime, the relevant country/regional PBF is fetched from R2 on demand
# and cached locally in PBF_CACHE_DIR.  pyrosm extracts just the city bounding
# box; the result is a normal OSMnx MultiDiGraph cached in L1+L2 as usual.

_SCRIPT_DIR       = os.path.dirname(os.path.abspath(__file__))
_PBF_CACHE_DIR    = os.environ.get('PBF_CACHE_DIR', '/tmp/mapvibe_pbf')
_PBF_CACHE_MAX_BYTES = int(os.environ.get('PBF_CACHE_MAX_MB', '8000')) * 1024 * 1024
_PBF_CACHE_TTL_S  = 14 * 24 * 3600   # 14 days
os.makedirs(_PBF_CACHE_DIR, exist_ok=True)

# Lazy-loaded region table â loaded once on first PBF lookup
_pbf_regions = None
_pbf_regions_lock = threading.Lock()

# Per-region PBF download locks â one Lock per region_key.  Prevents
# concurrent parallel render workers from downloading the same regional
# PBF simultaneously, which caused duplicate "PBF L4: downloading â¦"
# log lines (and wasted bandwidth on identical large downloads).
_pbf_download_locks: dict = {}
_pbf_download_locks_lock = threading.Lock()


def _get_pbf_download_lock(region_key: str) -> threading.Lock:
    """Return (creating if needed) the per-region singleton Lock."""
    with _pbf_download_locks_lock:
        if region_key not in _pbf_download_locks:
            _pbf_download_locks[region_key] = threading.Lock()
        return _pbf_download_locks[region_key]


def _load_pbf_regions():
    global _pbf_regions
    if _pbf_regions is not None:
        return _pbf_regions
    with _pbf_regions_lock:
        if _pbf_regions is not None:
            return _pbf_regions
        candidates = [
            os.path.join(_SCRIPT_DIR, 'geofabrik_regions.json'),
            os.path.join(os.path.dirname(_SCRIPT_DIR), 'geofabrik_regions.json'),
        ]
        for path in candidates:
            if os.path.exists(path):
                with open(path) as f:
                    _pbf_regions = json.load(f)
                _log(f'PBF region table loaded ({len(_pbf_regions)} regions)')
                return _pbf_regions
        _pbf_regions = []
        _log('PBF region table not found â PBF tier disabled')
        return _pbf_regions


def _coord_to_pbf_region(lat: float, lon: float) -> dict | None:
    """Return the most specific Geofabrik region dict that contains (lat, lon)."""
    regions = _load_pbf_regions()
    # Prefer smaller regions (lower size_mb) to avoid downloading large files
    candidates = []
    for r in regions:
        w, s, e, n = r['bbox']
        if w <= lon <= e and s <= lat <= n:
            candidates.append(r)
    if not candidates:
        return None
    # Sort by nearest centroid distance â this correctly routes cities that
    # sit near a country border (e.g. Tegucigalpa near the Nicaragua bbox)
    # to the PBF whose geographic centre is closest, rather than the PBF
    # that happens to be smallest in MB.  The old sort-by-size made Nicaragua
    # (55 MB) beat Honduras (60 MB) for Tegucigalpa even though Tegucigalpa
    # is 1.2Â° from Honduras centroid vs 2.1Â° from Nicaragua centroid.
    candidates.sort(key=lambda r: (
        ((r['bbox'][0] + r['bbox'][2]) / 2 - lon) ** 2 +
        ((r['bbox'][1] + r['bbox'][3]) / 2 - lat) ** 2
    ))
    return candidates[0]


def _pbf_local_path(region_key: str) -> str:
    safe = region_key.replace('/', '_')
    return os.path.join(_PBF_CACHE_DIR, f'{safe}.osm.pbf')


def _pbf_r2_key(region_key: str) -> str:
    return f'pbf/{region_key}.osm.pbf'


def _pbf_local_fresh(region_key: str) -> bool:
    path = _pbf_local_path(region_key)
    if not os.path.exists(path):
        return False
    return (time.time() - os.path.getmtime(path)) <= _PBF_CACHE_TTL_S


def _pbf_evict_if_over_budget() -> None:
    """LRU-evict local PBF cache if over the disk budget."""
    try:
        entries = []
        total = 0
        for name in os.listdir(_PBF_CACHE_DIR):
            p = os.path.join(_PBF_CACHE_DIR, name)
            try:
                st = os.stat(p)
                entries.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            except FileNotFoundError:
                continue
        if total <= _PBF_CACHE_MAX_BYTES:
            return
        entries.sort(key=lambda e: e[0])
        evicted = 0
        for _mtime, size, p in entries:
            if total <= _PBF_CACHE_MAX_BYTES:
                break
            try:
                os.unlink(p)
                total -= size
                evicted += 1
            except Exception:
                pass
        if evicted:
            _log(f'PBF cache: evicted {evicted} files (LRU, budget={_PBF_CACHE_MAX_BYTES // 1024 // 1024} MB)')
    except Exception as e:
        _log(f'PBF cache eviction failed: {e}')


def _ensure_pbf_local(region: dict) -> str | None:
    """Ensure the regional PBF is on local disk.
    Returns local path on success, None on failure.
    Check order: local disk (fresh) â R2 download â Geofabrik direct download.
    Never raises."""
    region_key = region['region_key']
    local_path = _pbf_local_path(region_key)

    # Already on disk and fresh (fast path â no lock needed)
    if _pbf_local_fresh(region_key):
        return local_path

    # Hold a per-region lock so concurrent render workers for the same city
    # don't trigger duplicate downloads.  We re-check freshness inside the
    # lock in case a sibling worker completed the download while we waited.
    with _get_pbf_download_lock(region_key):
        if _pbf_local_fresh(region_key):
            return local_path

        client = _get_r2_client()

        # Try R2 first (fastest, no Geofabrik rate limits)
        if client is not None:
            try:
                r2_key = _pbf_r2_key(region_key)
                _log(f'PBF L4: downloading {region_key} from R2 ({region.get("size_mb")} MB)...')
                tmp_path = local_path + '.tmp'
                client.download_file(Bucket=_R2_BUCKET_NAME, Key=r2_key, Filename=tmp_path)
                os.replace(tmp_path, local_path)
                _pbf_evict_if_over_budget()
                _log(f'PBF L4: {region_key} cached locally from R2')
                return local_path
            except Exception as e:
                _log(f'PBF R2 download failed ({region_key}): {e}')
                try: os.unlink(local_path + '.tmp')
                except Exception: pass

        # Fallback: direct Geofabrik download (seeds R2 too)
        url = region.get('url')
        if url:
            try:
                import requests as _requests
                _log(f'PBF fallback: downloading {region_key} from Geofabrik ({region.get("size_mb")} MB)...')
                tmp_path = local_path + '.tmp'
                with _requests.get(url, stream=True, timeout=300) as resp:
                    resp.raise_for_status()
                    with open(tmp_path, 'wb') as f:
                        for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
                            f.write(chunk)
                os.replace(tmp_path, local_path)
                _pbf_evict_if_over_budget()
                _log(f'PBF fallback: {region_key} downloaded from Geofabrik')
                # Seed to R2 in background so future restarts skip Geofabrik
                if client is not None:
                    def _seed_r2():
                        try:
                            client.upload_file(local_path, _R2_BUCKET_NAME, _pbf_r2_key(region_key))
                            _log(f'PBF seeded to R2: {region_key}')
                        except Exception as e2:
                            _log(f'PBF R2 seed failed ({region_key}): {e2}')
                    threading.Thread(target=_seed_r2, daemon=True).start()
                return local_path
            except Exception as e:
                _log(f'PBF Geofabrik download failed ({region_key}): {e}')
                try: os.unlink(local_path + '.tmp')
                except Exception: pass

    return None


def _graph_from_pbf(pbf_path: str, lat: float, lon: float,
                    dist: int, minor_roads: bool):
    """Extract an OSMnx-compatible MultiDiGraph from a local PBF using pyrosm.
    Returns None if pyrosm is unavailable or extraction fails."""
    try:
        import pyrosm
    except ImportError:
        _log('pyrosm not installed â PBF extraction unavailable')
        return None
    try:
        # Bounding box: dist metres â degrees with 50% buffer
        delta = (dist / 111_000) * 1.5
        bbox = [lon - delta, lat - delta, lon + delta, lat + delta]
        osm = pyrosm.OSM(pbf_path, bounding_box=bbox)
        nodes, edges = osm.get_network(network_type='driving', nodes=True)
        if nodes is None or edges is None or len(nodes) == 0 or len(edges) == 0:
            _log(f'PBF extraction: no network data in bbox {bbox}')
            return None
        # Filter to arterials when minor_roads=False (matches Overpass behaviour)
        if not minor_roads:
            arterials = {'motorway', 'motorway_link', 'trunk', 'trunk_link',
                         'primary', 'primary_link'}
            if 'highway' in edges.columns:
                edges = edges[edges['highway'].isin(arterials)]
                if len(edges) == 0:
                    _log('PBF extraction: no arterials after filter')
                    return None
        G = osm.to_graph(nodes, edges, graph_type='networkx', retain_all=False)
        n_nodes = 0 if G is None else len(G.nodes)
        n_edges = 0 if G is None else len(G.edges)
        if G is None or n_nodes == 0 or n_edges == 0:
            _log(f'[mapvibe_render] PBF extraction returned {n_nodes} nodes, '
                 f'{n_edges} edges â falling back to Overpass')
            return None
        _log(f'PBF extraction OK: {n_nodes} nodes, {n_edges} edges')
        return G
    except Exception as e:
        err_str = str(e)
        # BlobHeader / StructError: the local PBF is corrupted (e.g. partial R2 upload).
        # Evict it so the next request re-downloads a fresh copy from Geofabrik â R2.
        if 'BlobHeader' in err_str or 'exceeds the' in err_str or 'StructError' in err_str:
            _log(f'PBF corrupted ({pbf_path}) â evicting: {e}')
            try:
                os.unlink(pbf_path)
            except Exception:
                pass
            # Also delete the R2 object so the next city doesn't re-download
            # the same corrupt bytes (evicting local-only causes a re-download
            # loop when R2 holds an error-XML stub from a failed upload).
            try:
                r2 = _get_r2_client()
                if r2:
                    r2.delete_object(Bucket=_R2_BUCKET_NAME,
                                     Key=_pbf_r2_key(region_key))
                    _log(f'PBF R2 corrupt object deleted ({region_key})')
            except Exception:
                pass
        else:
            _log(f'PBF graph extraction failed: {e}')
        return None


def _try_pbf_extraction(lat: float, lon: float, dist: int,
                        minor_roads: bool, cache_key: str) -> object:
    """Full PBF tier: find region â ensure local PBF â extract graph.
    On success, writes the graph to L1+L2 (graph cache) and returns it.
    Returns None on any failure so caller falls through to Overpass.

    IMPORTANT: pyrosm availability is checked FIRST â before any PBF download.
    Without this guard, _ensure_pbf_local eagerly downloads the full regional
    PBF (up to 4 GB) only to discover pyrosm is absent, wasting 40-60 s
    before falling through to Overpass and making every cold village render
    pay a full PBF download cost for zero benefit.
    """
    # Guard: bail immediately if pyrosm is not installed.
    # This is the critical check â it must precede _ensure_pbf_local.
    try:
        import pyrosm  # noqa: F401
    except ImportError:
        _log('pyrosm not installed â skipping PBF tier (Overpass fallback)')
        return None
    region = _coord_to_pbf_region(lat, lon)
    if region is None:
        return None
    pbf_path = _ensure_pbf_local(region)
    if pbf_path is None:
        return None
    G = _graph_from_pbf(pbf_path, lat, lon, dist, minor_roads)
    if G is None:
        return None
    # Cache graph so subsequent identical requests are L1/L2 hits
    graph_cache_set(cache_key, G)
    return G


def _fetch_rail_from_pbf(pbf_path: str, lat: float, lon: float, dist: int):
    """Extract railway lines from a local PBF file via pyrosm.

    Returns a GeoDataFrame (EPSG:4326, LineString/MultiLineString only) on
    success, an *empty* GeoDataFrame when the region has no matching rail
    (genuine absence), or None when pyrosm is unavailable or extraction
    fails â so the caller can fall through to Overpass in all error cases.

    pyrosm CRS is EPSG:4326, matching the Overpass GeoDataFrame pipeline.
    """
    try:
        import pyrosm
        import geopandas as gpd
    except ImportError:
        return None
    try:
        delta = (dist / 111_000) * 1.5
        bbox = [lon - delta, lat - delta, lon + delta, lat + delta]
        osm = pyrosm.OSM(pbf_path, bounding_box=bbox)
        gdf = osm.get_data_by_custom_criteria(
            custom_filter={'railway': ['rail', 'light_rail', 'subway', 'tram', 'monorail']},
            osm_keys_to_keep=['railway', 'name'],
            filter_type='keep',
            keep_nodes=False,
        )
        # Guard: some pyrosm versions return None instead of an empty GDF
        if gdf is None or len(gdf) == 0:
            _log('PBF rail: no railway features in bbox')
            return gpd.GeoDataFrame()
        # Filter to linear geometries â exclude station Points
        gdf = gdf[gdf.geometry.type.isin(['LineString', 'MultiLineString'])].copy()
        if gdf.empty:
            return gpd.GeoDataFrame()
        _log(f'PBF rail OK: {len(gdf)} features from {pbf_path}')
        return gdf
    except Exception as e:
        err_str = str(e)
        if 'BlobHeader' in err_str or 'StructError' in err_str or 'exceeds the' in err_str:
            _log(f'PBF corrupted ({pbf_path}) â evicting: {e}')
            try:
                os.unlink(pbf_path)
            except Exception:
                pass
            # Also delete the R2 object so the next city doesn't re-download
            # the same corrupt bytes (evicting local-only causes a re-download
            # loop when R2 holds an error-XML stub from a failed upload).
            try:
                r2 = _get_r2_client()
                if r2:
                    r2.delete_object(Bucket=_R2_BUCKET_NAME,
                                     Key=_pbf_r2_key(region_key))
                    _log(f'PBF R2 corrupt object deleted ({region_key})')
            except Exception:
                pass
        else:
            _log(f'PBF rail extraction failed: {e}')
        return None


# ââ Theme loading âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

_TERRACOTTA_DEFAULT = {
    "name": "Terracotta",
    "bg": "#F5EDE4", "text": "#8B4513", "gradient_color": "#F5EDE4",
    "water": "#A8C4C4", "parks": "#E8E0D0",
    "road_motorway": "#A0522D", "road_primary": "#B8653A",
    "road_secondary": "#C9846A", "road_tertiary": "#D9A08A",
    "road_residential": "#E5C4B0", "road_default": "#D9A08A",
}

def load_theme(theme_name: str = 'midnight_blue') -> dict:
    theme_file = os.path.join(THEMES_DIR, f'{theme_name}.json')
    if os.path.exists(theme_file):
        with open(theme_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    _log(f'Theme {theme_name!r} not found; using terracotta fallback')
    return _TERRACOTTA_DEFAULT.copy()

# ââ Script detection ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def is_latin_script(text: str) -> bool:
    if not text:
        return True
    total_alpha = sum(1 for c in text if c.isalpha())
    if total_alpha == 0:
        return True
    latin_count = sum(1 for c in text if c.isalpha() and ord(c) < 0x250)
    return (latin_count / total_alpha) > 0.8

# ââ Road helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

# Lowest road tier â service / track / footway / etc. Always hidden in Clean,
# shown in Detailed. Pre-existing definition; semantically the "minor roads"
# the studio's roadDetailMode never toggled on its own (these were tied to a
# separate includeRoadMinorLow form field that defaults to off).
_MINOR_ROAD_TYPES = frozenset({
    'residential', 'living_street', 'unclassified',
    'service', 'track', 'path', 'footway', 'cycleway',
    'pedestrian', 'steps',
})

# Mid-tier roads the editor's Clean / Arteries toggle hides alongside the
# minor family. Matches MapVibeEditor.tsx's ROAD_DETAIL_LAYERS set:
#   road-secondary       â secondary, secondary_link
#   road-minor-mid       â tertiary, tertiary_link
#   road-minor-low       â residential family (already in _MINOR_ROAD_TYPES)
# So a true Clean-mode render shows only motorway / trunk / primary; anything
# below gets transparent at draw time. Detailed (minor_roads=True) shows
# every tier, matching the editor's Detailed = "everything visible".
_CLEAN_HIDDEN_TYPES = frozenset(_MINOR_ROAD_TYPES | {
    'secondary', 'secondary_link',
    'tertiary',  'tertiary_link',
})

def _highway(data: dict) -> str:
    hw = data.get('highway', 'unclassified')
    if isinstance(hw, list):
        hw = hw[0] if hw else 'unclassified'
    return hw

def get_edge_colors(g, theme: dict, minor_roads: bool) -> list:
    colors = []
    for _u, _v, data in g.edges(data=True):
        hw = _highway(data)
        # Clean mode hides secondary / tertiary / residential family â matches
        # the editor's roadDetailMode='arteries' which toggles the same three
        # layer families together. Detailed mode falls through and tiers are
        # coloured by their highway class via the shared _pmtiles_tier_color
        # helper (single source of truth for the OSMnx and PMTiles paths).
        if not minor_roads and hw in _CLEAN_HIDDEN_TYPES:
            colors.append('#00000000')
            continue
        colors.append(_pmtiles_tier_color(hw, theme))
    return colors

def get_edge_widths(g, minor_roads: bool) -> list:
    widths = []
    for _u, _v, data in g.edges(data=True):
        hw = _highway(data)
        # Same Clean / Detailed semantics as get_edge_colors â keep the two
        # hide-sets in lockstep so widths and colours never disagree on which
        # tier is drawn.
        if not minor_roads and hw in _CLEAN_HIDDEN_TYPES:
            widths.append(0.0)
            continue
        widths.append(_pmtiles_tier_width(hw))
    return widths


# ── Tier helpers shared by the OSMnx and PMTiles draw paths ───────────────────
# Extracted so the PMTiles path (which iterates a GeoDataFrame, not a NetworkX
# graph) can pick up the same per-tier color + width logic without duplicating
# the if/elif chain. get_edge_colors/get_edge_widths still iterate the graph
# and apply Clean/Detailed filtering, but the per-tier mapping lives here.

def _pmtiles_tier_color(hw: str, theme: dict) -> str:
    if hw in ('motorway', 'motorway_link'):
        return theme['road_motorway']
    if hw in ('trunk', 'trunk_link', 'primary', 'primary_link'):
        return theme['road_primary']
    if hw in ('secondary', 'secondary_link'):
        return theme['road_secondary']
    if hw in ('tertiary', 'tertiary_link'):
        return theme['road_tertiary']
    return theme.get('road_residential', theme.get('road_default', '#888888'))


def _pmtiles_tier_width(hw: str) -> float:
    if hw in ('motorway', 'motorway_link'):
        return 1.2
    if hw in ('trunk', 'trunk_link', 'primary', 'primary_link'):
        return 1.0
    if hw in ('secondary', 'secondary_link'):
        return 0.8
    if hw in ('tertiary', 'tertiary_link'):
        return 0.6
    return 0.4

# ââ Gradient fade âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def create_gradient_fade(ax, color: str, location: str = 'bottom', zorder: int = 10):
    vals = np.linspace(0, 1, 256).reshape(-1, 1)
    gradient = np.hstack((vals, vals))
    rgb = mcolors.to_rgb(color)
    my_colors = np.zeros((256, 4))
    my_colors[:, 0] = rgb[0]
    my_colors[:, 1] = rgb[1]
    my_colors[:, 2] = rgb[2]
    if location == 'bottom':
        my_colors[:, 3] = np.linspace(1, 0, 256)
        ys, ye = 0, 0.25
    else:
        my_colors[:, 3] = np.linspace(0, 1, 256)
        ys, ye = 0.75, 1.0
    cmap = mcolors.ListedColormap(my_colors)
    xlim = ax.get_xlim()
    ylim = ax.get_ylim()
    yr = ylim[1] - ylim[0]
    ax.imshow(gradient,
              extent=[xlim[0], xlim[1], ylim[0] + yr * ys, ylim[0] + yr * ye],
              aspect='auto', cmap=cmap, zorder=zorder, origin='lower')

# ââ Crop limits âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def get_crop_limits(g_proj, point: tuple, fig, dist: int):
    """
    Compute matplotlib axis limits centered on the user-supplied geographic
    point. Returns (xlim, ylim) in the projected graph's CRS units (metres
    for the UTM projections OSMnx picks by default).

    point is (lat, lng) â WGS84 degrees.
    g_proj is a *projected* graph: its node x/y are large metre values, not
    lat/lng. Earlier code called
        ox.distance.nearest_nodes(g_proj, point[1], point[0])
    which passed degree-scale numbers (e.g. (-77, 39)) into a metre-scale
    graph (e.g. (323420, 4307180)). nearest_nodes therefore returned the
    node with the smallest cartesian distance to (-77, 39) â effectively a
    random node near the projection origin, several kilometres away from
    the user's actual location. That offset is why preview renders looked
    drifted (cluster in the upper-half of the figure instead of centred).

    Fix: project (lat, lng) into the graph's CRS first, then use those
    coordinates directly as the centre. No need to snap to a graph node â
    matplotlib's xlim/ylim accept any float and the crop is purely a view
    decision, not a data lookup.
    """
    cx = cy = None
    try:
        from shapely.geometry import Point as _Point
        graph_crs = g_proj.graph.get('crs', 'EPSG:4326')
        # shapely Point uses (x, y) â (lng, lat) in WGS84.
        pt_proj, _ = ox.projection.project_geometry(
            _Point(point[1], point[0]),
            crs='EPSG:4326',
            to_crs=graph_crs,
        )
        cx, cy = float(pt_proj.x), float(pt_proj.y)
    except Exception as e:
        _log(f'Projection of crop centre failed: {e}; falling back to node centroid')

    if cx is None or cy is None:
        # Last-resort fallback: centroid of fetched node coordinates. Always in
        # the projected CRS already, so at worst we centre on the data mass.
        xs = [d['x'] for _, d in g_proj.nodes(data=True)]
        ys = [d['y'] for _, d in g_proj.nodes(data=True)]
        cx, cy = float(np.mean(xs)), float(np.mean(ys))

    figw, figh = fig.get_size_inches()
    aspect = figh / figw
    return (cx - dist, cx + dist), (cy - dist * aspect, cy + dist * aspect)

# ââ Geocoding âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def get_coordinates(city: str, country: str):
    key = f'coords_{city.lower()}_{country.lower()}'
    cached = cache_get(key)
    if cached:
        _log(f'Using cached coordinates for {city}, {country}')
        return cached
    try:
        geolocator = Nominatim(user_agent='mapvibe-render/1.0')
        time.sleep(1)
        location = geolocator.geocode(f'{city}, {country}')
        if location:
            result = (location.latitude, location.longitude)
            cache_set(key, result)
            return result
    except Exception as e:
        _log(f'Geocoding failed: {e}')
    return None

# ââ Fonts âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def load_fonts():
    result = {}
    for variant, filename in [
        ('bold',    'Roboto-Bold.ttf'),
        ('regular', 'Roboto-Regular.ttf'),
        ('light',   'Roboto-Light.ttf'),
    ]:
        path = os.path.join(FONTS_DIR, filename)
        if os.path.exists(path):
            result[variant] = path
    return result if len(result) == 3 else {}

# ââ Logging âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def _log(msg: str):
    print(f'[mapvibe_render] {msg}', file=sys.stderr, flush=True)

# ââ Main render function ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

def render(params: dict) -> bytes:
    city            = params.get('city', '')
    country         = params.get('country', '')
    lat             = params.get('lat')
    lng             = params.get('lng')
    display_city    = params.get('display_city') or city
    display_country = params.get('display_country') or country
    theme_name      = params.get('theme_name', 'midnight_blue')
    theme_override  = params.get('theme_json')
    dist            = int(params.get('dist', 15000))
    width_in        = float(params.get('width_in', 12.0))
    height_in       = float(params.get('height_in', 16.0))
    dpi             = int(params.get('dpi', 400))
    # preview_max_px â optional pixel cap for the long edge of the figure.
    # When set, width_in/height_in are rescaled so max(W,H)*dpi == preview_max_px.
    # DPI and edge-width calibration are intentionally left unchanged so line
    # weights remain readable at preview resolution regardless of canvas size.
    preview_max_px  = params.get('preview_max_px')
    show_text       = bool(params.get('show_text', True))
    full_bleed      = bool(params.get('full_bleed', True))
    no_fade         = bool(params.get('no_fade', True))
    minor_roads     = bool(params.get('minor_roads', False))
    # `preset` supersedes `minor_roads` per PRESETS-SPEC.md. Server accepts
    # both for one release as a backwards-compat shim; preset wins when both
    # are supplied. None falls through to the minor_roads bool below.
    preset          = params.get('preset')
    network_type    = params.get('network_type', 'drive')
    # crop_dist â optional override for the matplotlib axis half-extent.
    # Default (None) keeps the legacy behaviour: get_crop_limits is called
    # with `dist`, which is the original /fulfill contract.
    # /render passes crop_dist=userOsmDist so the visible axes equal the
    # circle OSMnx actually fetched â without this override the road graph
    # appears as a tiny cluster in a sea of background colour because
    # comp_dist = dist*(max/min)/4 is always 3-4Ã smaller than dist.
    crop_dist_param = params.get('crop_dist')

    # ââ 1. Resolve coordinates âââââââââââââââââââââââââââââââââââââââââââââââ
    point = None
    if lat is not None and lng is not None:
        point = (float(lat), float(lng))
    if point is None and city and country:
        point = get_coordinates(city, country)
    if point is None:
        raise ValueError(f'Cannot resolve coordinates for city={city!r}, country={country!r}')

    # Apply preview_max_px canvas cap: scale the figure so the output PNG's
    # long edge is exactly preview_max_px pixels. Only figure dimensions
    # change â DPI and edge-width calibration stay untouched.
    if preview_max_px is not None:
        _pmx = int(preview_max_px)
        _long_px = max(width_in, height_in) * dpi
        if _long_px > 0:
            _scale = _pmx / _long_px
            width_in  = width_in  * _scale
            height_in = height_in * _scale
    _log(f'{display_city}, {display_country} @ {point[0]:.4f},{point[1]:.4f}  '
         f'dist={dist}m  {width_in}Ã{height_in}in  {dpi}DPI  '
         f'{"pmx="+str(_pmx)+"  " if preview_max_px else ""}'
         f'full_bleed={full_bleed}  no_fade={no_fade}  minor_roads={minor_roads}')

    # ââ 2. Load theme ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    theme = theme_override if isinstance(theme_override, dict) else load_theme(theme_name)

    # ââ 3. Fetch OSM data ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # Compensated dist ensures the map fills poster aspect ratio without clipping
    comp_dist = dist * (max(height_in, width_in) / min(height_in, width_in)) / 4

    # The street / water / parks fetches are three independent Overpass round
    # trips. Previously they ran sequentially (sum of three latencies â 8-12 s
    # on a busy Overpass mirror â the single largest chunk of the ~20 s preview
    # render). They share no state and OSMnx's `requests` calls release the
    # GIL during socket I/O, so a 3-worker ThreadPoolExecutor genuinely
    # overlaps them; the render now waits on the MAX of the three (~4-6 s).
    #
    # On top of that, each fetch consults the on-disk graph cache (TTL 7 days,
    # LRU-bounded 512 MB). A repeat render of the same location â theme swap,
    # frame change, pan-back â skips Overpass entirely and goes straight to
    # matplotlib, taking total render time to ~1-3 s. The cache key is
    # quantized (lat/lng 4dp â 11 m, comp_dist rounded UP to 1 km) and we
    # ALWAYS fetch at the quantized point / radius so any later request that
    # maps to the same bucket is guaranteed to be covered. Serving a 4500 m
    # request from a cached 5000 m fetch is safe â matplotlib crops the view.
    from concurrent.futures import ThreadPoolExecutor

    # ── USE_PMTILES feature flag ─────────────────────────────────────────────
    # When true, the fetch + street-draw path swaps from OSMnx/Overpass to
    # range-request reads against the planet PMTiles archive on R2. Same
    # downstream theme/typography/save code. Default false during cut-over;
    # flip on Railway once the archive URL is set and a smoke render passes.
    # See docs/PMTILES-CUTOVER.md for the env var setup and rollback flow.
    use_pmtiles = os.environ.get('USE_PMTILES', '').lower() == 'true'
    streets_gdf = None  # populated only on the PMTiles path; signals the
                        # street-draw branch below to skip ox.plot_graph

    if use_pmtiles:
        # Import here so OSMnx-only deploys don't pay the import cost (boto3
        # adds ~150 ms; pmtiles + mapbox_vector_tile a similar amount).
        from pmtiles_reader import get_reader
        from render_presets import resolve_preset

        # The PMTiles bbox needs to enclose the same circle OSMnx would have
        # fetched. comp_dist is the half-radius post-aspect-compensation; we
        # circumscribe a square around it.
        EARTH_RADIUS_M = 6_371_000
        dlat = (comp_dist / EARTH_RADIUS_M) * (180 / math.pi)
        dlng = dlat / math.cos(math.radians(point[0]))
        bbox = (point[1] - dlng, point[0] - dlat,
                point[1] + dlng, point[0] + dlat)

        reader = get_reader()
        t_fetch = time.time()
        # planet.pmtiles uses the Protomaps basemaps schema: streets live in the
        # `roads` layer (with rail/ferry/aeroway mixed in), parks in `landuse`,
        # rail also in `roads` (kind='rail'). The legacy 'streets'/'parks'/'rail'
        # layer names do not exist in this archive and returned empty frames —
        # surfacing as the misleading "PMTiles returned no street data".
        # See pmtiles_reader._PROTOMAPS_KIND_TO_HIGHWAY for the schema bridge.
        _ROAD_KINDS = {'highway', 'major_road', 'medium_road', 'minor_road', 'path'}
        _PARK_KINDS = {'park', 'forest', 'wood', 'grass', 'meadow',
                       'nature_reserve', 'garden', 'recreation_ground',
                       'pitch', 'golf_course', 'cemetery'}
        streets_gdf = reader.fetch_layer('roads', bbox, zoom=14,
                                         kind_filter=_ROAD_KINDS, add_highway=True)
        water       = reader.fetch_layer('water', bbox, zoom=14)
        parks       = reader.fetch_layer('landuse', bbox, zoom=14,
                                         kind_filter=_PARK_KINDS)
        rail        = reader.fetch_layer('roads', bbox, zoom=14,
                                         kind_filter={'rail'})
        g = None  # downstream branches on `streets_gdf is not None`
        _log(f'Fetch phase {time.time() - t_fetch:.1f}s — PMTiles bbox={bbox}')

        # Fail loud on empty streets — mirrors the OSMnx path's
        # `if g is None or len(g.nodes) == 0: raise` below. Without this an
        # empty archive read (bad bbox, coverage gap, all-tiles-miss) would
        # either throw an opaque AttributeError from streets_gdf.to_crs() or
        # silently render a blank poster — the worst outcome for a printed
        # product. Water / parks / rail stay soft (guarded by .empty before
        # they draw) — only streets are load-bearing.
        if streets_gdf is None or streets_gdf.empty:
            raise RuntimeError(
                f'PMTiles returned no street data for bbox={bbox} — '
                f'check archive coverage at this location.'
            )
        # Skip the rest of the OSMnx-path fetch logic + jump to figure setup.
        # (See `if use_pmtiles` block before the ox.plot_graph call.)

    qlat, qlng, qdist  = _graph_cache_quantize(point[0], point[1], comp_dist)
    qpoint             = (qlat, qlng)
    cache_hits         = {"streets": False, "water": False, "parks": False, "rail": False}

    # ââ pview cache tier âââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # Stores the post-projection pre-clipped graph (~1-3 MB, ~3-5k nodes) so
    # subsequent preview requests skip BOTH the streets fetch (2-25 s) AND
    # ox.project_graph (15-30 s for DC 20k-node graph).
    # pview_only=True returns immediately after the cache write (no PNG).
    _pview_filter   = 'minor' if minor_roads else 'major'
    _pview_round_cd = round(
        (int(crop_dist_param) if crop_dist_param is not None else dist) / 500
    ) * 500
    pview_key     = _graph_cache_key(
        'pview', qlat, qlng, qdist, _pview_round_cd, _pview_filter, network_type
    )
    _pview_cached = graph_cache_get(pview_key)
    if _pview_cached is not None:
        _log(
            f'pview cache hit ({pview_key[:16]}â¦) â '
            f'skipping streets fetch + ox.project_graph '
            f'({len(_pview_cached.nodes)} nodes, '
            f'{_pview_cached.number_of_edges()} edges)'
        )
        cache_hits['streets'] = True  # streets implicitly covered

    def _fetch_streets():
        # Streets are the only fetch whose filter depends on minor_roads, so
        # the key carries that bit â Clean vs Detailed get separate entries.
        filter_tag = 'minor' if minor_roads else 'major'
        key = _graph_cache_key('streets', qlat, qlng, qdist, filter_tag, network_type)
        cached = graph_cache_get(key, _pbf_context={
            'lat': qlat, 'lon': qlng, 'dist': qdist,
            'minor_roads': minor_roads, 'cache_key': key,
        })
        if cached is not None:
            # Guard: a 0-edge graph (broken PBF-extraction artifact, e.g. Dublin
            # or Philadelphia where pyrosm returned 1 node / 0 edges) crashes
            # ox.project_graph with "ValueError: Graph contains no edges".
            # Evict the broken entry from L1 (disk) and fall through to Overpass
            # so this render completes and overwrites the bad cache entry.
            if hasattr(cached, 'number_of_edges') and cached.number_of_edges() == 0:
                _log(f'[mapvibe_render] PBF extraction returned 0 edges for {key} '
                     f'â evicting broken cache entry, falling back to Overpass')
                try:
                    os.unlink(_cache_path(key))
                except Exception:
                    pass
                # R2 entry will be overwritten when the Overpass fetch succeeds below.
            else:
                cache_hits['streets'] = True
                return cached
        if minor_roads:
            # Full drive network â residential/service/etc. are drawn.
            g_ = _ox_call_with_mirror_failover(ox.graph_from_point, qpoint, dist=qdist, network_type=network_type)
        else:
            # Clean mode draws only motorway / trunk / primary (matches editor's
            # roadDetailMode='arteries' which hides road-secondary, road-minor-mid
            # and road-minor-low). Anything below the arterial tier is painted
            # transparent in get_edge_colors / get_edge_widths anyway, so we save
            # the Overpass bandwidth by not downloading them in the first place.
            # The regex matches *_link suffixes for free (no anchors).
            major_roads_filter = '["highway"~"motorway|trunk|primary"]'
            try:
                g_ = _ox_call_with_mirror_failover(ox.graph_from_point, qpoint, dist=qdist, custom_filter=major_roads_filter)
            except Exception as e:
                # InsufficientResponseError: Overpass returned no nodes with the strict
                # arterial filter (common in Caribbean/LatAm cities with sparse trunk/
                # primary OSM coverage â Punta del Este, Punta Cana, etc.).
                # Fall back to a broader filter that includes secondary roads.
                if 'InsufficientResponse' in type(e).__name__:
                    _log(f'Major roads filter returned no data â falling back to secondary: {e}')
                    wider_filter = '["highway"~"motorway|trunk|primary|secondary"]'
                    g_ = _ox_call_with_mirror_failover(ox.graph_from_point, qpoint, dist=qdist, custom_filter=wider_filter)
                else:
                    raise
        # Belt-and-suspenders: guard against 0-edge graph before ox.project_graph.
        if g_ is not None and hasattr(g_, 'number_of_edges') and g_.number_of_edges() == 0:
            raise ValueError(f'Graph has 0 edges for {city!r} â OSM data gap or filter too strict')
        graph_cache_set(key, g_)
        return g_

    def _fetch_water():
        key = _graph_cache_key('water', qlat, qlng, qdist)
        cached = graph_cache_get(key)
        if cached is not None:
            cache_hits['water'] = True
            return cached
        try:
            gdf = _ox_call_with_mirror_failover(
                ox.features_from_point,
                qpoint,
                tags={'natural': ['water', 'bay', 'strait'], 'waterway': 'riverbank'},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Water fetch skipped: {e}')
            # Cache empty result so we don't re-query Overpass on every render
            # for cities with no mapped water features (inland cities, coastal
            # geometry gaps, etc.).  Transient network errors are NOT cached â
            # only confirmed "no data" responses get a permanent empty entry.
            if ('No matching features' in str(e)
                    or 'InsufficientResponse' in type(e).__name__):
                import geopandas as gpd
                empty = gpd.GeoDataFrame()
                graph_cache_set(key, empty)
                return empty
            return None
        graph_cache_set(key, gdf)
        return gdf

    def _fetch_parks():
        key = _graph_cache_key('parks', qlat, qlng, qdist)
        cached = graph_cache_get(key)
        if cached is not None:
            cache_hits['parks'] = True
            return cached
        try:
            gdf = _ox_call_with_mirror_failover(
                ox.features_from_point,
                qpoint,
                tags={'leisure': 'park', 'landuse': 'grass'},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Parks fetch skipped: {e}')
            # Cache empty result so we don't re-query Overpass on every render
            # for cities with no mapped park/grass features.  Transient network
            # errors are NOT cached â only confirmed "no data" responses.
            if ('No matching features' in str(e)
                    or 'InsufficientResponse' in type(e).__name__):
                import geopandas as gpd
                empty = gpd.GeoDataFrame()
                graph_cache_set(key, empty)
                return empty
            return None
        graph_cache_set(key, gdf)
        return gdf

    def _fetch_rail():
        # Railway lines (Metro/commuter/freight). Editor's MapLibre style
        # paints these via theme.map.rail; until this fetch landed they were
        # invisible in the Python preview (production 2026-06-16: user
        # noticed the yellow rail corridors around the city missing from
        # the print preview compared to the editor view).
        key = _graph_cache_key('rail', qlat, qlng, qdist)
        cached = graph_cache_get(key)
        if cached is not None:
            cache_hits['rail'] = True
            return cached
        # ââ PBF tier (Phase 2) âââââââââââââââââââââââââââââââââââââââââââââ
        # Prefer PBF over Overpass for all covered cities: DC Metro,
        # London Underground, Paris MÃ©tro, Mexico City Metro.  Overpass's
        # qdist=2000 m window is too tight for spread-out metro systems
        # and frequently returns empty (triggering commit-77c91313 caching).
        try:
            import pyrosm  # noqa: F401 â guard before any PBF I/O
            _rail_region = _coord_to_pbf_region(qlat, qlng)
            if _rail_region is not None:
                _rail_pbf = _ensure_pbf_local(_rail_region)
                if _rail_pbf is not None:
                    _pbf_rail = _fetch_rail_from_pbf(_rail_pbf, qlat, qlng, qdist)
                    if _pbf_rail is not None and not _pbf_rail.empty:
                        graph_cache_set(key, _pbf_rail)
                        return _pbf_rail
                    # empty or None â fall through to Overpass below
        except ImportError:
            pass
        # ââ Overpass fallback ââââââââââââââââââââââââââââââââââââââââââââââ
        try:
            gdf = _ox_call_with_mirror_failover(
                ox.features_from_point,
                qpoint,
                tags={'railway': ['rail', 'light_rail', 'subway', 'tram', 'monorail']},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Rail fetch skipped: {e}')
            # Cache empty result for "no features" responses so we don't hit
            # Overpass on every render for cities with no railway=rail/subway
            # tagging (DC Metro, many Brazilian cities, etc.).  Transient
            # network / timeout errors are NOT cached so they retry next render.
            no_features = (
                'No matching features' in str(e)
                or 'InsufficientResponse' in type(e).__name__
            )
            if no_features:
                import geopandas as gpd
                empty = gpd.GeoDataFrame()
                graph_cache_set(key, empty)
                return empty
            return None
        graph_cache_set(key, gdf)
        return gdf

    # OSMnx fetch path — only runs when USE_PMTILES is false. The PMTiles
    # path populated streets_gdf + water + parks + rail at the top of this
    # function and left `g` as None to signal the street-draw branch.
    if not use_pmtiles:
        _log('Fetching streets + water + parks + rail (parallel, cache-aware)...')
        fetch_start = time.time()
        # max_workers=4 â one per fetch. OSM-RENDER-PIPELINE.md previously
        # warned against >3, but rail is a small Overpass query (railway lines
        # only) and the editor parity gap from skipping it was visible enough
        # to outweigh the marginal tarpit risk. If we see Overpass 429s in
        # production this is the first knob to dial back to 3 (rail queued).
        with ThreadPoolExecutor(max_workers=4) as pool:
            # Skip streets when the pview cache provides g_proj directly.
            f_streets = (None if _pview_cached is not None
                         else pool.submit(_fetch_streets))
            f_water   = pool.submit(_fetch_water)
            f_parks   = pool.submit(_fetch_parks)
            f_rail    = pool.submit(_fetch_rail)
            # Streets are mandatory â let any exception propagate (fails the
            # render exactly as the old sequential code did). Water / parks /
            # rail already swallow their own errors and return None.
            g     = (None if _pview_cached is not None else f_streets.result())
            water = f_water.result()
            parks = f_parks.result()
            rail  = f_rail.result()
        hit_summary = ','.join(f'{k}={"HIT" if v else "miss"}' for k, v in cache_hits.items())
        _log(f'Fetch phase {time.time() - fetch_start:.1f}s â {hit_summary} (qdist={qdist})')
    
        if _pview_cached is None and (g is None or len(g.nodes) == 0):
            raise RuntimeError('Failed to retrieve street network data.')

    # ââ 4. Setup figure ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    _log('Rendering figure...')
    _render_t0 = time.time()
    fig, ax = plt.subplots(figsize=(width_in, height_in), facecolor=theme['bg'])
    ax.set_facecolor(theme['bg'])
    ax.set_position((0.0, 0.0, 1.0, 1.0))
    if full_bleed:
        fig.subplots_adjust(left=0, right=1, top=1, bottom=0, wspace=0, hspace=0)

    # ââ 5. Project graph âââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if _pview_cached is not None:
        # pview cache hit: g_proj is pre-projected+pre-clipped.
        # Skip the 15-30 s ox.project_graph CRS conversion entirely.
        g_proj = _pview_cached
    elif g is not None:
        # ââ 5a. Pre-clip in WGS-84 BEFORE projection âââââââââââââââââââââ
        _pre_cd = int(crop_dist_param) if crop_dist_param is not None else dist
        _dlat = _pre_cd / 111_111 * 1.10
        _dlng = _pre_cd / (111_111 * math.cos(math.radians(point[0]))) * 1.10
        _lat0 = point[0] - _dlat
        _lat1 = point[0] + _dlat
        _lng0 = point[1] - _dlng
        _lng1 = point[1] + _dlng
        _pre_nodes = {
            n for n, d in g.nodes(data=True)
            if _lat0 <= d.get('y', point[0]) <= _lat1
            and _lng0 <= d.get('x', point[1]) <= _lng1
        }
        if 0 < len(_pre_nodes) < len(g.nodes):
            _log(f'WGS-84 pre-clip: {len(g.nodes)} â {len(_pre_nodes)} nodes '
                 f'(crop_dist={_pre_cd} m)')
            g = g.subgraph(_pre_nodes).copy()

        # ââ 5b. Project pre-clipped graph âââââââââââââââââââââââââââââââââ
        _proj_t0 = time.time()
    # OSMnx path: project the NetworkX graph into the local UTM zone, then
    # use that as the target CRS for water/parks/rail polygons so everything
    # lines up. PMTiles path: g is None — project everything to Web Mercator
    # (EPSG:3857) directly. Same visual result; both are metric CRSes that
    # matplotlib treats as equal-scale axes.
    g_proj = ox.project_graph(g) if g is not None else None
    target_crs = g_proj.graph['crs'] if g_proj is not None else 'EPSG:3857'
    if g_proj is not None:
        _log(f'project_graph: {time.time()-_proj_t0:.1f}s '
             f'({len(g_proj.nodes)} nodes, {g_proj.number_of_edges()} edges)')

    # ââ 6. Water layer âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if water is not None and not water.empty:
        water_polys = water[water.geometry.type.isin(['Polygon', 'MultiPolygon'])]
        if not water_polys.empty:
            try:
                water_polys = ox.projection.project_gdf(water_polys)
            except Exception:
                water_polys = water_polys.to_crs(target_crs)
            water_polys.plot(ax=ax, facecolor=theme['water'], edgecolor='none', zorder=0.5)

    # ââ 7. Parks layer âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if parks is not None and not parks.empty:
        parks_polys = parks[parks.geometry.type.isin(['Polygon', 'MultiPolygon'])]
        if not parks_polys.empty:
            try:
                parks_polys = ox.projection.project_gdf(parks_polys)
            except Exception:
                parks_polys = parks_polys.to_crs(target_crs)
            parks_polys.plot(ax=ax, facecolor=theme['parks'], edgecolor='none', zorder=0.8)

    # ââ 7b. Rail layer âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # Drawn ABOVE parks (zorder 0.9) but BELOW roads (zorder 1+) so road
    # overpasses cleanly cover rail crossings. Falls back to road_default
    # when the theme didn't include a 'rail' key (older themes, or callers
    # that haven't been updated to forward railColor) â keeps rail visible
    # in some form instead of crashing on KeyError.
    if rail is not None and not rail.empty:
        rail_lines = rail[rail.geometry.type.isin(['LineString', 'MultiLineString'])]
        if not rail_lines.empty:
            try:
                rail_lines = ox.projection.project_gdf(rail_lines)
            except Exception:
                rail_lines = rail_lines.to_crs(target_crs)
            rail_color = theme.get('rail', theme.get('road_default', theme['text']))
            rail_lines.plot(ax=ax, color=rail_color, linewidth=0.6, zorder=0.9)

    # ââ 8. Roads ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    # crop_dist override lets the caller (server.ts /render) align the visible
    # axes with the actual fetch radius (comp_dist), eliminating the empty
    # background area around the road graph on tight-bounds previews.
    effective_crop_dist = int(crop_dist_param) if crop_dist_param is not None else dist
    edge_width_scale = max(1.0, min(2.0, 300.0 / dpi))

    if streets_gdf is not None:
        # ââ 8 (PMTiles path). Draw streets via LineCollection ââââââââââââââââââ
        # We deliberately do NOT use GeoDataFrame.plot(color=[...list...]):
        # per-feature colouring via a list is undocumented and version-dependent.
        # LineCollection is the matplotlib primitive geopandas calls under the hood
        # and unambiguously accepts per-segment colors + linewidths arrays.
        hidden = _CLEAN_HIDDEN_TYPES if not minor_roads else frozenset()
        streets_proj = streets_gdf.to_crs(target_crs)
        segments = []
        seg_colors = []
        seg_widths = []
        for _idx, row in streets_proj.iterrows():
            hw = row.get('highway', 'unclassified')
            if isinstance(hw, list):
                hw = hw[0] if hw else 'unclassified'
            if hw in hidden:
                continue
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            color = _pmtiles_tier_color(hw, theme)
            width = _pmtiles_tier_width(hw) * edge_width_scale
            # A street feature may be a LineString or a MultiLineString.
            # Each component polyline becomes one entry in the collection,
            # inheriting the parent feature's colour + width.
            if geom.geom_type == 'LineString':
                segments.append(list(geom.coords))
                seg_colors.append(color)
                seg_widths.append(width)
            elif geom.geom_type == 'MultiLineString':
                for part in geom.geoms:
                    segments.append(list(part.coords))
                    seg_colors.append(color)
                    seg_widths.append(width)
            # Any other geometry type (Point / Polygon) is not a street; skip.

        if segments:
            lc = LineCollection(
                segments,
                colors=seg_colors,
                linewidths=seg_widths,
                capstyle='round',
                joinstyle='round',
                zorder=1,
            )
            ax.add_collection(lc)

        # Set explicit axis limits from the projected fetch bbox.
        # LineCollection has no auto-scale so matplotlib leaves the axes at
        # (0,1) without this. Transform the WGS-84 bbox corners to target_crs.
        from pyproj import Transformer
        _tr = Transformer.from_crs('EPSG:4326', target_crs, always_xy=True)
        _x0, _y0 = _tr.transform(bbox[0], bbox[1])  # SW corner (min_lng, min_lat)
        _x1, _y1 = _tr.transform(bbox[2], bbox[3])  # NE corner (max_lng, max_lat)
        ax.set_aspect('equal', adjustable='box')
        ax.set_xlim(_x0, _x1)
        ax.set_ylim(_y0, _y1)

    else:
        # ââ 8 (OSMnx path). crop + pre-clip + plot_graph ââââââââââââââââââââ
        crop_xlim, crop_ylim = get_crop_limits(g_proj, point, fig, effective_crop_dist)

        # ââ 8a. Pre-clip graph to crop window (major speedup for large-dist renders) ââ
        # ox.plot_graph() renders ALL fetched edges and relies on ax.set_xlim/ylim to
        # clip visually *after* rasterisation.  When dist >> effective_crop_dist the
        # filtering g_proj to nodes inside the crop bbox reduces edge count 5-8x
        # and cuts render time to ~3 s. A 5% border guard keeps edges that straddle
        # the crop boundary from vanishing. For /fulfill (effective_crop_dist ~ dist)
        # the filter is a near-no-op.
        _grd = max(abs(crop_xlim[1] - crop_xlim[0]), abs(crop_ylim[1] - crop_ylim[0])) * 0.05
        _crop_nodes = {
            n for n, d in g_proj.nodes(data=True)
            if crop_xlim[0] - _grd <= d.get('x', 0) <= crop_xlim[1] + _grd
            and crop_ylim[0] - _grd <= d.get('y', 0) <= crop_ylim[1] + _grd
        }
        if len(_crop_nodes) < len(g_proj.nodes):
            g_proj = g_proj.subgraph(_crop_nodes).copy()

        # ââ Write pview cache for future requests ââââââââââââââââââââ
        if _pview_cached is None:
            graph_cache_set(pview_key, g_proj)
            _log(f'pview cached ({pview_key[:16]}â¦, '
                 f'{len(g_proj.nodes)} nodes, {g_proj.number_of_edges()} edges)')

        if params.get('pview_only'):
            _log('pview_only=True â returning after cache warm (skipping PNG)')
            return b''

        edge_colors = get_edge_colors(g_proj, theme, minor_roads)
        edge_widths = [w * edge_width_scale for w in get_edge_widths(g_proj, minor_roads)]

        _plot_t0 = time.time()
        ox.plot_graph(
            g_proj, ax=ax,
            bgcolor=theme['bg'],
            node_size=0,
            edge_color=edge_colors,
            edge_linewidth=edge_widths,
            show=False,
            close=False,
        )
        _log(f'plot_graph: {time.time()-_plot_t0:.1f}s '
             f'({g_proj.number_of_nodes()} nodes, {g_proj.number_of_edges()} edges)')
        ax.set_aspect('equal', adjustable='box')
        ax.set_xlim(crop_xlim)
        ax.set_ylim(crop_ylim)

    # ââ 9. Gradient fades (only if not full-bleed / no_fade) âââââââââââââââââ
    if not no_fade:
        create_gradient_fade(ax, theme['gradient_color'], location='bottom', zorder=10)
        create_gradient_fade(ax, theme['gradient_color'], location='top', zorder=10)

    # ââ 10. Typography âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if show_text:
        scale = min(height_in, width_in) / 12.0
        fonts = load_fonts()

        # City label â single-space join for letter-spacing parity with the
        # studio editor. Original maptoposter aesthetic used '  '.join (two
        # spaces) which roughly doubles the rendered width; the editor moved
        # to CSS letter-spacing: 0.45em on .mvs-poster-city (studio PR #154
        # â "Removes Array.from().join('  ') that tripled string length and
        # clipped names"). matplotlib has no letter-spacing primitive, so
        # ' '.join is the closest visual match: WAS HING TON stays wide-
        # tracked but no longer overflows the poster on 10-char names like
        # WASHINGTON. Non-Latin scripts (Cyrillic, CJK) keep their natural
        # glyph spacing, also matching the editor's isLatinScript guard.
        spaced_city = (' '.join(list(display_city.upper()))
                       if is_latin_script(display_city)
                       else display_city)

        # 60 * scale rendered Playfair 700 + ' '.join letter-spacing at
        # ~95 % of poster width for 10-char names like WASHINGTON (production
        # 2026-06-16 screenshot â print preview's "WASHINGTON" stretched
        # corner-to-corner while the editor's MapLibre rendering sat at
        # ~50 % width). matplotlib has no letter-spacing primitive so the
        # spaced-glyph approach is the only way to match the editor's
        # CSS letter-spacing aesthetic, but the size factor was tuned for the
        # original two-space join and was never lowered after PR #154 moved
        # to single-space join. 38 lands the spaced glyphs at ~55 % poster
        # width on a 12.5Ã16.7 in classic â parity with the editor's
        # visual weight. n_chars > 10 still shrinks proportionally so very
        # long names (SAN FRANCISCO, JOHANNESBURG) stay inside the band.
        base_main = 24 * scale
        n_chars = len(display_city)
        adjusted_size = (max(base_main * (10 / n_chars), 10 * scale)
                         if n_chars > 10 else base_main)

        def fp(key, size):
            if fonts:
                return FontProperties(fname=fonts[key], size=size)
            family = 'serif' if key == 'bold' else ('monospace' if key == 'regular' else 'sans-serif')
            weight = 'bold' if key == 'bold' else 'normal'
            return FontProperties(family=family, weight=weight, size=size)

        ax.text(0.5, 0.14, spaced_city,
                transform=ax.transAxes, color=theme['text'],
                ha='center', fontproperties=fp('bold', adjusted_size), zorder=11)

        ax.text(0.5, 0.10, display_country.upper(),
                transform=ax.transAxes, color=theme['text'],
                ha='center', fontproperties=fp('light', 22 * scale), zorder=11)

        lat_v, lon_v = point
        hem_ns = 'N' if lat_v >= 0 else 'S'
        hem_ew = 'E' if lon_v >= 0 else 'W'
        coords_str = f'{abs(lat_v):.4f}Â° {hem_ns} / {abs(lon_v):.4f}Â° {hem_ew}'

        ax.text(0.5, 0.07, coords_str,
                transform=ax.transAxes, color=theme['text'], alpha=0.7,
                ha='center', fontproperties=fp('regular', 14 * scale), zorder=11)

        ax.plot([0.4, 0.6], [0.125, 0.125],
                transform=ax.transAxes,
                color=theme['text'], linewidth=1 * scale, zorder=11)

        ax.text(0.98, 0.02, 'Â© OpenStreetMap contributors',
                transform=ax.transAxes, color=theme['text'], alpha=0.5,
                ha='right', va='bottom', fontproperties=fp('light', 8), zorder=11)

    # ââ 11. Save to buffer âââââââââââââââââââââââââââââââââââââââââââââââââââ
    buf = io.BytesIO()
    save_kwargs: dict = {'facecolor': theme['bg'], 'dpi': dpi}

    if full_bleed:
        # bbox_inches=None skips tight-layout and honours our subplots_adjust(0,0,1,1)
        save_kwargs['bbox_inches'] = None
    else:
        save_kwargs['bbox_inches'] = 'tight'
        save_kwargs['pad_inches'] = 0.05

    fig.savefig(buf, format='png', **save_kwargs)
    plt.close(fig)

    buf.seek(0)
    data = buf.read()
    _log(f'Done â {len(data):,} bytes ({dpi} DPI, {width_in}Ã{height_in}in)')
    return data


# ââ Entry point âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

if __name__ == '__main__':
    try:
        raw = sys.stdin.read()
        params = json.loads(raw)
        png_bytes = render(params)
        output_path = params.get('output_path')
        if output_path:
            with open(output_path, 'wb') as f:
                f.write(png_bytes)
            print(json.dumps({'success': True, 'path': output_path, 'size': len(png_bytes)}))
        else:
            sys.stdout.buffer.write(png_bytes)
    except Exception as exc:
        _log(f'FATAL: {exc}')
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'success': False, 'error': str(exc)}))
        sys.exit(1)
