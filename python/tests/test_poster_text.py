"""OSM poster text uses the same CSS line boxes as the Clean engine."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from poster_text import (  # noqa: E402
    CSS_BASELINE_EM,
    CSS_LINE_HEIGHT,
    attribution_color,
    bottom_fade_alpha,
    credit_layout,
    layout_poster_strip,
)


# Cap ink of Roboto above/below the alphabetic baseline, as a fraction of em.
CAP_ASCENT = 0.73
CAP_DESCENT = 0.01


def lisbon(width, height, tracking=0.45):
    short = min(width, height)
    return layout_poster_strip(
        width,
        height,
        0.0694 * short,
        0.0255 * short,
        0.0162 * short,
        tracking_em=tracking,
    )


class PosterStripTest(unittest.TestCase):
    def test_lisbon_18x24_matches_the_editor(self):
        # 18×24. Fractions of the sheet, the same numbers as the editor DOM
        # and the Clean-engine measurement.
        width, height = 5400.0, 7200.0
        laid = lisbon(width, height)

        def frac(y):
            return y / height

        city = 0.0694 * width
        self.assertAlmostEqual(frac(laid["strip_top"]), 0.8366, delta=0.002)
        self.assertAlmostEqual(frac(laid["city_box_top"]), 0.8459, delta=0.002)
        self.assertAlmostEqual(frac(laid["city_box_bottom"]), 0.9057, delta=0.002)
        ink_top = laid["city_baseline"] - CAP_ASCENT * city
        ink_bottom = laid["city_baseline"] + CAP_DESCENT * city
        self.assertAlmostEqual(frac(ink_top), 0.855, delta=0.002)
        self.assertAlmostEqual(frac(ink_bottom), 0.893, delta=0.002)
        self.assertAlmostEqual(frac(laid["rule_top"]), 0.910, delta=0.002)
        self.assertAlmostEqual(frac(laid["rule_top"] - ink_bottom), 0.0171, delta=0.002)
        country = 0.0255 * width
        self.assertAlmostEqual(frac(laid["country_baseline"] - CAP_ASCENT * country), 0.922, delta=0.002)
        self.assertAlmostEqual(frac(laid["country_baseline"] + CAP_DESCENT * country), 0.935, delta=0.002)
        coords = 0.0162 * width
        self.assertAlmostEqual(frac(laid["coords_baseline"] - CAP_ASCENT * coords), 0.953, delta=0.002)
        self.assertAlmostEqual(frac(laid["coords_baseline"] + CAP_DESCENT * coords), 0.963, delta=0.002)
        self.assertAlmostEqual(laid["rule_x1"] - laid["rule_x0"], 0.185, delta=0.001)
        self.assertAlmostEqual(0.5 - laid["city_x"], 0.0156, delta=0.001)
        self.assertAlmostEqual(laid["city_baseline"], laid["city_box_top"] + CSS_BASELINE_EM * city, places=6)
        self.assertAlmostEqual(laid["city_box_bottom"] - laid["city_box_top"], CSS_LINE_HEIGHT * city, places=6)

    def test_credit_matches_the_canvas_anchors(self):
        # Same anchors as drawPosterText: 2% sides, glyph bottom 6 CSS px
        # up, size 30px on a 3600px short side. The old OSM line sat at
        # axes y=0.02 with only the copyright.
        for width, height in ((900, 1200), (5400, 7200), (7200, 9600), (10059, 14370)):
            laid = lisbon(width, height)
            credit = credit_layout(width, height)
            coords = 0.0162 * min(width, height)
            ink_bottom = laid["coords_baseline"] + CAP_DESCENT * coords
            credit_top = credit["y"] - 1.04 * credit["size"]
            self.assertGreater(
                credit_top,
                ink_bottom,
                f"{width}x{height} credit overlaps coordinates",
            )
            self.assertAlmostEqual(credit["left"] / width, 0.02, places=6)
            self.assertAlmostEqual(credit["right"] / width, 0.98, places=6)
            self.assertAlmostEqual(credit["alpha"], 0.9, places=6)
            short = min(width, height)
            self.assertAlmostEqual(credit["size"], 30.0 * short / 3600.0, places=4)
            self.assertAlmostEqual(credit["inset"], 6.0 * short / 482.390625, places=4)

    def test_bottom_fade_matches_the_editor_band(self):
        self.assertEqual(bottom_fade_alpha(0.80), 0.0)
        self.assertEqual(bottom_fade_alpha(0.86), 0.0)
        self.assertAlmostEqual(bottom_fade_alpha(0.90), 0.21119, places=4)
        self.assertAlmostEqual(bottom_fade_alpha(0.94), 0.58122, places=4)
        self.assertEqual(bottom_fade_alpha(1.0), 1.0)
        self.assertEqual(attribution_color("#F3EFE6"), "#0e1822")
        self.assertEqual(attribution_color("#1B2A4A"), "#f5faff")

    def test_zero_tracking_stays_centred(self):
        laid = lisbon(5400, 7200, tracking=0)
        self.assertAlmostEqual(laid["city_x"], 0.5, places=6)


if __name__ == "__main__":
    unittest.main()
