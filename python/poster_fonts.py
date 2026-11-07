"""Poster typefaces shared with the Clean (node-canvas) engine.

The editor's poster block is Roboto: city Bold (700), country Light (300),
coordinates and the credit line Regular (400) for the coordinates and Light
for the credit. Both engines open these files. Roboto-Light.ttf has its
name-table family set to "Roboto Light" so node-canvas can select it beside
Regular; matplotlib opens the file directly and does not care.
"""

from __future__ import annotations

import os

# Keys match the FontProperties slots in mapvibe_render.draw:
#   bold    city name             Roboto 700
#   light   country + OSM credit  Roboto 300
#   regular coordinates           Roboto 400
_FACE_FILES = {
    "bold": "Roboto-Bold.ttf",
    "light": "Roboto-Light.ttf",
    "regular": "Roboto-Regular.ttf",
}


def poster_font_dirs(script_dir: str) -> list:
    """Directories that hold the design fonts, Clean's directory first."""
    root = os.path.abspath(os.path.join(script_dir, os.pardir))
    return [
        os.path.join(root, "assets", "fonts"),
        os.path.join(root, "fonts"),
        os.path.join(script_dir, "fonts"),
    ]


def resolve_poster_fonts(script_dir: str) -> dict:
    """Return {bold, light, regular} absolute paths, or {} if any face is missing.

    An incomplete set is not usable: the draw code would mix a real face
    with a matplotlib fallback, which is the mismatch this exists to prevent.
    """
    found = {}
    for key, filename in _FACE_FILES.items():
        for directory in poster_font_dirs(script_dir):
            path = os.path.join(directory, filename)
            if os.path.isfile(path):
                found[key] = os.path.abspath(path)
                break
    if len(found) != len(_FACE_FILES):
        return {}
    return found
