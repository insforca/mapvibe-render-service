"""
python/pmtiles_reader.py

Production-grade PMTiles fetch layer. Reads the planet archive from R2 over
HTTP range requests (authenticated S3 signature v4 via boto3) and decodes
Mapbox Vector Tiles into GeoDataFrames the existing mapvibe_render.py draw
code can consume.

Replaces the OSMnx graph_from_point + features_from_point + per-region PBF
fallback path that hit:
  - Overpass per-IP rate limits (production 2026-06-16 logs)
  - 500 MB PBF L4 download crashes (Bangalore / Lagos)
  - 60-90 s cold fetches in dense metros (DC at 9 km radius)

Now: range requests over R2 against a single 136 GB archive. Per-render
fetch is 10-50 tiles × ~20 KB each = ~500 KB total. Sub-second on warm
TCP. Architecture-immune to Overpass outages.

Validated against the spike's render-comparison.py for DC at z14 (four-
panel comparison passed; tile-grid overlay confirmed data continuity
across z14 boundaries).

Env vars required (all set on Railway):
  PMTILES_BUCKET         e.g. mapvibe-tiles
  PMTILES_KEY            e.g. planet.pmtiles/planet.pmtiles
  PMTILES_ENDPOINT_URL   e.g. https://<cf-account>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID       Cloudflare R2 access key (S3 API token)
  R2_SECRET_ACCESS_KEY   Cloudflare R2 secret
"""

from __future__ import annotations

import logging
import hashlib
import math
import os
import pathlib
import time
from functools import lru_cache
from typing import Iterable, Optional

import gzip

import boto3
import geopandas as gpd
import mapbox_vector_tile as mvt
import shapely.geometry as sgeom
from botocore.config import Config as BotoConfig
from pmtiles.reader import Reader as PMReader

_log = logging.getLogger("mapvibe_render.pmtiles")


# ── Protomaps basemaps schema mapping ──────────────────────────────────────────
# planet.pmtiles is the Protomaps / planetiler basemaps build (confirmed via the
# archive's own metadata: planetiler:buildtime / planetiler:githash). Its vector
# layers are NOT the names this module originally assumed
# ('streets' / 'parks' / 'rail'); they are:
#   roads, water, landuse, landcover, places, buildings, boundaries, earth, pois
# Streets live in `roads`; the per-feature OSM highway value is carried in the
# `kind_detail` field (e.g. kind='highway', kind_detail='motorway'), with `kind`
# as the coarse class. The draw code in mapvibe_render.py keys off a `highway`
# attribute, so when add_highway=True we synthesise it from kind_detail (falling
# back to a representative value per coarse kind). This single helper bridges the
# Protomaps schema onto the OSM-tag-shaped draw path.
_PROTOMAPS_KIND_TO_HIGHWAY = {
    "highway": "motorway",
    "major_road": "primary",
    "medium_road": "secondary",
    "minor_road": "residential",
    "path": "path",
}


# ── Errors ────────────────────────────────────────────────────────────────────


class PMTilesFetchError(RuntimeError):
    """
    Raised when a tile read against R2 *fails* — bad credentials, wrong
    PMTILES_ENDPOINT_URL, missing bucket-read permission, or a transient
    network error that exhausted boto3's retry budget.

    This is deliberately distinct from a *missing* tile (the pmtiles reader
    returns None for those, no exception). The difference matters: a missing
    tile is normal sparse-coverage and is skipped silently, whereas a fetch
    error means the archive is unreachable and EVERY tile will fail the same
    way — which previously surfaced as the misleading "PMTiles returned no
    street data" (looks like a coverage gap, is actually a config problem).
    """

    def __init__(self, z: int, x: int, y: int, cause: BaseException):
        self.z, self.x, self.y = z, x, y
        self.cause = cause
        super().__init__(f"R2 fetch failed for tile z={z} x={x} y={y}: {cause}")


# ── Module-level singleton ────────────────────────────────────────────────────
# A single PMTilesR2Reader per process is correct: the PMTiles header + root
# directory are fetched once and cached forever (they don't change for a
# given archive version), and the boto3 client pool stays warm across renders.
# Recreated only if the env var pointing at the archive changes (production
# only flips PMTILES_KEY during a cut-over).

