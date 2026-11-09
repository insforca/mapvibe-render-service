"""Editor poster-strip geometry for the OSM renderer.

The desktop editor lays ``.mvs-poster-*`` out in CSS, not by glyph ink.
Line boxes are 1.15em. Margins are 3px under the city, 4px under the
rule, and ``max(3px, 1em)`` between the country and the coordinates, then
1em under the coordinates. The strip padding is 6px 18px 14px. The rule
is 1px tall and 20% of the content box. Centred city letter-spacing keeps
a trailing gap, so the ink sits half a spacing left of centre.

Absolute pixels are the desktop editor's CSS pixels on a 482.390625px-wide
poster and scale with the short side. This is the same model as
``src/poster-text.ts``; the two have to move together.
"""

from __future__ import annotations

EDITOR_POSTER_SHORT_PX = 482.390625
CSS_LINE_HEIGHT = 1.15
# Roboto hhea: ascender 1900, descender 500, unitsPerEm 2048.
# Half-leading around that content box puts the alphabetic baseline in a 1.15em line.
_HHEA_ASCENT = 1900 / 2048
_HHEA_LINE = (1900 + 500) / 2048
CSS_BASELINE_EM = _HHEA_ASCENT + (CSS_LINE_HEIGHT - _HHEA_LINE) / 2

CITY_CQMIN = 0.0694
COUNTRY_CQMIN = 0.0255
COORDS_CQMIN = 0.0162


def layout_poster_strip(
    width,
    height,
    city_size,
    country_size,
    coords_size,
    tracking_em=0.45,
    has_city=True,
    has_country=True,
    has_coords=True,
):
    """Place the strip. Every length is in the same unit; y grows downward.

    Returns tops, baselines, and the rule in that unit, plus the rule's
    horizontal span and the centred city's ink-centre as fractions of width.
    """
    short = min(width, height)
    scale = short / EDITOR_POSTER_SHORT_PX

    def px(css_px):
        return css_px * scale

    border = px(1.0)
    blocks = []
    if has_city and city_size > 0:
        blocks.append(("city", city_size * CSS_LINE_HEIGHT, 0.0, px(3.0), city_size))
    blocks.append(("rule", border, 0.0, px(4.0), 0.0))
    if has_country and country_size > 0:
        blocks.append(("country", country_size * CSS_LINE_HEIGHT, 0.0, px(3.0), country_size))
    if has_coords and coords_size > 0:
        blocks.append(("coords", coords_size * CSS_LINE_HEIGHT, coords_size, coords_size, coords_size))

    placed = []
    cursor = 0.0
    prev_margin_bottom = 0.0
    for name, box, margin_top, margin_bottom, size in blocks:
        gap = margin_top if not placed else max(prev_margin_bottom, margin_top)
        top = cursor + gap
        bottom = top + box
        placed.append((name, top, bottom, size))
        cursor = bottom
        prev_margin_bottom = margin_bottom

    content_bottom = cursor + prev_margin_bottom
    pad_top = px(6.0)
    pad_bottom = px(14.0)
    strip_top = height - (pad_top + content_bottom + pad_bottom)
    origin = strip_top + pad_top

    out = {
        "strip_top": strip_top,
        "rule_linewidth": border,
        "rule_x0": 0.0,
        "rule_x1": 0.0,
        "city_x": 0.5,
    }
    content = max(1.0, width - 2.0 * px(18.0))
    rule_width = 0.20 * content
    out["rule_x0"] = (width - rule_width) / 2.0 / width
    out["rule_x1"] = (width + rule_width) / 2.0 / width

    for name, top, bottom, size in placed:
        box_top = origin + top
        box_bottom = origin + bottom
        if name == "rule":
            out["rule_top"] = box_top
            out["rule_bottom"] = box_bottom
            out["rule_y"] = (box_top + box_bottom) / 2.0
            continue
        baseline = box_top + CSS_BASELINE_EM * size
        out[name + "_box_top"] = box_top
        out[name + "_box_bottom"] = box_bottom
        out[name + "_baseline"] = baseline

    if has_city and city_size > 0 and tracking_em > 0:
        out["city_x"] = 0.5 - (tracking_em / 2.0) * city_size / width
    return out


