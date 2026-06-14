#!/usr/bin/env python3
"""
mapvibe_render.py — MapVibe OSM render adapter
===============================================
Reads JSON params from stdin, renders a city map poster using
OSMnx + matplotlib (maptoposter-style). All render decisions
(size, DPI, theme, typography, crop) are made here.

Inputs (JSON on stdin):
  • lat, lng      — map centre in decimal degrees
  • width_mm      — poster width  in millimetres
  • height_mm     — poster height in millimetres
  • dpi           — output DPI (default 400)
  • theme_json    — colour palette dict (bg, text, water, parks, road_*)
  • theme         — theme slug — used to load a JSON file from
                   python/themes/<slug>.json when theme_json is absent
  • city          — poster title text (top)
  • state         — poster subtitle text (bottom)
  • dist          — half-extent in metres from the OSMnx call  
  • crop_dist     — half-extent override for the matplotlib axis window
                   (keeps the visible area inside the OSMnx fetch circle)
  • minor_roads   — render residential/service/footway roads (default False)
  • full_bleed    — extend roads to canvas edge (default False)
  • no_fade       — disable peripheral fade (default False)
  • text_layout   — text placement: 'centered', 'bottom' (default 'centered')

Outputs:
  PNG bytes on stdout (stdout is binary; log messages go to stderr).
"""

import json
import math
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')   # headless, no Xvfb required
import matplotlib.pyplot as plt
import numpy as np
import osmnx as ox
from matplotlib.patches import Rectangle
from PIL import Image, ImageFilter
import io

# ---------------------------------------------------------------------------
# Optional font discovery (font_management.py, shipped alongside this script)
# ---------------------------------------------------------------------------
try:
    from font_management import ensure_fonts_loaded   # type: ignore
except ImportError:
    def ensure_fonts_loaded():
        pass


_SCRIPT_DIR = Path(__file__).parent


