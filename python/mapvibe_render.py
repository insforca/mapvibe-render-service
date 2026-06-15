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

# ── Headless matplotlib — MUST be set before any pyplot import ─────────────
import matplotlib
matplotlib.use('Agg')
import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
import osmnx as ox
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
    # trips. They were issued sequentially (streets → water → parks), so the
    # render waited on the *sum* of three network latencies (~8-12 s on a busy
    # Overpass mirror). They share no state, and OSMnx's underlying requests
    # release the GIL during socket I/O, so a ThreadPoolExecutor genuinely
    # overlaps them — the render now waits on the *max* of the three (~4-6 s).
    # Pure latency win, identical output.
    from concurrent.futures import ThreadPoolExecutor

    def _fetch_streets():
        if minor_roads:
            # Full drive network — residential/service/etc. are drawn.
            return ox.graph_from_point(point, dist=comp_dist, network_type=network_type)
        # Clean mode draws only motorway / trunk / primary (matches editor's
        # roadDetailMode='arteries' which hides road-secondary, road-minor-mid
        # and road-minor-low). Anything below the arterial tier is painted
        # transparent in get_edge_colors / get_edge_widths anyway, so we save
        # the Overpass bandwidth by not downloading them in the first place.
        # The regex matches *_link suffixes for free (no anchors).
        major_roads_filter = '["highway"~"motorway|trunk|primary"]'
        return ox.graph_from_point(point, dist=comp_dist, custom_filter=major_roads_filter)

    def _fetch_water():
        try:
            return ox.features_from_point(
                point,
                tags={'natural': ['water', 'bay', 'strait'], 'waterway': 'riverbank'},
                dist=comp_dist,
            )
        except Exception as e:
            _log(f'Water fetch skipped: {e}')
            return None

    def _fetch_parks():
        try:
            return ox.features_from_point(
                point,
                tags={'leisure': 'park', 'landuse': 'grass'},
                dist=comp_dist,
            )
        except Exception as e:
            _log(f'Parks fetch skipped: {e}')
            return None

    _log('Fetching street network + water + parks (parallel)...')
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_streets = pool.submit(_fetch_streets)
        f_water   = pool.submit(_fetch_water)
        f_parks   = pool.submit(_fetch_parks)
        # Streets are mandatory — let any exception propagate (fails the render
        # exactly as the old sequential code did). Water / parks already
        # swallow their own errors and return None.
        g     = f_streets.result()
        water = f_water.result()
        parks = f_parks.result()

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

        base_main = 60 * scale
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
