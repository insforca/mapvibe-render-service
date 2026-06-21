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
RADIUS_M = 3_000

# Output dimensions — match what /render uses for preview-grade output.
WIDTH_IN, HEIGHT_IN = 10, 13.3
DPI = 72

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
            # MVT decode — tiles are gzip-compressed by tippecanoe
            import gzip as _gz
            try:
                try:
                    tile_bytes = _gz.decompress(tile_bytes)
                except Exception:
                    pass
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

    # Streets — LineCollection for memory efficiency (avoid geopandas patch alloc per row).
    if streets_gdf is not None and not streets_gdf.empty:
        from matplotlib.collections import LineCollection as _LC
        import numpy as np
        proj = streets_gdf.to_crs(epsg=3857).copy()
        # Normalise highway column (may be list in PMTiles path)
        proj["_hw"] = proj["highway"].apply(
            lambda v: (v[0] if isinstance(v, list) and v else v)
            if not isinstance(v, str) else v
        ).fillna("unclassified")
        if not minor_roads:
            proj = proj[~proj["_hw"].isin(mv._CLEAN_HIDDEN_TYPES)]
        if not proj.empty:
            proj["_color"] = proj["_hw"].apply(lambda hw: _tier_color(hw, theme))
            proj["_width"] = proj["_hw"].apply(_tier_width)
            for (color, width), grp in proj.groupby(["_color", "_width"]):
                segs = []
                for geom in grp.geometry:
                    if geom is None or geom.is_empty:
                        continue
                    if geom.geom_type == "LineString":
                        segs.append(np.array(geom.coords))
                    elif geom.geom_type == "MultiLineString":
                        segs.extend(np.array(g.coords) for g in geom.geoms)
                if segs:
                    lc = _LC(segs, colors=color, linewidths=width, zorder=1)
                    ax.add_collection(lc)

    ax.autoscale_view()
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

    # ── Render 4-panel grid ──────────────────────────────────────────────────
    # Rows = preset (Clean / Detailed). Cols = data source (OSMnx / PMTiles).
    # Top-row left/right identical = Clean preset works with PMTiles data.
    # Bottom-row left/right identical = Detailed preset works with PMTiles data.
    # Top row visibly sparser than bottom within a column = tier filter is
    # actually filtering. See PRESETS-SPEC.md for full pass criteria.
    print("\nRendering 4-panel preset comparison...")
    fig, axes = plt.subplots(2, 2, figsize=(WIDTH_IN * 2 + 0.5, HEIGHT_IN * 2 + 0.5),
                             facecolor="#0e1320", dpi=DPI)

    # Row 0: Clean preset (minor_roads=False)
    render_panel(axes[0][0], streets_o, water_o, parks_o, rail_o, theme,
                 "OSMnx — Clean (today)",          minor_roads=False)
    render_panel(axes[0][1], streets_p, water_p, parks_p, rail_p, theme,
                 "PMTiles — Clean (prototype)",    minor_roads=False)
    # Row 1: Detailed preset (minor_roads=True)
    render_panel(axes[1][0], streets_o, water_o, parks_o, rail_o, theme,
                 "OSMnx — Detailed (today)",       minor_roads=True)
    render_panel(axes[1][1], streets_p, water_p, parks_p, rail_p, theme,
                 "PMTiles — Detailed (prototype)", minor_roads=True)

    # Lock every panel's axes to the same projected bbox so visual diffs are
    # honest (not artefacts of differing auto-fit limits).
    minx = min(ax.get_xlim()[0] for ax in axes.flat)
    maxx = max(ax.get_xlim()[1] for ax in axes.flat)
    miny = min(ax.get_ylim()[0] for ax in axes.flat)
    maxy = max(ax.get_ylim()[1] for ax in axes.flat)
    for ax in axes.flat:
        ax.set_xlim(minx, maxx)
        ax.set_ylim(miny, maxy)

    fig.tight_layout()
    fig.savefig(OUT_IMAGE, facecolor=fig.get_facecolor(), dpi=DPI, bbox_inches="tight")
    plt.close(fig)

    size_mb = os.path.getsize(OUT_IMAGE) / (1024 * 1024)
    print(f"\nWrote {OUT_IMAGE} ({size_mb:.1f} MB)")

    # ── 400 DPI vector → raster validation ───────────────────────────────────
    # The PMTiles pipeline's killer property: same vector source, any
    # rasterization DPI. Render Detailed once at print-grade 400 DPI so the
    # spike also proves the vector-to-print path scales cleanly. Look for
    # crisp line edges, no aliasing artefacts, and a sensible file size
    # (~5-15 MB JPEG for a 12.5x16.7 in poster at 400 DPI).
    print("\nRendering 400 DPI print-grade pass from PMTiles data...")
    PRINT_DPI = 400
    fig_p, ax_p = plt.subplots(figsize=(WIDTH_IN, HEIGHT_IN),
                               facecolor=theme["bg"], dpi=PRINT_DPI)
    render_panel(ax_p, streets_p, water_p, parks_p, rail_p, theme,
                 f"PMTiles \u2014 Detailed @ {PRINT_DPI} DPI", minor_roads=True)
    ax_p.set_title("")  # remove harness title at print resolution
    fig_p.tight_layout(pad=0)
    fig_p.savefig(OUT_DIR / "print-400dpi.jpg",
                  facecolor=theme["bg"], dpi=PRINT_DPI,
                  bbox_inches="tight", pad_inches=0, format="jpeg",
                  pil_kwargs={"quality": 92})
    plt.close(fig_p)
    print_size_mb = os.path.getsize(OUT_DIR / "print-400dpi.jpg") / (1024 * 1024)
    print(f"Wrote {OUT_DIR / 'print-400dpi.jpg'} ({print_size_mb:.1f} MB)")

    print("\nEyeball checklist (comparison.png):")
    print("  1. TOP ROW left vs right identical?  \u2192 Clean preset works with PMTiles")
    print("  2. BOTTOM ROW left vs right identical? \u2192 Detailed preset works with PMTiles")
    print("  3. Top row sparser than bottom within a column? \u2192 tier filter is filtering")
    print("  4. Potomac shoreline shape consistent across all four panels?")
    print("  5. Metro / Amtrak rail corridors present in PMTiles panels?")
    print("\nEyeball checklist (print-400dpi.jpg):")
    print("  6. Line edges crisp at full size, no aliasing? \u2192 vector\u219240 DPI is clean")
    print("  7. File size 5-15 MB? \u2192 encoding is sane for POD upload")
    print("\nIf any panel fails: fix in tilemaker-process.lua (missing tag value)")
    print("or tilemaker-config.json (too-aggressive simplify); see PRESETS-SPEC.md.")

if __name__ == "__main__":
    main()
