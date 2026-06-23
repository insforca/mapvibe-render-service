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

# ── Shared render logic ───────────────────────────────────────────────────────

def render_panel(ax, streets_gdf, water_gdf, parks_gdf, rail_gdf,
                 theme: dict, title: str, minor_roads: bool = True):
    """Render a single panel onto `ax` using pre-fetched GeoDataFrames."""
    bg = theme["bg"]
    ax.set_facecolor(bg)

    # ── Parks fill ────────────────────────────────────────────────────────────
    if not parks_gdf.empty:
        parks_proj = parks_gdf.to_crs(epsg=3857)
        parks_proj = parks_proj[parks_proj.geometry.geom_type.isin(
            ["Polygon", "MultiPolygon"])]
        if not parks_proj.empty:
            parks_proj.plot(ax=ax, color=theme.get("parks", "#1e3a1e"),
                            alpha=0.6, linewidth=0)

    # ── Water fill ────────────────────────────────────────────────────────────
    if not water_gdf.empty:
        water_proj = water_gdf.to_crs(epsg=3857)
        water_proj = water_proj[water_proj.geometry.geom_type.isin(
            ["Polygon", "MultiPolygon"])]
        if not water_proj.empty:
            water_proj.plot(ax=ax, color=theme.get("water", "#1a2e4a"),
                            alpha=0.9, linewidth=0)

    # ── Streets ───────────────────────────────────────────────────────────────
    if not streets_gdf.empty:
        import matplotlib.collections as mcol
        import numpy as np

        streets_proj = streets_gdf.to_crs(epsg=3857)

        # Tier filter
        ARTERY_TAGS = {"motorway", "trunk", "primary", "secondary",
                       "motorway_link", "trunk_link", "primary_link", "secondary_link"}
        is_artery = (streets_proj.get("highway", pd.Series(dtype=str))
                     .isin(ARTERY_TAGS)) if "highway" in streets_proj.columns else \
                    pd.Series([True] * len(streets_proj), index=streets_proj.index)

        def _collect(gdf_subset, color, lw):
            if gdf_subset.empty:
                return
            segs = []
            for geom in gdf_subset.geometry:
                if geom is None or geom.is_empty:
                    continue
                if geom.geom_type == "LineString":
                    segs.append(np.array(geom.coords))
                elif geom.geom_type == "MultiLineString":
                    for part in geom.geoms:
                        segs.append(np.array(part.coords))
            if segs:
                lc = mcol.LineCollection(segs, colors=[color], linewidths=[lw],
                                         zorder=3)
                ax.add_collection(lc)

        road_color = theme.get("roads", "#c8bfb0")
        _collect(streets_proj[is_artery],  road_color, 0.8)
        if minor_roads:
            _collect(streets_proj[~is_artery], road_color, 0.4)

    # ── Rail ─────────────────────────────────────────────────────────────────
    if not rail_gdf.empty:
        rail_proj = rail_gdf.to_crs(epsg=3857)
        rail_lines = rail_proj[rail_proj.geometry.geom_type.isin(
            ["LineString", "MultiLineString"])]
        if not rail_lines.empty:
            rail_lines.plot(ax=ax, color=theme.get("rail", "#aaaaaa"),
                            linewidth=1.0, alpha=0.8)

    ax.set_title(title, fontsize=8, color="#888888", pad=4)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    import pandas as pd

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load theme
    theme = mv.load_theme(THEME_NAME)

    Z    = 14
    bbox = bbox_around(DC_LAT, DC_LNG, RADIUS_M)
    print(f"bbox (W,S,E,N): {bbox}")
    print(f"tiles at z{Z}: {list(tiles_for_bbox(*bbox, zoom=Z))}")

    # ── Fetch OSMnx baseline ─────────────────────────────────────────────────
    print("\nFetching via OSMnx...")
    g_o, water_o, parks_o, rail_o = fetch_via_osmnx(DC_LAT, DC_LNG, RADIUS_M)
    nodes_o, edges_o = ox.graph_to_gdfs(g_o)
    streets_o = edges_o[["geometry"]].copy()
    print(f"  OSMnx streets: {len(streets_o)}")

    # ── Fetch PMTiles ────────────────────────────────────────────────────────
    if not PMTILES.exists():
        print(f"\nERROR: {PMTILES} not found. Run build-dc.sh first.")
        sys.exit(1)

    print("\nFetching from PMTiles...")
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

    # Lock every panel's axes to the bbox we ACTUALLY requested, projected to
    # EPSG:3857 (the metric CRS the panels render in). The earlier version
    # took `min(ax.get_xlim())` across all axes — but matplotlib's
    # autoscale_view() doesn't reliably account for LineCollection bounds
    # when geopandas plots through it, so the PMTiles panels' auto-fit limits
    # came out wrong and the auto-fit-min calculation propagated those wrong
    # bounds to every panel. Visible as three horizontal "bands" of DC in the
    # original spike comparison.png — pure rendering artifact, the underlying
    # PMTiles data was fine (proven by tile-grid overlay render showing
    # streets cross every z14 tile boundary uninterrupted).
    #
    # Computing limits explicitly from the input bbox is both correct and
    # immune to the autoscale gotcha — what we asked for is what we render.
    corner_gs = gpd.GeoSeries(
        [sgeom.Point(bbox[0], bbox[1]), sgeom.Point(bbox[2], bbox[3])],
        crs="EPSG:4326",
    ).to_crs(epsg=3857)
    xmin, ymin = corner_gs.iloc[0].x, corner_gs.iloc[0].y
    xmax, ymax = corner_gs.iloc[1].x, corner_gs.iloc[1].y
    for ax in axes.flat:
        ax.set_xlim(xmin, xmax)
        ax.set_ylim(ymin, ymax)

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