_reader_singleton: Optional["PMTilesR2Reader"] = None


def get_reader() -> "PMTilesR2Reader":
    global _reader_singleton
    if _reader_singleton is None:
        _reader_singleton = PMTilesR2Reader.from_env()
    return _reader_singleton


# ── Disk-cache constants ──────────────────────────────────────────────────────

#: Root directory for the on-disk PMTiles byte-range cache.
_DISK_CACHE_DIR: pathlib.Path = pathlib.Path("/tmp/mapvibe-pmtiles-cache")

#: Maximum total on-disk cache size in bytes (default 512 MB, override via env).
_DISK_CACHE_MAX: int = int(os.getenv("PMTILES_CACHE_MAX_MB", "512")) * 1024 * 1024

#: How many __call__ invocations trigger an opportunistic LRU eviction pass.
_EVICT_EVERY: int = 200


# ── R2-backed PMTiles Source ──────────────────────────────────────────────────


class _R2Source:
    """
    pmtiles.reader.Reader expects a CALLABLE `(offset, length) -> bytes`
    (the stock `MmapSource` satisfies this via __call__). We back that with
    boto3 range requests against R2. Authenticated reads — the bucket is
    private (Public Access: Disabled in the Cloudflare R2 dashboard).

    NOTE: this MUST be __call__, not a named method. Reader stores the passed
    object and invokes it directly, so a non-callable object with a .get_bytes()
    method raises TypeError at runtime.

    Two-tier byte-range cache
    ─────────────────────────
    Tier 1 — per-instance in-memory dict.
        Eliminates duplicate reads *within a single render*. PMReader calls the
        source callable several times for the same header/root-directory ranges
        during Reader.__init__; the dict makes each a no-op after the first hit.

    Tier 2 — on-disk directory at _DISK_CACHE_DIR (/tmp/mapvibe-pmtiles-cache).
        Persists across subprocesses. Because render-service spawns a fresh Python
        subprocess per render, the PMTiles header + root directory (~500 KB for the
        planet archive) are otherwise re-fetched over R2 on every single render.
        Caching them on /tmp drops the "fetch phase" from 66-75 s to <5 s on the
        second render of any city.

    Cache key: SHA-256( archive-key + ":" + offset + ":" + length )[:40] — stable
    across restarts; unique per (archive, byte-range) triple.

    Eviction: opportunistic LRU — every _EVICT_EVERY calls we total the cache
    directory size and unlink oldest files (by mtime) until we are under
    _DISK_CACHE_MAX (default 512 MB, configurable via PMTILES_CACHE_MAX_MB).
    """

    def __init__(self, s3_client, bucket: str, key: str) -> None:
        self._s3     = s3_client
        self._bucket = bucket
        self._key    = key
        # Tier 1: in-process memory cache for this _R2Source instance.
        self._mem: dict[tuple[int, int], bytes] = {}
        # Counter for opportunistic eviction (slight over-counting is fine).
        self._calls: int = 0
        # Ensure the disk cache directory exists on first use.
        _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # ── Cache helpers ─────────────────────────────────────────────────────────

    def _disk_path(self, offset: int, length: int) -> pathlib.Path:
        """Return the on-disk path for a (archive-key, offset, length) triple."""
        digest = hashlib.sha256(
            f"{self._key}:{offset}:{length}".encode()
        ).hexdigest()[:40]
        return _DISK_CACHE_DIR / digest

    @staticmethod
    def _evict_lru() -> None:
        """Delete oldest-by-mtime cache files until usage is under _DISK_CACHE_MAX."""
        try:
            files = [p for p in _DISK_CACHE_DIR.iterdir()
                     if p.is_file() and p.suffix != ".tmp"]
            if not files:
                return
            files.sort(key=lambda p: p.stat().st_mtime)
            total = sum(p.stat().st_size for p in files)
            if total <= _DISK_CACHE_MAX:
                return
            for f in files:
                if total <= _DISK_CACHE_MAX:
                    break
                try:
                    sz = f.stat().st_size
                    f.unlink()
                    total -= sz
                    _log.debug("pmtiles cache evicted %s (%d KB)", f.name, sz // 1024)
                except OSError:
                    pass  # concurrent eviction by another process — fine
        except Exception as exc:  # noqa: BLE001
            _log.debug("pmtiles cache eviction skipped: %s", exc)

    # ── Main callable ─────────────────────────────────────────────────────────

    def __call__(self, offset: int, length: int) -> bytes:
        self._calls += 1
        mem_key = (offset, length)

        # ── Tier 1: in-memory ─────────────────────────────────────────────────
        if mem_key in self._mem:
            return self._mem[mem_key]

        # ── Tier 2: on-disk ───────────────────────────────────────────────────
        disk = self._disk_path(offset, length)
        if disk.exists():
            try:
                data = disk.read_bytes()
                self._mem[mem_key] = data
                _log.debug("pmtiles disk-cache HIT  offset=%d length=%d", offset, length)
                return data
            except OSError:
                # Partial write from a crashed process — fall through to R2.
                disk.unlink(missing_ok=True)

        # ── R2 fetch ──────────────────────────────────────────────────────────
        end  = offset + length - 1
        # boto3 retries transient 5xx and connection errors per the client
        # config below; this layer doesn't re-implement them.
        resp = self._s3.get_object(
            Bucket=self._bucket,
            Key=self._key,
            Range=f"bytes={offset}-{end}",
        )
        data = resp["Body"].read()
        _log.debug("pmtiles R2 fetch          offset=%d length=%d", offset, length)

        # Populate Tier 1.
        self._mem[mem_key] = data

        # Populate Tier 2 — atomic write: write to *.tmp then os.replace so
        # a concurrent reader never sees a partially-written file.
        tmp = disk.with_suffix(".tmp")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, disk)
        except OSError as exc:
            _log.debug("pmtiles disk-cache write failed: %s", exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

        # Opportunistic LRU eviction — only runs every _EVICT_EVERY calls so
        # the hot path pays no stat() cost on most invocations.
        if self._calls % _EVICT_EVERY == 0:
            self._evict_lru()

        return data


# ── Reader ────────────────────────────────────────────────────────────────────


class PMTilesR2Reader:
    """
    Wraps pmtiles.reader.Reader with an R2 Source + an LRU cache for decoded
    tiles. One instance per process; not thread-safe (matplotlib's render
    pipeline is single-threaded per request — the ThreadPoolExecutor in the
    old fetch path was for parallel Overpass calls, which we no longer need).
    """

    def __init__(self, *, bucket: str, key: str, endpoint_url: str,
                 access_key: str, secret_key: str,
                 tile_cache_size: int = 1024):
        # boto3 client tuned for high-throughput range-request workloads.
        # standard retry mode covers transient connection failures with
        # exponential backoff; max_attempts=4 mirrors the 2026-06-17 patch
        # 0029's Overpass mirror failover retry budget.
        boto_cfg = BotoConfig(
            region_name="auto",  # R2 doesn't use AWS regions; "auto" is the convention
            signature_version="s3v4",
            retries={"max_attempts": 4, "mode": "standard"},
            s3={"addressing_style": "path"},  # R2 prefers path-style addressing
        )
        s3 = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=boto_cfg,
        )

        self._source = _R2Source(s3, bucket, key)
        self._reader = PMReader(self._source)
        self._bucket = bucket
        self._key = key

        # functools.lru_cache wraps an instance method through a small helper
        # so the cache size is configurable per instance instead of hardcoded
        # at class definition time.
        self._tile_lru = lru_cache(maxsize=tile_cache_size)(self._get_tile_uncached)

        _log.info("PMTilesR2Reader initialised — bucket=%s key=%s",
                  bucket, key)

    @classmethod
    def from_env(cls) -> "PMTilesR2Reader":
        bucket = _required_env("PMTILES_BUCKET")
        key = _required_env("PMTILES_KEY")
        endpoint = _required_env("PMTILES_ENDPOINT_URL")
        # R2_* vars match the build script's naming (build-planet.sh uses
        # the same names). Renaming would force a two-step env var swap on
        # Railway during cut-over for zero benefit.
        access_key = _required_env("R2_ACCESS_KEY_ID")
        secret_key = _required_env("R2_SECRET_ACCESS_KEY")
        return cls(
            bucket=bucket, key=key, endpoint_url=endpoint,
            access_key=access_key, secret_key=secret_key,
        )

    # ── Tile fetch ────────────────────────────────────────────────────────────

    def _get_tile_uncached(self, z: int, x: int, y: int) -> Optional[bytes]:
        try:
            data = self._reader.get(z, x, y)
            # Protomaps planet builds store tiles gzip-compressed. The pmtiles
            # Python library returns raw archive bytes without decompressing;
            # mapbox_vector_tile.decode() expects uncompressed protobuf.
            return _decompress_tile(data) if data is not None else None
        except Exception as e:
            # A raised exception here is NOT a missing tile — the pmtiles
            # reader returns None for those. It means the R2 read itself
            # failed: bad credentials, wrong PMTILES_ENDPOINT_URL, the API
            # token lacks bucket-read permission, or a network error that
            # exhausted boto3's retry budget. Log it at ERROR so it reaches
            # Railway logs (the old WARNING was swallowed), then re-raise as a
            # typed error so the layer-fetch loop can tell a config failure
            # apart from a genuine coverage gap.
            _log.error("PMTiles R2 fetch failed z=%d x=%d y=%d: %s", z, x, y, e)
            raise PMTilesFetchError(z, x, y, e) from e

    def get_tile(self, z: int, x: int, y: int) -> Optional[bytes]:
        return self._tile_lru(z, x, y)

    # ── Layer fetch ───────────────────────────────────────────────────────────

    def fetch_layer(self, layer_name: str, bbox: tuple, zoom: int = 14,
                    *, kind_filter: Optional[set] = None,
                    add_highway: bool = False) -> gpd.GeoDataFrame:
        """
        Returns a GeoDataFrame in EPSG:4326 containing every feature of
        `layer_name` whose geometry intersects `bbox` (a tuple of
        (west, south, east, north) in lng/lat). Streets carry a `highway`
        attribute; rail carries `railway`; water carries `natural` or
        `waterway`; parks carry `leisure` or `landuse`. Matches what
        tilemaker-process.lua emitted at build time.
        """
        t0 = time.time()
        geometries = []
        properties = []
        tiles_fetched = 0
        tiles_hit = 0
        fetch_errors = 0
        last_fetch_error: Optional[PMTilesFetchError] = None

        for tz, tx, ty in _tiles_for_bbox(*bbox, zoom=zoom):
            try:
                tile_bytes = self.get_tile(tz, tx, ty)
            except PMTilesFetchError as e:
                # R2 read failure (not a missing tile). Count it and keep
                # going so the post-loop check can tell "every tile failed to
                # fetch" (config problem) apart from "some tiles are genuinely
                # empty" (normal sparse coverage).
                fetch_errors += 1
                last_fetch_error = e
                continue
            tiles_fetched += 1
            if tile_bytes is None:
                continue
            tiles_hit += 1

            try:
                decoded = mvt.decode(tile_bytes)
            except Exception as e:
                _log.warning("MVT decode failed for tile z=%d x=%d y=%d: %s",
                             tz, tx, ty, e)
                continue

            layer_data = decoded.get(layer_name)
            if not layer_data:
                continue

            # MVT geometries are in tile-local coords [0..extent]; reproject
            # to lng/lat using standard Web Mercator inverse. Identical math
            # to the spike's tile_xy_to_lng_lat; promoted here.
            extent = layer_data.get("extent", 4096)
            project = _tile_xy_to_lng_lat_factory(tz, tx, ty, extent)

            for feat in layer_data.get("features", []):
                props = feat.get("properties", {})
                # Protomaps layers are coarse-grained: `roads` holds rail/ferry/
                # aeroway alongside streets, `landuse` holds residential/park/
                # forest alike. kind_filter keeps only the kinds the caller wants
                # so a single physical layer feeds several logical draw layers.
                if kind_filter is not None and props.get("kind") not in kind_filter:
                    continue
                geom = _decode_geom(feat["geometry"], project)
                if geom is None or geom.is_empty:
                    continue
                if add_highway:
                    # Bridge Protomaps kind/kind_detail onto the OSM `highway`
                    # attribute the draw path expects. kind_detail already holds
                    # the OSM value (motorway/primary/residential/...); the map is
                    # only a fallback for features missing kind_detail.
                    props = dict(props)
                    props["highway"] = (
                        props.get("kind_detail")
                        or _PROTOMAPS_KIND_TO_HIGHWAY.get(props.get("kind"), "unclassified")
                    )
                geometries.append(geom)
                properties.append(props)

        elapsed = time.time() - t0
        _log.info("PMTiles layer=%s z=%d bbox=%s tiles=%d/%d errors=%d "
                  "feats=%d in %.2fs",
                  layer_name, zoom, bbox, tiles_hit, tiles_fetched,
                  fetch_errors, len(geometries), elapsed)

        # Every tile read errored out and not a single one succeeded — the
        # archive is unreachable, not empty. Fail loud with the actionable
        # cause instead of returning an empty frame that the caller would
        # report as the misleading "PMTiles returned no street data".
        if fetch_errors and tiles_fetched == 0:
            cause = last_fetch_error.cause if last_fetch_error else None
            raise RuntimeError(
                f"PMTiles R2 unreachable for bbox={bbox} — all {fetch_errors} "
                f"tile reads failed. This is an R2 ACCESS problem, not missing "
                f"coverage: check R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, "
                f"PMTILES_ENDPOINT_URL, and that the API token has Object Read "
                f"on the bucket. Underlying error: {cause}"
            ) from cause

        if not geometries:
            return gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
        return gpd.GeoDataFrame(properties, geometry=geometries, crs="EPSG:4326")


