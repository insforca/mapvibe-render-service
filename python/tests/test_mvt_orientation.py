"""Tile Y orientation for the Detailed (PMTiles) renderer.

mapbox-vector-tile flips Y unless y_coord_down=True. The projector treats
y=0 as the north edge of the tile. Those two conventions have to agree, or
every tile is mirrored and streets break on the horizontal tile edges.
Preview and /fulfill print both decode through _decode_mvt.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

# pmtiles_reader imports the R2 client at module import. The orientation
# helpers do not use it; stub the heavy clients so this test stays a
# geometry test.
def _stub(name: str) -> types.ModuleType:
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    return mod


for _name in ("boto3", "geopandas", "botocore", "botocore.config", "pmtiles", "pmtiles.reader"):
    _stub(_name)
_stub("botocore.config").Config = object  # type: ignore[attr-defined]
_stub("pmtiles.reader").Reader = object  # type: ignore[attr-defined]

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mapbox_vector_tile as mvt  # noqa: E402
import pmtiles_reader as pr  # noqa: E402

_EXTENT = 4096
_Z = 14
_X = 7776
_Y = 6277


def _encode(features: list, z: int, x: int, y: int) -> bytes:
    """Spec-oriented tile: py=0 is the north edge, py=extent is the south edge."""
    return mvt.encode(
        [{"name": "roads", "features": features}],
        default_options={
            "y_coord_down": True,
            "extents": _EXTENT,
            "quantize_bounds": (0, 0, _EXTENT, _EXTENT),
        },
    )


def _projected_points(tile: bytes, z: int, x: int, y: int) -> dict:
    decoded = pr._decode_mvt(tile)
    layer = decoded["roads"]
    project = pr._tile_xy_to_lng_lat_factory(z, x, y, layer.get("extent", _EXTENT))
    out = {}
    for feat in layer["features"]:
        geom = pr._decode_geom(feat["geometry"], project)
        out[feat["properties"]["name"]] = (geom.x, geom.y)
    return out


class MvtOrientationTest(unittest.TestCase):
    def test_north_edge_is_north_of_south_edge(self):
        tile = _encode([
            {"geometry": f"POINT(200 0)", "properties": {"name": "north"}},
            {"geometry": f"POINT(200 {_EXTENT})", "properties": {"name": "south"}},
        ], _Z, _X, _Y)
        pts = _projected_points(tile, _Z, _X, _Y)
        self.assertGreater(pts["north"][1], pts["south"][1])
        # Same meridian: a vertical flip would still share longitude, so this
        # alone does not catch the bug. The latitude order does.
        self.assertAlmostEqual(pts["north"][0], pts["south"][0], places=6)

    def test_shared_tile_edge_is_one_latitude(self):
        # A point on the south edge of tile y and the north edge of tile y+1
        # is the same geographic location. A per-tile Y flip puts them on
        # opposite sides of their tiles, which is the torn strip in the poster.
        south = _encode(
            [{"geometry": f"POINT(1000 {_EXTENT})", "properties": {"name": "edge"}}],
            _Z, _X, _Y,
        )
        north = _encode(
            [{"geometry": "POINT(1000 0)", "properties": {"name": "edge"}}],
            _Z, _X, _Y + 1,
        )
        a = _projected_points(south, _Z, _X, _Y)["edge"]
        b = _projected_points(north, _Z, _X, _Y + 1)["edge"]
        self.assertAlmostEqual(a[0], b[0], places=5)
        self.assertAlmostEqual(a[1], b[1], places=5)


if __name__ == "__main__":
    unittest.main()
