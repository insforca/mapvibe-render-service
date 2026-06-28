"""
python/render_presets.py

Named render presets — promotes the minor_roads: bool flag to a dict that
clusters per-preset knobs. Pre-existing visual outputs are preserved
exactly; this is API hygiene only.

See scripts/pmtiles-prototype/PRESETS-SPEC.md for the full rationale.

The behaviour was always shipped:
  - Studio form: roadDetailMode in {'arteries', 'neighbourhood'}
  - Studio → server: minorRoads: boolean
  - Render-service: minor_roads: bool on render()

This module replaces the bool with a dict so future per-preset divergence
(different fade styles, edge weight scales, etc.) lands in one place
instead of rippling through every call site.
"""

from __future__ import annotations

# Lazy import to avoid a circular dependency: mapvibe_render imports this
# module, and we need _CLEAN_HIDDEN_TYPES from there. Defined locally to
# match exactly — kept in sync via the spec's "What this spec adds"
# contract.

# Mirror of mapvibe_render._MINOR_ROAD_TYPES (lines 268-272).
_MINOR_ROAD_TYPES = frozenset({
    "residential", "living_street", "unclassified",
    "service", "track", "path", "footway", "cycleway",
    "pedestrian", "steps",
})

# Mirror of mapvibe_render._CLEAN_HIDDEN_TYPES (lines 282-285). Clean mode
# hides this whole set; Detailed shows everything. Drift between this set
# and mapvibe_render's MUST be caught — assert at import time so a stale
# copy fails loud rather than producing subtly-wrong renders.
_CLEAN_HIDDEN_TYPES = frozenset(_MINOR_ROAD_TYPES | {
    "secondary", "secondary_link",
    "tertiary",  "tertiary_link",
})


RENDER_PRESETS = {
    "clean": {
        "hidden_highway":   _CLEAN_HIDDEN_TYPES,
        "edge_width_scale": 1.0,
        # Future per-preset levers land here. e.g.:
        # "fade_style":     "fullbleed",
        # "label_weight":   500,
    },
    "detailed": {
        "hidden_highway":   frozenset(),  # nothing hidden — full tier hierarchy
        "edge_width_scale": 1.0,
    },
}


def resolve_preset(preset: str | None = None,
                   minor_roads: bool | None = None) -> dict:
    """
    Accepts either the new `preset` field or the legacy `minor_roads` bool.
    Backwards-compat shim per PRESETS-SPEC.md § "Studio → render-service
    contract" — server accepts both for one release; preset wins if both
    are supplied; minor_roads alone maps to detailed (True) or clean
    (False/None).

    Returns the matching RENDER_PRESETS entry. Defaults to "clean" if
    nothing's specified — same default as the historical bool=False.
    """
    if preset is not None:
        if preset not in RENDER_PRESETS:
            raise ValueError(
                f"Unknown preset {preset!r}; valid: {list(RENDER_PRESETS)}"
            )
        return RENDER_PRESETS[preset]

    # Legacy path: minor_roads bool. True → detailed, anything else → clean.
    return RENDER_PRESETS["detailed"] if minor_roads else RENDER_PRESETS["clean"]
