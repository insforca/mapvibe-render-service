"""No-bounds preview framing fills the poster instead of letterboxing a square."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from print_window import ground_crop_wgs84  # noqa: E402

_LAT = 38.7223
_LNG = -9.1393
_CROP = 1320.0  # metres; server crop for osmDist=2200 on a 900×1200 sheet
_W_IN = 900 / 96
_H_IN = 1200 / 96
_R = 6_371_000.0


def _ground_metres(west, south, east, north, lat):
    height = (north - south) * math.pi / 180.0 * _R
    width = (east - west) * math.pi / 180.0 * _R * math.cos(math.radians(lat))
    return width, height


class PreviewCropTest(unittest.TestCase):
    def test_portrait_crop_matches_poster_not_the_square_fetch(self):
        west, south, east, north = ground_crop_wgs84(_LAT, _LNG, _CROP, _W_IN, _H_IN)
        width, height = _ground_metres(west, south, east, north, _LAT)
        self.assertAlmostEqual(height / width, _H_IN / _W_IN, places=3)
        # Square fetch of half-side 2200 m would letterbox on this sheet.
        # The crop is the inscribed portrait window, still inside that fetch.
        self.assertAlmostEqual(math.hypot(width / 2, height / 2), 2200, delta=2)
        self.assertLess(width / 2, 2200)
        self.assertLess(height / 2, 2200)
        self.assertAlmostEqual((south + north) / 2, _LAT, places=6)
        self.assertAlmostEqual((west + east) / 2, _LNG, places=6)

    def test_square_sheet_is_a_square_on_the_ground(self):
        west, south, east, north = ground_crop_wgs84(_LAT, _LNG, 1000, 10, 10)
        width, height = _ground_metres(west, south, east, north, _LAT)
        self.assertAlmostEqual(width, 2000, delta=1)
        self.assertAlmostEqual(height, 2000, delta=1)


if __name__ == "__main__":
    unittest.main()
