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
