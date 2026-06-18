#!/usr/bin/env python3
"""
mapvibe_render.py — MapVibe OSM render adapter
===============================================
Reads JSON params from stdin, renders a city map poster using
OSMnx + matplotlib, writes PNG bytes to stdout (or a file).

MapVibe customisations vs upstream maptoposter:
  • full_bleed  — no padding, axes fill the entire figure (default True)
  • no_fade     — skip top/bottom gradient vignettes (default True)
  • minor_roads — render residential/service/footway roads (default False)
  • dpi         — 400 for all standard sizes; caller sets 300+ for archival
  • network     — 'drive' by default (faster, cleaner than 'all')

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
import threading
import tempfile
import struct

# ── Headless matplotlib — MUST be set before any pyplot import ─────────────
import matplotlib
matplotlib.use('Agg')
import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
import osmnx as ox

# ── Overpass mirror failover ──────────────────────────────────────────────────
# OSMnx defaults to overpass-api.de which has been observed refusing
# connections (Errno 111) under sustained load — production 2026-06-17 logs:
# every render burning 60 s + then dying because the primary mirror was
# unreachable. Probe alternates at process start and pick the first one whose
# TCP socket accepts a handshake; this Python subprocess is spawned per render
# so the probe runs once per request (worst case +2 s on a cold render when
# the primary is down). Override the candidate list via the OVERPASS_URLS env
# var (comma-separated) when adding/reordering mirrors.

def _select_overpass_mirror() -> str:
    import socket
    from urllib.parse import urlparse

    raw = os.environ.get(
        'OVERPASS_URLS',
        'https://overpass-api.de/api/interpreter,'
        'https://overpass.kumi.systems/api/interpreter,'
        'https://overpass.osm.ch/api/interpreter'
    )
    candidates = [s.strip() for s in raw.split(',') if s.strip()]
    for url in candidates:
        host = urlparse(url).hostname
        port = urlparse(url).port or 443
        if not host:
            continue
        try:
            with socket.create_connection((host, port), timeout=2):
                return url
        except Exception:
            continue
    # All mirrors unreachable — fall through to the first and let the actual
    # fetch raise a meaningful error instead of swallowing it here.
    return candidates[0] if candidates else 'https://overpass-api.de/api/interpreter'


_OVERPASS_URL = _select_overpass_mirror()
ox.settings.overpass_url = _OVERPASS_URL
print(f'[mapvibe_render] Overpass mirror: {_OVERPASS_URL}', file=sys.stderr, flush=True)
from geopy.geocoders import Nominatim
from matplotlib.font_manager import FontProperties

# ── Silence noisy osmnx / shapely logs ─────────────────────────────────────
import logging
logging.getLogger('osmnx').setLevel(logging.WARNING)

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
THEMES_DIR    = os.path.join(SCRIPT_DIR, 'themes')
FONTS_DIR     = os.path.join(SCRIPT_DIR, 'fonts')
CACHE_DIR     = os.environ.get('CACHE_DIR', '/tmp/mapvibe-osm-cache')
os.makedirs(CACHE_DIR, exist_ok=True)

# ── Cache helpers ────────────────────────────────────────────────────────────

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

# ── Graph cache (TTL + LRU eviction) ─────────────────────────────────────────
# OSMnx fetches (street network, water polygons, parks) are the dominant time
# cost of a render — even parallelised they're ~4-6 s of Overpass round trips
# per render. Caching them by quantized (lat, lng, dist, filter) reduces a hot
# re-render (theme swap, frame change, pan-back) to essentially the matplotlib
# draw cost (~1-3 s).
#
# Design:
#   - Storage: pickle to /tmp/mapvibe-osm-cache/ (same dir as the geocode
#     cache). Ephemeral per Railway container, which is fine — cache rebuilds
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
#     A smaller real comp_dist served from a larger cached fetch is safe —
#     matplotlib crops to the requested view.
_GRAPH_CACHE_TTL_S      = 7 * 24 * 3600          # 7 days
_GRAPH_CACHE_MAX_BYTES  = 512 * 1024 * 1024      # 512 MB

def _graph_cache_quantize(lat: float, lng: float, comp_dist: float) -> tuple:
    """Quantize the (lat, lng, comp_dist) tuple for cache key derivation AND
    for the actual Overpass fetch. Returning both so the caller fetches at
    the bucket centre/radius, not the raw values — that's what guarantees
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
    Lookup order: disk L1 (~1s) → R2 L2 graph (~2s) → local PBF (~5-10s) →
                  R2 PBF download (~15-30s) → None (Overpass fallback).
    _pbf_context: optional dict with keys lat, lon, dist, minor_roads — when
    present, enables the PBF tier (L3/L4) for street-graph lookups.
    Never raises — any error is treated as a cache miss."""
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
    r2_cache_set(key, value)   # daemon thread — never blocks render


def _graph_cache_write_disk(key: str, value) -> None:
    """Atomically write the entry (tmp + rename) and run an LRU eviction pass
    so a long-running container can't blow past the disk budget. Never raises —
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
        # Oldest first — drop until we're back under budget.
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