# ── Tile decompression ───────────────────────────────────────────────────────


def _decompress_tile(data: bytes) -> bytes:
    """
    Decompress gzip-encoded tile data.

    Protomaps planet PMTiles archives (and most tilemaker builds) store tiles
    with gzip compression (tile_compression=gzip in the PMTiles header). The
    pmtiles Python library returns raw bytes as stored in the archive without
    decompressing; callers are responsible for decompression before decoding.
    """
    if data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    return data


# ── Coordinate helpers ────────────────────────────────────────────────────────


def _tiles_for_bbox(west: float, south: float, east: float, north: float,
                    zoom: int) -> Iterable[tuple]:
    x0, y1 = _lng_lat_to_tile(north, west, zoom)
    x1, y0 = _lng_lat_to_tile(south, east, zoom)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            yield zoom, x, y


def _lng_lat_to_tile(lat: float, lng: float, zoom: int) -> tuple:
    n = 2 ** zoom
    x = int((lng + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.asinh(math.tan(lat_rad)) / math.pi) / 2 * n)
    return x, y


def _tile_xy_to_lng_lat_factory(z: int, x: int, y: int, extent: int):
    n = 2 ** z

    def project(px, py):
        lng = (x + px / extent) / n * 360 - 180
        lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n)))
        return lng, math.degrees(lat_rad)

    return project


def _decode_geom(g: dict, project):
    gtype = g["type"]
    coords = g["coordinates"]

    def reproject(ring):
        return [project(px, py) for px, py in ring]

    if gtype == "Point":
        return sgeom.Point(*project(*coords))
    if gtype == "MultiPoint":
        return sgeom.MultiPoint([project(*p) for p in coords])
    if gtype == "LineString":
        return sgeom.LineString(reproject(coords))
    if gtype == "MultiLineString":
        return sgeom.MultiLineString([reproject(l) for l in coords])
    if gtype == "Polygon":
        return sgeom.Polygon(reproject(coords[0]),
                             [reproject(r) for r in coords[1:]])
    if gtype == "MultiPolygon":
        return sgeom.MultiPolygon([
            sgeom.Polygon(reproject(p[0]),
                          [reproject(r) for r in p[1:]])
            for p in coords
        ])
    return None


# ── Env var helper ────────────────────────────────────────────────────────────


def _required_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(
            f"[pmtiles_reader] {name} env var must be set "
            f"(see docs/PMTILES-CUTOVER.md)"
        )
    return v
