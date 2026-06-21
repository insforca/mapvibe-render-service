#!/usr/bin/env python3
"""
scripts/pmtiles-prototype/render-comparison.py

Renders Washington DC two ways at identical crops and writes them side-by-
side as out/comparison.png. This is the gate that decides whether the
Tilemaker config + Lua are correct enough to commit to a planet build.

LEFT  : the production matplotlib path via OSMnx (graph_from_point + the
        existing python/mapvibe_render.py rendering code).
RIGHT : the prototype PMTiles path — reads dc.pmtiles built by build-dc.sh,
        decodes MVT tiles, hands GeoDataFrames to the same matplotlib draw
        code so the only variable is the data source.

If LEFT and RIGHT look essentially identical at city-scale crops, the
PMTiles profile is correct. If RIGHT has missing road tiers, over-
simplified coastlines, or missing rail lines, fix the Lua and rebuild —
much cheaper to find a bug here than after a planet build.

This is a throwaway. Don't import production code into it; don't import it
into production code.

Required packages (additional to mapvibe-py runtime):
    pip install pmtiles mapbox-vector-tile
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Iterable

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import geopandas as gpd
import shapely.geometry as sgeom
import shapely.ops as sops
from shapely.geometry import shape as shapely_shape

import osmnx as ox
from pmtiles.reader import Reader as PMReader, MmapSource
import mapbox_vector_tile as mvt

# Make python/mapvibe_render.py importable so we share helpers (theme load,
# tier filtering). Adds repo-root/python to sys.path.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))
import mapvibe_render as mv  # noqa: E402

# ── Test parameters ──────────────────────────────────────────────────────────
# DC Capitol coordinates. The 9 km radius matches a typical 50×70 cm classic
# poster after the studio's osmDist compensation (boundsToOsmDist + server.ts
# compensatedDist formula). Keep this stable so the comparison is reproducible.
DC_LAT, DC_LNG = 38.8895, -77.0091
RADIUS_M = 9_000

# Output dimensions — match what /render uses for preview-grade output.
WIDTH_IN, HEIGHT_IN = 12.5, 16.67
DPI = 96

# Theme — pick something with a visible rail color so the rail layer diff is
# obvious if Tilemaker drops something.
THEME_NAME = "midnight_blue"

HERE       = Path(__file__).resolve().parent
OUT_DIR    = HERE / "out"
PMTILES    = OUT_DIR / "dc.pmtiles"
OUT_IMAGE  = OUT_DIR / "comparison.png"

# ── Tile coverage math ───────────────────────────────────────────────────────

EARTH_RADIUS_M = 6_371_000

def lat_lng_to_tile(lat: float, lng: float, zoom: int) -> tuple[int, int]:
    import math
    n = 2 ** zoom
    x = int((lng + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.asinh(math.tan(lat_rad)) / math.pi) / 2 * n)
    return x, y

def bbox_around(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    """Returns (west, south, east, north) — a degenerate-rectangle bbox around
    the centre, sized to cover a square circumscribing the fetch circle."""
    import math
    dlat = (radius_m / EARTH_RADIUS_M) * (180 / math.pi)
    dlng = dlat / math.cos(math.radians(lat))
    return (lng - dlng, lat - dlat, lng + dlng, lat + dlat)

def tiles_for_bbox(west, south, east, north, zoom: int) -> Iterable[tuple[int, int, int]]:
    x0, y1 = lat_lng_to_tile(north, west, zoom)
    x1, y0 = lat_lng_to_tile(south, east, zoom)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            yield zoom, x, y

# ── PMTiles fetch ────────────────────────────────────────────────────────────

def fetch_layer_from_pmtiles(pmtiles_path: Path, layer: str, zoom: int,
                             bbox: tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    """Read all features in `layer` that fall within `bbox` from the PMTiles
    archive. Returns a GeoDataFrame in EPSG:4326."""
    import math
    geometries = []
    properties = []
    with open(pmtiles_path, "rb") as f:
        src = MmapSource(f)
        reader = PMReader(src)
        for z, x, y in tiles_for_bbox(*bbox, zoom=zoom):
            try:
                tile_bytes = reader.get(z, x, y)
            except Exception:
                continue
            if tile_bytes is None:
                continue
            # MVT decode — returns dict of layer_name -> { features: [...] }
            try:
                decoded = mvt.decode(tile_bytes)
            except Exception:
                continue
            layer_data = decoded.get(layer)
            if not layer_data:
                continue
            # MVT geometries are in tile-local coords (0..extent). Reproject.
            extent = layer_data.get("extent", 4096)
            n = 2 ** z
            def tile_xy_to_lng_lat(px, py):
                lng = (x + px / extent) / n * 360 - 180
                lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n)))
                return lng, math.degrees(lat_rad)
            for feat in layer_data.get("features", []):
                geom = _decode_geom(feat["geometry"], tile_xy_to_lng_lat)
                if geom is None or geom.is_empty:
                    continue
                geometries.append(geom)
                properties.append(feat.get("properties", {}))
    if not geometries:
        return gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
    gdf = gpd.GeoDataFrame(properties, geometry=geometries, crs="EPSG:4326")
    return gdf

def _decode_geom(g: dict, project) -> sgeom.base.BaseGeometry | None:
    """mapbox-vector-tile.decode already returns shapely-compatible dicts in
    tile-local coords; reproject to lng/lat via `project(x, y) -> (lng, lat)`."""
    gtype = g["type"]
    coords = g["coordinates"]

    def reproject_ring(ring):
        return [project(x, y) for x, y in ring]

    if gtype == "Point":
        return sgeom.Point(*project(*coords))
    if gtype == "MultiPoint":
        return sgeom.MultiPoint([project(*p) for p in coords])
    if gtype == "LineString":
        return sgeom.LineString(reproject_ring(coords))
    if gtype == "MultiLineString":
        return sgeom.MultiLineString([reproject_ring(l) for l in coords])
    if gtype == "Polygon":
        return sgeom.Polygon(reproject_ring(coords[0]),
                             [reproject_ring(r) for r in coords[1:]])
    if gtype == "MultiPolygon":
        return sgeom.MultiPolygon([
            sgeom.Polygon(reproject_ring(p[0]),
                          [reproject_ring(r) for r in p[1:]])
            for p in coords
        ])
    return None

# ── OSMnx fetch (baseline) ───────────────────────────────────────────────────

def fetch_via_osmnx(lat: float, lng: float, dist_m: int):
    t0 = time.time()
    g = ox.graph_from_point(
        (lat, lng), dist=dist_m,
        custom_filter='["highway"~"motorway|trunk|primary|secondary|tertiary|residential|service|track|path|footway|cycleway|pedestrian|steps|living_street|unclassified"]',
    )
    water  = _safe_features(lat, lng, dist_m, {"natural": ["water", "bay", "strait"], "waterway": "riverbank"})
    parks  = _safe_features(lat, lng, dist_m, {"leisure": "park", "landuse": "grass"})
    rail   = _safe_features(lat, lng, dist_m, {"railway": ["rail", "light_rail", "subway", "tram", "monorail"]})
    print(f"  OSMnx fetch  : {time.time() - t0:.1f}s")
    return g, water, parks, rail

def _safe_features(lat, lng, dist, tags):
    try:
        return ox.features_from_point((lat, lng), tags=tags, dist=dist)
    except Exception as e:
        print(f"    features fetch skipped ({tags}): {e}")
        return gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")

# ── Render helpers ────────────────────────────────────────────────────────────

def render_panel(ax, streets_gdf, water_gdf, parks_gdf, rail_gdf, theme, title, minor_roads):
    """Render one panel into an existing matplotlib Axes. Reuses
    mapvibe_render's tier filtering logic to keep the two renders apples-to-
    apples."""
    ax.set_facecolor(theme["bg"])

    # Water
    if water_gdf is not None and not water_gdf.empty:
        polys = water_gdf[water_gdf.geometry.type.isin(["Polygon", "MultiPolygon"])]
        if not polys.empty:
            polys.to_crs(epsg=3857).plot(ax=ax, facecolor=theme["water"], edgecolor="none", zorder=0.5)

    # Parks
    if parks_gdf is not None and not parks_gdf.empty:
        polys = parks_gdf[parks_gdf.geometry.type.isin(["Polygon", "MultiPolygon"])]
        if not polys.empty:
            polys.to_crs(epsg=3857).plot(ax=ax, facecolor=theme["parks"], edgecolor="none", zorder=0.8)

    # Rail
    if rail_gdf is not None and not rail_gdf.empty:
        lines = rail_gdf[rail_gdf.geometry.type.isin(["LineString", "MultiLineString"])]
        if not lines.empty:
            rail_color = theme.get("rail", theme.get("road_default", theme["text"]))
            lines.to_crs(epsg=3857).plot(ax=ax, color=rail_color, linewidth=0.6, zorder=0.9)

    # Streets — both paths converge here. streets_gdf carries a `highway`
    # column with raw OSM tag values; tier filtering matches Python prod.
    if streets_gdf is not None and not streets_gdf.empty:
        proj = streets_gdf.to_crs(epsg=3857)
        for _idx, row in proj.iterrows():
            hw = row.get("highway", "unclassified")
            if isinstance(hw, list):
                hw = hw[0] if hw else "unclassified"
            if not minor_roads and hw in mv._CLEAN_HIDDEN_TYPES:
                continue
            color = _tier_color(hw, theme)
            width = _tier_width(hw)
            gpd.GeoSeries([row.geometry], crs=proj.crs).plot(ax=ax, color=color, linewidth=width, zorder=1)

    ax.set_aspect("equal")
    ax.set_axis_off()
    ax.set_title(title, fontsize=10, color="white", pad=8)

def _tier_color(hw, theme):
    if hw in ("motorway", "motorway_link"):                  return theme["road_motorway"]
    if hw in ("trunk", "trunk_link", "primary", "primary_link"): return theme["road_primary"]
    if hw in ("secondary", "secondary_link"):                return theme["road_secondary"]
    if hw in ("tertiary",  "tertiary_link"):                 return theme["road_tertiary"]
    return theme.get("road_residential", theme.get("road_default", "#888"))

def _tier_width(hw):
    if hw in ("motorway", "motorway_link"):                  return 1.2
    if hw in ("trunk", "trunk_link", "primary", "primary_link"): return 1.0
    if hw in ("secondary", "secondary_link"):                return 0.8
    if hw in ("tertiary",  "tertiary_link"):                 return 0.6
    return 0.4

def osmnx_to_streets_gdf(g) -> gpd.GeoDataFrame:
    """Project the OSMnx multigraph's edges into a GeoDataFrame in EPSG:4326
    so render_panel can treat both paths uniformly."""
    gdf = ox.graph_to_gdfs(g, nodes=False)
    if gdf.crs is None:
        gdf = gdf.set_crs(epsg=4326)
    else:
        gdf = gdf.to_crs(epsg=4326)
    return gdf

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not PMTILES.exists():
        sys.exit(f"PMTiles archive not found at {PMTILES}. Run build-dc.sh first.")

    theme = mv.load_theme(THEME_NAME)
    bbox = bbox_around(DC_LAT, DC_LNG, RADIUS_M)
    print(f"DC bbox (W,S,E,N): {bbox}")

    # ── Path A: OSMnx baseline ───────────────────────────────────────────────
    print("\n[A] Fetching via OSMnx (baseline)...")
    g, water_o, parks_o, rail_o = fetch_via_osmnx(DC_LAT, DC_LNG, RADIUS_M)
    streets_o = osmnx_to_streets_gdf(g)
    print(f"    streets={len(streets_o)} water={len(water_o)} parks={len(parks_o)} rail={len(rail_o)}")

    # ── Path B: PMTiles prototype ────────────────────────────────────────────
    # z14 carries the most detail in our config; fetch at that zoom.
    Z = 14
    print(f"\n[B] Fetching via PMTiles @ z={Z}...")
    t0 = time.time()
    streets_p = fetch_layer_from_pmtiles(PMTILES, "streets", Z, bbox)
    water_p   = fetch_layer_from_pmtiles(PMTILES, "water",   Z, bbox)
    parks_p   = fetch_layer_from_pmtiles(PMTILES, "parks",   Z, bbox)
    rail_p    = fetch_layer_from_pmtiles(PMTILES, "rail",    Z, bbox)
    print(f"    PMTiles fetch: {time.time() - t0:.1f}s")
    print(f"    streets={len(streets_p)} water={len(water_p)} parks={len(parks_p)} rail={len(rail_p)}")

    # ── Render both, side by side ────────────────────────────────────────────
    print("\nRendering comparison...")
    fig, axes = plt.subplots(1, 2, figsize=(WIDTH_IN * 2 + 0.5, HEIGHT_IN),
                             facecolor="#0e1320", dpi=DPI)
    render_panel(axes[0], streets_o, water_o, parks_o, rail_o, theme,
                 "Path A — OSMnx (today)", minor_roads=True)
    render_panel(axes[1], streets_p, water_p, parks_p, rail_p, theme,
                 "Path B — PMTiles (prototype)", minor_roads=True)

    # Lock both axes to the same projected bbox so the comparison is honest.
    minx = min(axes[0].get_xlim()[0], axes[1].get_xlim()[0])
    maxx = max(axes[0].get_xlim()[1], axes[1].get_xlim()[1])
    miny = min(axes[0].get_ylim()[0], axes[1].get_ylim()[0])
    maxy = max(axes[0].get_ylim()[1], axes[1].get_ylim()[1])
    for ax in axes:
        ax.set_xlim(minx, maxx)
        ax.set_ylim(miny, maxy)

    fig.tight_layout()
    fig.savefig(OUT_IMAGE, facecolor=fig.get_facecolor(), dpi=DPI, bbox_inches="tight")
    plt.close(fig)

    size_mb = os.path.getsize(OUT_IMAGE) / (1024 * 1024)
    print(f"\nWrote {OUT_IMAGE} ({size_mb:.1f} MB)")
    print("\nEyeball checklist:")
    print("  1. Same road TIERS visible (motorways, primary, secondary all present)?")
    print("  2. Potomac shoreline shape matches?")
    print("  3. Metro / Amtrak rail corridors present in both?")
    print("  4. Park polygons (Mall, Rock Creek) match?")
    print("  5. Density of residential streets comparable?")
    print("\nIf any of those diverge, the fix is in tilemaker-process.lua")
    print("(missing tag value) or tilemaker-config.json (too-aggressive simplify).")

if __name__ == "__main__":
    main()