# ── R2 graph cache + PBF tier (Phase 1 + 2) ─────────────────────────────────
# Phase 1: graph pickles in R2 (L2) survive Railway restarts.
# Phase 2: Geofabrik PBFs seeded to R2 (~55 GB); pyrosm extracts any city or
#          village locally, eliminating Overpass for all seeded regions.
# Lookup order:
#   disk L1 (~1s) → R2 L2 graph (~2s) → local PBF (~5-10s) →
#   R2 PBF download (~15-30s, warms local PBF) → Overpass (~20-65s)
# R2 writes run in daemon threads — they NEVER block a render.
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
            _log(f'R2 client init failed — R2 disabled: {e}')
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
    """Upload a graph entry to R2 in a background daemon thread."""
    def _upload():
        client = _get_r2_client()
        if client is None:
            return
        try:
            data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
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




# ── PBF cache — L3/L4 Geofabrik-based tier (Phase 2) ─────────────────────────
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

# Lazy-loaded region table — loaded once on first PBF lookup
_pbf_regions = None
_pbf_regions_lock = threading.Lock()


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
        _log('PBF region table not found — PBF tier disabled')
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
    candidates.sort(key=lambda r: r.get('size_mb', 9999))
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
    Check order: local disk (fresh) → R2 download → Geofabrik direct download.
    Never raises."""
    region_key = region['region_key']
    local_path = _pbf_local_path(region_key)

    # Already on disk and fresh
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
        _log('pyrosm not installed — PBF extraction unavailable')
        return None
    try:
        # Bounding box: dist metres → degrees with 50% buffer
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
        if G is None or len(G.nodes) == 0:
            return None
        _log(f'PBF extraction OK: {len(G.nodes)} nodes, {len(G.edges)} edges')
        return G
    except Exception as e:
        _log(f'PBF graph extraction failed: {e}')
        return None


def _try_pbf_extraction(lat: float, lon: float, dist: int,
                        minor_roads: bool, cache_key: str) -> object:
    """Full PBF tier: find region → ensure local PBF → extract graph.
    On success, writes the graph to L1+L2 (graph cache) and returns it.
    Returns None on any failure so caller falls through to Overpass.

    IMPORTANT: pyrosm availability is checked FIRST — before any PBF download.
    Without this guard, _ensure_pbf_local eagerly downloads the full regional
    PBF (up to 4 GB) only to discover pyrosm is absent, wasting 40-60 s
    before falling through to Overpass and making every cold village render
    pay a full PBF download cost for zero benefit.
    """
    # Guard: bail immediately if pyrosm is not installed.
    # This is the critical check — it must precede _ensure_pbf_local.
    try:
        import pyrosm  # noqa: F401
    except ImportError:
        _log('pyrosm not installed — skipping PBF tier (Overpass fallback)')
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


# ── Theme loading ─────────────────────────────────────────────────────────────

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

# ── Script detection ──────────────────────────────────────────────────────────

def is_latin_script(text: str) -> bool:
    if not text:
        return True
    total_alpha = sum(1 for c in text if c.isalpha())
    if total_alpha == 0:
        return True
    latin_count = sum(1 for c in text if c.isalpha() and ord(c) < 0x250)
    return (latin_count / total_alpha) > 0.8

# ── Road helpers ──────────────────────────────────────────────────────────────

# Lowest road tier — service / track / footway / etc. Always hidden in Clean,
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
#   road-secondary       → secondary, secondary_link
#   road-minor-mid       → tertiary, tertiary_link
#   road-minor-low       → residential family (already in _MINOR_ROAD_TYPES)
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
        # Clean mode hides secondary / tertiary / residential family — matches
        # the editor's roadDetailMode='arteries' which toggles the same three
        # layer families together. Detailed mode falls through and tiers are
        # coloured by their highway class below.
        if not minor_roads and hw in _CLEAN_HIDDEN_TYPES:
            colors.append('#00000000')
            continue
        if hw in ('motorway', 'motorway_link'):
            colors.append(theme['road_motorway'])
        elif hw in ('trunk', 'trunk_link', 'primary', 'primary_link'):
            colors.append(theme['road_primary'])
        elif hw in ('secondary', 'secondary_link'):
            colors.append(theme['road_secondary'])
        elif hw in ('tertiary', 'tertiary_link'):
            colors.append(theme['road_tertiary'])
        else:
            colors.append(theme.get('road_residential', theme.get('road_default', '#888888')))
    return colors

def get_edge_widths(g, minor_roads: bool) -> list:
    widths = []
    for _u, _v, data in g.edges(data=True):
        hw = _highway(data)
        # Same Clean / Detailed semantics as get_edge_colors — keep the two
        # hide-sets in lockstep so widths and colours never disagree on which
        # tier is drawn.
        if not minor_roads and hw in _CLEAN_HIDDEN_TYPES:
            widths.append(0.0)
            continue
        if hw in ('motorway', 'motorway_link'):
            widths.append(1.2)
        elif hw in ('trunk', 'trunk_link', 'primary', 'primary_link'):
            widths.append(1.0)
        elif hw in ('secondary', 'secondary_link'):
            widths.append(0.8)
        elif hw in ('tertiary', 'tertiary_link'):
            widths.append(0.6)
        else:
            widths.append(0.4)
    return widths

# ── Gradient fade ─────────────────────────────────────────────────────────────

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

# ── Crop limits ───────────────────────────────────────────────────────────────

def get_crop_limits(g_proj, point: tuple, fig, dist: int):
    """
    Compute matplotlib axis limits centered on the user-supplied geographic
    point. Returns (xlim, ylim) in the projected graph's CRS units (metres
    for the UTM projections OSMnx picks by default).

    point is (lat, lng) — WGS84 degrees.
    g_proj is a *projected* graph: its node x/y are large metre values, not
    lat/lng. Earlier code called
        ox.distance.nearest_nodes(g_proj, point[1], point[0])
    which passed degree-scale numbers (e.g. (-77, 39)) into a metre-scale
    graph (e.g. (323420, 4307180)). nearest_nodes therefore returned the
    node with the smallest cartesian distance to (-77, 39) — effectively a
    random node near the projection origin, several kilometres away from
    the user's actual location. That offset is why preview renders looked
    drifted (cluster in the upper-half of the figure instead of centred).

    Fix: project (lat, lng) into the graph's CRS first, then use those
    coordinates directly as the centre. No need to snap to a graph node —
    matplotlib's xlim/ylim accept any float and the crop is purely a view
    decision, not a data lookup.
    """
    cx = cy = None
    try:
        from shapely.geometry import Point as _Point
        graph_crs = g_proj.graph.get('crs', 'EPSG:4326')
        # shapely Point uses (x, y) ⇒ (lng, lat) in WGS84.
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

# ── Geocoding ─────────────────────────────────────────────────────────────────

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

# ── Fonts ─────────────────────────────────────────────────────────────────────

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

# ── Logging ───────────────────────────────────────────────────────────────────

def _log(msg: str):
    print(f'[mapvibe_render] {msg}', file=sys.stderr, flush=True)

# ── Main render function ──────────────────────────────────────────────────────

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
    show_text       = bool(params.get('show_text', True))
    full_bleed      = bool(params.get('full_bleed', True))
    no_fade         = bool(params.get('no_fade', True))
    minor_roads     = bool(params.get('minor_roads', False))
    network_type    = params.get('network_type', 'drive')
    # crop_dist — optional override for the matplotlib axis half-extent.
    # Default (None) keeps the legacy behaviour: get_crop_limits is called
    # with `dist`, which is the original /fulfill contract.
    # /render passes crop_dist=userOsmDist so the visible axes equal the
    # circle OSMnx actually fetched — without this override the road graph
    # appears as a tiny cluster in a sea of background colour because
    # comp_dist = dist*(max/min)/4 is always 3-4× smaller than dist.
    crop_dist_param = params.get('crop_dist')

    # ── 1. Resolve coordinates ───────────────────────────────────────────────
    point = None
    if lat is not None and lng is not None:
        point = (float(lat), float(lng))
    if point is None and city and country:
        point = get_coordinates(city, country)
    if point is None:
        raise ValueError(f'Cannot resolve coordinates for city={city!r}, country={country!r}')

    _log(f'{display_city}, {display_country} @ {point[0]:.4f},{point[1]:.4f}  '
         f'dist={dist}m  {width_in}×{height_in}in  {dpi}DPI  '
         f'full_bleed={full_bleed}  no_fade={no_fade}  minor_roads={minor_roads}')

    # ── 2. Load theme ────────────────────────────────────────────────────────
    theme = theme_override if isinstance(theme_override, dict) else load_theme(theme_name)

    # ── 3. Fetch OSM data ────────────────────────────────────────────────────
    # Compensated dist ensures the map fills poster aspect ratio without clipping
    comp_dist = dist * (max(height_in, width_in) / min(height_in, width_in)) / 4

    # The street / water / parks fetches are three independent Overpass round
    # trips. Previously they ran sequentially (sum of three latencies ≈ 8-12 s
    # on a busy Overpass mirror — the single largest chunk of the ~20 s preview
    # render). They share no state and OSMnx's `requests` calls release the
    # GIL during socket I/O, so a 3-worker ThreadPoolExecutor genuinely
    # overlaps them; the render now waits on the MAX of the three (~4-6 s).
    #
    # On top of that, each fetch consults the on-disk graph cache (TTL 7 days,
    # LRU-bounded 512 MB). A repeat render of the same location — theme swap,
    # frame change, pan-back — skips Overpass entirely and goes straight to
    # matplotlib, taking total render time to ~1-3 s. The cache key is
    # quantized (lat/lng 4dp ≈ 11 m, comp_dist rounded UP to 1 km) and we
    # ALWAYS fetch at the quantized point / radius so any later request that
    # maps to the same bucket is guaranteed to be covered. Serving a 4500 m
    # request from a cached 5000 m fetch is safe — matplotlib crops the view.
    from concurrent.futures import ThreadPoolExecutor

    qlat, qlng, qdist  = _graph_cache_quantize(point[0], point[1], comp_dist)
    qpoint             = (qlat, qlng)
    cache_hits         = {"streets": False, "water": False, "parks": False, "rail": False}

    def _fetch_streets():
        # Streets are the only fetch whose filter depends on minor_roads, so
        # the key carries that bit — Clean vs Detailed get separate entries.
        filter_tag = 'minor' if minor_roads else 'major'
        key = _graph_cache_key('streets', qlat, qlng, qdist, filter_tag, network_type)
        cached = graph_cache_get(key, _pbf_context={
            'lat': qlat, 'lon': qlng, 'dist': qdist,
            'minor_roads': minor_roads, 'cache_key': key,
        })
        if cached is not None:
            cache_hits['streets'] = True
            return cached
        if minor_roads:
            # Full drive network — residential/service/etc. are drawn.
            g_ = ox.graph_from_point(qpoint, dist=qdist, network_type=network_type)
        else:
            # Clean mode draws only motorway / trunk / primary (matches editor's
            # roadDetailMode='arteries' which hides road-secondary, road-minor-mid
            # and road-minor-low). Anything below the arterial tier is painted
            # transparent in get_edge_colors / get_edge_widths anyway, so we save
            # the Overpass bandwidth by not downloading them in the first place.
            # The regex matches *_link suffixes for free (no anchors).
            major_roads_filter = '["highway"~"motorway|trunk|primary"]'
            g_ = ox.graph_from_point(qpoint, dist=qdist, custom_filter=major_roads_filter)
        graph_cache_set(key, g_)
        return g_

    def _fetch_water():
        key = _graph_cache_key('water', qlat, qlng, qdist)
        cached = graph_cache_get(key)
        if cached is not None:
            cache_hits['water'] = True
            return cached
        try:
            gdf = ox.features_from_point(
                qpoint,
                tags={'natural': ['water', 'bay', 'strait'], 'waterway': 'riverbank'},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Water fetch skipped: {e}')
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
            gdf = ox.features_from_point(
                qpoint,
                tags={'leisure': 'park', 'landuse': 'grass'},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Parks fetch skipped: {e}')
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
        try:
            gdf = ox.features_from_point(
                qpoint,
                tags={'railway': ['rail', 'light_rail', 'subway', 'tram', 'monorail']},
                dist=qdist,
            )
        except Exception as e:
            _log(f'Rail fetch skipped: {e}')
            return None
        graph_cache_set(key, gdf)
        return gdf

    _log('Fetching streets + water + parks + rail (parallel, cache-aware)...')
    fetch_start = time.time()
    # max_workers=4 — one per fetch. OSM-RENDER-PIPELINE.md previously
    # warned against >3, but rail is a small Overpass query (railway lines
    # only) and the editor parity gap from skipping it was visible enough
    # to outweigh the marginal tarpit risk. If we see Overpass 429s in
    # production this is the first knob to dial back to 3 (rail queued).
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_streets = pool.submit(_fetch_streets)
        f_water   = pool.submit(_fetch_water)
        f_parks   = pool.submit(_fetch_parks)
        f_rail    = pool.submit(_fetch_rail)
        # Streets are mandatory — let any exception propagate (fails the
        # render exactly as the old sequential code did). Water / parks /
        # rail already swallow their own errors and return None.
        g     = f_streets.result()
        water = f_water.result()
        parks = f_parks.result()
        rail  = f_rail.result()
    hit_summary = ','.join(f'{k}={"HIT" if v else "miss"}' for k, v in cache_hits.items())
    _log(f'Fetch phase {time.time() - fetch_start:.1f}s — {hit_summary} (qdist={qdist})')

    if g is None or len(g.nodes) == 0:
        raise RuntimeError('Failed to retrieve street network data.')

    # ── 4. Setup figure ──────────────────────────────────────────────────────
    _log('Rendering figure...')
    fig, ax = plt.subplots(figsize=(width_in, height_in), facecolor=theme['bg'])
    ax.set_facecolor(theme['bg'])
    ax.set_position((0.0, 0.0, 1.0, 1.0))
    if full_bleed:
        fig.subplots_adjust(left=0, right=1, top=1, bottom=0, wspace=0, hspace=0)

    # ── 5. Project graph ─────────────────────────────────────────────────────
    g_proj = ox.project_graph(g)

    # ── 6. Water layer ───────────────────────────────────────────────────────
    if water is not None and not water.empty:
        water_polys = water[water.geometry.type.isin(['Polygon', 'MultiPolygon'])]
        if not water_polys.empty:
            try:
                water_polys = ox.projection.project_gdf(water_polys)
            except Exception:
                water_polys = water_polys.to_crs(g_proj.graph['crs'])
            water_polys.plot(ax=ax, facecolor=theme['water'], edgecolor='none', zorder=0.5)

    # ── 7. Parks layer ───────────────────────────────────────────────────────
    if parks is not None and not parks.empty:
        parks_polys = parks[parks.geometry.type.isin(['Polygon', 'MultiPolygon'])]
        if not parks_polys.empty:
            try:
                parks_polys = ox.projection.project_gdf(parks_polys)
            except Exception:
                parks_polys = parks_polys.to_crs(g_proj.graph['crs'])
            parks_polys.plot(ax=ax, facecolor=theme['parks'], edgecolor='none', zorder=0.8)

    # ── 7b. Rail layer ───────────────────────────────────────────────────────
    # Drawn ABOVE parks (zorder 0.9) but BELOW roads (zorder 1+) so road
    # overpasses cleanly cover rail crossings. Falls back to road_default
    # when the theme didn't include a 'rail' key (older themes, or callers
    # that haven't been updated to forward railColor) — keeps rail visible
    # in some form instead of crashing on KeyError.
    if rail is not None and not rail.empty:
        rail_lines = rail[rail.geometry.type.isin(['LineString', 'MultiLineString'])]
        if not rail_lines.empty:
            try:
                rail_lines = ox.projection.project_gdf(rail_lines)
            except Exception:
                rail_lines = rail_lines.to_crs(g_proj.graph['crs'])
            rail_color = theme.get('rail', theme.get('road_default', theme['text']))
            rail_lines.plot(ax=ax, color=rail_color, linewidth=0.6, zorder=0.9)

    # ── 8. Roads ─────────────────────────────────────────────────────────────
    edge_colors = get_edge_colors(g_proj, theme, minor_roads)
    edge_widths = get_edge_widths(g_proj, minor_roads)
    # Edge widths were calibrated for /fulfill's 300-400 DPI output. At /render's
    # 96 DPI preview path a 0.4 pt residential line is only ~0.5 px wide — sub-
    # pixel, anti-aliased into a faint smudge or vanished entirely. Result: Clean
    # (4 tiers visible) and Detailed (5 tiers — but the new 5th is invisible)
    # look identical in the preview modal even though the toggle is wired end-
    # to-end. Scale all widths by (300 / dpi) when dpi < 300 so the smallest
    # tier crosses the 1 px threshold and the road-detail hierarchy stays
    # readable at preview resolution. Capped at >= 1 so /fulfill at 300/400 DPI
    # renders byte-identical to before.
    # Cap the scale at 2.0× — the original 300/96 = 3.125× factor produced
    # ~954 KB PNGs (3.5× the pre-patch baseline of ~268 KB) because thicker
    # lines mean dramatically more dark pixels for PNG to encode. On flaky
    # mobile networks that download could take 30+ s — long enough that the
    # print-preview modal's spinner appeared to hang. At 2.0× residential
    # still lands at 0.8 pt = 1.07 px (above the 1 px visibility threshold)
    # while PNG output stays around 500 KB. Clamped at >= 1 so /fulfill at
    # 300/400 DPI keeps renders byte-identical.
    edge_width_scale = max(1.0, min(2.0, 300.0 / dpi))
    edge_widths = [w * edge_width_scale for w in edge_widths]
    # crop_dist override lets the caller (server.ts /render) align the visible
    # axes with the actual fetch radius (comp_dist), eliminating the empty
    # background area around the road graph on tight-bounds previews.
    effective_crop_dist = int(crop_dist_param) if crop_dist_param is not None else dist
    crop_xlim, crop_ylim = get_crop_limits(g_proj, point, fig, effective_crop_dist)

    ox.plot_graph(
        g_proj, ax=ax,
        bgcolor=theme['bg'],
        node_size=0,
        edge_color=edge_colors,
        edge_linewidth=edge_widths,
        show=False,
        close=False,
    )
    ax.set_aspect('equal', adjustable='box')
    ax.set_xlim(crop_xlim)
    ax.set_ylim(crop_ylim)

    # Re-assert full-bleed position after plot_graph may have adjusted it
    if full_bleed:
        ax.set_position((0.0, 0.0, 1.0, 1.0))

    # ── 9. Gradient fades (only if not full-bleed / no_fade) ─────────────────
    if not no_fade:
        create_gradient_fade(ax, theme['gradient_color'], location='bottom', zorder=10)
        create_gradient_fade(ax, theme['gradient_color'], location='top', zorder=10)

    # ── 10. Typography ───────────────────────────────────────────────────────
    if show_text:
        scale = min(height_in, width_in) / 12.0
        fonts = load_fonts()

        # City label — single-space join for letter-spacing parity with the
        # studio editor. Original maptoposter aesthetic used '  '.join (two
        # spaces) which roughly doubles the rendered width; the editor moved
        # to CSS letter-spacing: 0.45em on .mvs-poster-city (studio PR #154
        # — "Removes Array.from().join('  ') that tripled string length and
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
        # 2026-06-16 screenshot — print preview's "WASHINGTON" stretched
        # corner-to-corner while the editor's MapLibre rendering sat at
        # ~50 % width). matplotlib has no letter-spacing primitive so the
        # spaced-glyph approach is the only way to match the editor's
        # CSS letter-spacing aesthetic, but the size factor was tuned for the
        # original two-space join and was never lowered after PR #154 moved
        # to single-space join. 38 lands the spaced glyphs at ~55 % poster
        # width on a 12.5×16.7 in classic — parity with the editor's
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
        coords_str = f'{abs(lat_v):.4f}° {hem_ns} / {abs(lon_v):.4f}° {hem_ew}'

        ax.text(0.5, 0.07, coords_str,
                transform=ax.transAxes, color=theme['text'], alpha=0.7,
                ha='center', fontproperties=fp('regular', 14 * scale), zorder=11)

        ax.plot([0.4, 0.6], [0.125, 0.125],
                transform=ax.transAxes,
                color=theme['text'], linewidth=1 * scale, zorder=11)

        ax.text(0.98, 0.02, '© OpenStreetMap contributors',
                transform=ax.transAxes, color=theme['text'], alpha=0.5,
                ha='right', va='bottom', fontproperties=fp('light', 8), zorder=11)

    # ── 11. Save to buffer ───────────────────────────────────────────────────
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
    _log(f'Done — {len(data):,} bytes ({dpi} DPI, {width_in}×{height_in}in)')
    return data


# ── Entry point ───────────────────────────────────────────────────────────────

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
