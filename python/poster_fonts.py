"""Poster typefaces shared with the Clean (node-canvas) engine.

The Clean renderer registers Playfair Display for the city and country and
IBM Plex Mono for the coordinates and the OSM credit. The Detailed renderer
has to open the same files. Looking up Roboto — or returning nothing and
letting matplotlib pick serif / sans / mono — is how Detailed posters ended
up in a different family from the editor.
"""

from __future__ import annotations

import os

# Keys match the FontProperties slots in mapvibe_render.draw:
#   bold    city name          Playfair Display 700
#   light   country            Playfair Display 400
#                              (no static Light file; the Clean engine's
#                              weight-300 request lands on the 400 face)
#   regular coordinates + credit  IBM Plex Mono 400
_FACE_FILES = {
    "bold": "PlayfairDisplay-Bold.ttf",
    "light": "PlayfairDisplay-Regular.ttf",
    "regular": "IBMPlexMono-Regular.ttf",
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
