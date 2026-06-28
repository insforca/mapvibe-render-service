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
import math
import os
import time
from functools import lru_cache
from typing import Iterable, Optional

import boto3
import geopandas as gpd
import mapbox_vector_tile as mvt
import shapely.geometry as sgeom
from botocore.config import Config as BotoConfig
from pmtiles.reader import Reader as PMReader

_log = logging.getLogger("mapvibe_render.pmtiles")


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
    """

    def __init__(self, s3_client, bucket: str, key: str):
        self._s3 = s3_client
        self._bucket = bucket
        self._key = key

    def __call__(self, offset: int, length: int) -> bytes:
        end = offset + length - 1
        # boto3 retries transient 5xx and connection errors per the client
        # config below; this layer doesn't re-implement them.
        resp = self._s3.get_object(
            Bucket=self._bucket,
            Key=self._key,
            Range=f"bytes={offset}-{end}",
        )
        return resp["Body"].read()


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
            return self._reader.get(z, x, y)
        except Exception as e:
            # PMTiles get() raises on genuine errors; missing tiles return
            # None. Logged + swallowed at the layer-fetch level so a single
            # bad tile doesn't fail a whole render.
            _log.warning("PMTiles get failed z=%d x=%d y=%d: %s", z, x, y, e)
            return None

    def get_tile(self, z: int, x: int, y: int) -> Optional[bytes]:
        return self._tile_lru(z, x, y)

    # ── Layer fetch ───────────────────────────────────────────────────────────

    def fetch_layer(self, layer_name: str, bbox: tuple, zoom: int = 14
                    ) -> gpd.GeoDataFrame:
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

        for tz, tx, ty in _tiles_for_bbox(*bbox, zoom=zoom):
            tile_bytes = self.get_tile(tz, tx, ty)
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
                geom = _decode_geom(feat["geometry"], project)
                if geom is None or geom.is_empty:
                    continue
                geometries.append(geom)
                properties.append(feat.get("properties", {}))

        elapsed = time.time() - t0
        _log.info("PMTiles layer=%s z=%d bbox=%s tiles=%d/%d feats=%d in %.2fs",
                  layer_name, zoom, bbox, tiles_hit, tiles_fetched,
                  len(geometries), elapsed)

        if not geometries:
            return gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
        return gpd.GeoDataFrame(properties, geometry=geometries, crs="EPSG:4326")


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