# Editor `.poster-fade` is the bottom 14% of the sheet. Stops are fractions
# of that band, 0 at the bottom (opaque) and 1 at the top of the band (clear).
# Same numbers as EDITOR_BOTTOM_FADE_* in src/print-parity.ts.
BOTTOM_FADE_HEIGHT = 0.14
BOTTOM_FADE_STOPS = (
    (0.0, 1.0),
    (0.12, 0.94),
    (0.26, 0.80),
    (0.40, 0.62),
    (0.54, 0.43),
    (0.66, 0.27),
    (0.78, 0.14),
    (0.88, 0.055),
    (0.95, 0.014),
    (1.0, 0.0),
)

# fadeStyle 'text' — same band geometry as applyFades in poster-text.ts.
TEXT_TOP_HEIGHT = 0.25
TEXT_TOP_STOPS = (
    (0.0, 1.0),
    (0.4, 0.45),
    (0.7, 0.12),
    (1.0, 0.0),
)
TEXT_SOLID_HEIGHT = 0.065
TEXT_GRADIENT_HEIGHT = 0.15
TEXT_GRADIENT_STOPS = (
    (0.0, 0.0),
    (0.10, 0.04),
    (0.22, 0.10),
    (0.36, 0.26),
    (0.50, 0.44),
    (0.64, 0.63),
    (0.76, 0.80),
    (0.87, 0.92),
    (0.95, 0.98),
    (1.0, 1.0),
)

CREDIT_REFERENCE_PX = 3600.0
CREDIT_SIZE_PX = 30.0
CREDIT_EDGE_PX = 6.0
CREDIT_EDGE_MARGIN = 0.02


def fade_kind(style):
    if style is None:
        return "bottom"
    name = str(style).strip().lower()
    if name == "none":
        return "none"
    if name == "text":
        return "text"
    return "bottom"


def fade_stop_alpha(stops, t):
    if not stops:
        return 0.0
    if t <= stops[0][0]:
        return stops[0][1]
    if t >= stops[-1][0]:
        return stops[-1][1]
    for (z0, v0), (z1, v1) in zip(stops, stops[1:]):
        if z0 <= t <= z1:
            if z1 == z0:
                return v1
            u = (t - z0) / (z1 - z0)
            return v0 + u * (v1 - v0)
    return stops[-1][1]


def bottom_fade_alpha(height_fraction):
    """Overlay alpha. height_fraction is 0 at the top of the sheet, 1 at the bottom."""
    if height_fraction >= 1:
        return 1.0
    from_bottom = 1.0 - height_fraction
    # 1 - 0.86 is just under 0.14 in binary floating point. That is the top of the band.
    if from_bottom >= BOTTOM_FADE_HEIGHT - 1e-9:
        return 0.0
    return fade_stop_alpha(BOTTOM_FADE_STOPS, from_bottom / BOTTOM_FADE_HEIGHT)


def credit_layout(width, height):
    """Credit line in the same unit as width/height. y grows downward.

    Matches src/poster-text.ts: Roboto Light at 30px on a 3600px short side,
    bottom inset 6 CSS px on the 482.390625px editor poster, 2% side margins.
    `y` is the bottom of the glyphs.
    """
    short = min(width, height)
    size = CREDIT_SIZE_PX * short / CREDIT_REFERENCE_PX
    inset = CREDIT_EDGE_PX * short / EDITOR_POSTER_SHORT_PX
    return {
        "size": size,
        "y": height - inset,
        "inset": inset,
        "left": CREDIT_EDGE_MARGIN * width,
        "right": (1.0 - CREDIT_EDGE_MARGIN) * width,
        "alpha": 0.9,
    }


def attribution_color(hex_color):
    """Same luma split as drawPosterText. Light land gets the dark credit ink."""
    h = (hex_color or "#808080").lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    try:
        r = int(h[0:2], 16)
        g = int(h[2:4], 16)
        b = int(h[4:6], 16)
    except ValueError:
        r, g, b = 128, 128, 128
    luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    return "#f5faff" if luma < 0.52 else "#0e1822"