def _log(msg: str) -> None:
    """Write a timestamped log line to stderr."""
    import datetime
    ts = datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]
    print(f'[render {ts}] {msg}', file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Road-type taxonomy (matches the OSMnx highway tag values)
# ---------------------------------------------------------------------------
_MINOR_ROAD_TYPES = {
    'residential', 'living_street', 'unclassified',
    'service', 'pedestrian', 'footway', 'path',
    'cycleway', 'track', 'steps', 'construction',
}


def get_edge_colors(g, theme: dict, minor_roads: bool) -> list:
    """Return a colour per edge matching the theme palette."""
    colors = []
    for _, _, data in g.edges(data=True):
        hw = data.get('highway', '')
        if isinstance(hw, list):
            hw = hw[0]
        if not minor_roads and hw in _MINOR_ROAD_TYPES:
            colors.append('#00000000')   # fully transparent
        elif hw in ('motorway', 'motorway_link'):
            colors.append(theme.get('road_motorway', theme.get('text', '#C9A96E')))
        elif hw in ('trunk', 'trunk_link'):
            colors.append(theme.get('road_motorway', theme.get('text', '#C9A96E')))
        elif hw in ('primary', 'primary_link'):
            colors.append(theme.get('road_primary', theme.get('text', '#C9A96E')))
        elif hw in ('secondary', 'secondary_link'):
            colors.append(theme.get('road_secondary', theme.get('text', '#C9A96E')))
        elif hw in ('tertiary', 'tertiary_link'):
            colors.append(theme.get('road_tertiary', theme.get('text', '#C9A96E')))
        elif hw == 'residential':
            colors.append(theme.get('road_residential', theme.get('text', '#C9A96E')))
        else:
            colors.append(theme.get('road_default', theme.get('text', '#C9A96E')))
    return colors


def get_edge_widths(g, minor_roads: bool) -> list:
    """Return a line-width per edge."""
    widths = []
    for _, _, data in g.edges(data=True):
        hw = data.get('highway', '')
        if isinstance(hw, list):
            hw = hw[0]
        if not minor_roads and hw in _MINOR_ROAD_TYPES:
            widths.append(0)
        elif hw in ('motorway', 'motorway_link', 'trunk', 'trunk_link'):
            widths.append(2.0)
        elif hw in ('primary', 'primary_link'):
            widths.append(1.5)
        elif hw in ('secondary', 'secondary_link'):
            widths.append(1.2)
        elif hw in ('tertiary', 'tertiary_link'):
            widths.append(1.0)
        else:
            widths.append(0.7)
    return widths


def load_theme(theme_slug: str) -> dict:
    """Load a colour theme from python/themes/<slug>.json."""
    theme_path = _SCRIPT_DIR / 'themes' / f'{theme_slug}.json'
    if not theme_path.exists():
        raise FileNotFoundError(f'Theme file not found: {theme_path}')
    with open(theme_path) as f:
        return json.load(f)


def get_crop_limits(
    x_center: float,
    y_center: float,
    crop_dist: float,
    fig_aspect: float,
) -> tuple[float, float, float, float]:
    """
    Return (xmin, xmax, ymin, ymax) axis limits so that the visible
    rectangle has half-width = crop_dist and half-height = crop_dist *
    fig_aspect (in projected metres).
    """
    hw = crop_dist
    hh = crop_dist * fig_aspect
    return x_center - hw, x_center + hw, y_center - hh, y_center + hh


def apply_fade(
    fig: plt.Figure,
    ax: plt.Axes,
    bg_color: str,
    strength: float = 0.55,
    radius: float = 0.5,
) -> None:
    """
    Draw a radial-gradient vignette over the figure in bg_color so roads
    near the edges fade to the background colour.
    """
    # Render current figure to a numpy array
    fig.canvas.draw()
    buf = np.frombuffer(fig.canvas.tostring_rgb(), dtype=np.uint8)
    w_px = int(fig.get_figwidth()  * fig.dpi)
    h_px = int(fig.get_figheight() * fig.dpi)
    buf = buf.reshape(h_px, w_px, 3)

    # Build a radial alpha mask (0 = transparent, 1 = fully bg)
    xs = np.linspace(-1, 1, w_px)
    ys = np.linspace(-1, 1, h_px)
    xx, yy = np.meshgrid(xs, ys)
    dist_map = np.sqrt(xx ** 2 + yy ** 2)
    alpha = np.clip((dist_map - radius) / (1.0 - radius), 0, 1) * strength

    # Parse the bg hex color
    bg_hex = bg_color.lstrip('#')
    bg_rgb = tuple(int(bg_hex[i:i+2], 16) / 255.0 for i in (0, 2, 4))

    # Overlay
    ax.imshow(
        np.dstack([np.full((h_px, w_px), int(bg_rgb[c] * 255), dtype=np.uint8) for c in range(3)]
                  + [np.clip(alpha * 255, 0, 255).astype(np.uint8)]),
        extent=ax.get_xlim() + ax.get_ylim(),
        aspect='auto',
        zorder=5,
        interpolation='bilinear',
        transform=ax.transData,
    )


def render_text(
    fig: plt.Figure,
    ax: plt.Axes,
    city: str,
    state: str,
    theme: dict,
    text_layout: str,
    dpi: float,
    width_in: float,
    height_in: float,
) -> None:
    """
    Draw city + state text over the map in the appropriate position and
    font sizes, scaled to the poster dimensions.
    """
    ensure_fonts_loaded()

    text_color = theme.get('text', '#C9A96E')
    bg_color   = theme.get('bg',   '#1B2A4A')

    # Base font sizes (pt) — calibrated for a 12x18-inch poster at 400 DPI.
    base_city_pt  = 48.0
    base_state_pt = 24.0
    scale = min(width_in, height_in) / 12.0
    city_pt  = base_city_pt  * scale
    state_pt = base_state_pt * scale

    if text_layout == 'bottom':
        city_y,  city_va  = 0.08, 'bottom'
        state_y, state_va = 0.04, 'bottom'
    else:   # centered
        city_y,  city_va  = 0.50, 'center'
        state_y, state_va = 0.40, 'center'

    # City name (Playfair Display-style serif)
    ax.text(
        0.5, city_y, city.upper(),
        transform=ax.transAxes,
        ha='center', va=city_va,
        fontsize=city_pt,
        color=text_color,
        fontweight='bold',
        zorder=10,
        clip_on=False,
    )
    # State / sub-label (smaller, lighter)
    if state:
        ax.text(
            0.5, state_y, state.upper(),
            transform=ax.transAxes,
            ha='center', va=state_va,
            fontsize=state_pt,
            color=text_color,
            fontweight='normal',
            zorder=10,
            clip_on=False,
        )


def render(params: dict) -> bytes:
    """
    Core render function. Accepts a parameter dict and returns PNG bytes.
    """
    # ------------------------------------------------------------------
    # Extract parameters
    # ------------------------------------------------------------------
    lat           = float(params['lat'])
    lng           = float(params['lng'])
    width_mm      = float(params.get('width_mm',  457.2))  # default 18 in
    height_mm     = float(params.get('height_mm', 609.6))  # default 24 in
    dpi           = float(params.get('dpi',       400))
    city          = str(params.get('city',        ''))
    state         = str(params.get('state',       ''))
    dist          = float(params.get('dist',      3000))
    crop_dist     = float(params.get('crop_dist', dist))
    minor_roads   = bool(params.get('minor_roads', False))
    full_bleed    = bool(params.get('full_bleed',  False))
    no_fade       = bool(params.get('no_fade',     False))
    text_layout   = str(params.get('text_layout',  'centered'))
    network_type  = str(params.get('network_type', 'drive'))

    # Theme: explicit dict takes precedence over slug
    theme_json_raw = params.get('theme_json')
    theme_slug     = str(params.get('theme', 'vintage_noir'))
    if theme_json_raw:
        theme = theme_json_raw if isinstance(theme_json_raw, dict) else json.loads(theme_json_raw)
    else:
        theme = load_theme(theme_slug)

    bg_color   = theme.get('bg',   '#1B2A4A')
    text_color = theme.get('text', '#C9A96E')

    _log(
        f'Rendering {city!r} {width_mm:.0f}x{height_mm:.0f}mm @{dpi:.0f}dpi '
        f'theme={theme_slug}  dist={dist}  crop_dist={crop_dist}  '
        f'full_bleed={full_bleed}  no_fade={no_fade}  minor_roads={minor_roads}'
    )

    # ------------------------------------------------------------------
    # Dimensions
    # ------------------------------------------------------------------
    MM_PER_INCH = 25.4
    width_in  = width_mm  / MM_PER_INCH
    height_in = height_mm / MM_PER_INCH

    # comp_dist: OSMnx fetch radius.  The axis window is square in the fetch
    # call but the figure is rectangular, so we over-fetch by the aspect ratio
    # so road data fills the longer dimension.
    comp_dist = dist * (max(height_in, width_in) / min(height_in, width_in)) / 4

    _log('Fetching street network...')
    if minor_roads:
        # Full drive network — residential/service/etc. are drawn.
        g = ox.graph_from_point(point, dist=comp_dist, network_type=network_type)
    else:
        # We hide every minor road at draw time anyway (get_edge_colors paints
        # residential / service / footway / etc. fully transparent), yet the
        # default 'drive' network still *downloads* them — and they are the
        # bulk of edges in a dense metro. Fetching the full network is what
        # made wide-radius requests time out (hence the studio's former 5 km
        # cap). Restrict the Overpass query to the exact classes we render
        # (motorway/trunk/primary/secondary/tertiary, links included via the
        # regex) so a 15-20 km poster fetches roughly what an old 5 km drive
        # fetch did. Purely a fetch optimisation — zero visual change, since
        # these are precisely the edges get_edge_colors keeps opaque.
        major_roads_filter = '["highway"~"motorway|trunk|primary|secondary|tertiary"]'
        g = ox.graph_from_point(point, dist=comp_dist, custom_filter=major_roads_filter)
    if g is None or len(g.nodes) == 0:
        raise RuntimeError('Failed to retrieve street network data.')

    _log(f'Graph: {len(g.nodes)} nodes, {len(g.edges)} edges')

    # ------------------------------------------------------------------
    # Project to metres
    # ------------------------------------------------------------------
    g_proj = ox.project_graph(g)

    nodes_proj, _ = ox.graph_to_gdfs(g_proj)
    x_center = nodes_proj.geometry.x.mean()
    y_center = nodes_proj.geometry.y.mean()

    # ------------------------------------------------------------------
    # Figure setup
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(width_in, height_in), dpi=dpi)
    fig.patch.set_facecolor(bg_color)
    ax.set_facecolor(bg_color)
    ax.set_axis_off()

    # ------------------------------------------------------------------
    # Edge colours / widths
    # ------------------------------------------------------------------
    edge_colors = get_edge_colors(g_proj, theme, minor_roads)
    edge_widths = get_edge_widths(g_proj, minor_roads)

    ox.plot_graph(
        g_proj,
        ax=ax,
        edge_color=edge_colors,
        edge_linewidth=edge_widths,
        node_size=0,
        bgcolor=bg_color,
        show=False,
        close=False,
    )

    # ------------------------------------------------------------------
    # Crop
    # ------------------------------------------------------------------
    fig_aspect = height_in / width_in
    xmin, xmax, ymin, ymax = get_crop_limits(x_center, y_center, crop_dist, fig_aspect)
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)

    # ------------------------------------------------------------------
    # Optional fade
    # ------------------------------------------------------------------
    if not no_fade:
        apply_fade(fig, ax, bg_color)

    # ------------------------------------------------------------------
    # Text overlay
    # ------------------------------------------------------------------
    if city or state:
        render_text(fig, ax, city, state, theme, text_layout, dpi, width_in, height_in)

    # ------------------------------------------------------------------
    # Export to PNG bytes
    # ------------------------------------------------------------------
    buf = io.BytesIO()
    plt.savefig(
        buf,
        format='png',
        dpi=dpi,
        bbox_inches='tight',
        pad_inches=0,
        facecolor=bg_color,
    )
    plt.close(fig)
    buf.seek(0)
    _log('Render complete.')
    return buf.read()


if __name__ == '__main__':
    params = json.loads(sys.stdin.read())
    png_bytes = render(params)
    sys.stdout.buffer.write(png_bytes)
