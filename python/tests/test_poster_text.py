"""OSM poster text uses the same CSS line boxes as the Clean engine."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from poster_text import CSS_BASELINE_EM, CSS_LINE_HEIGHT, layout_poster_strip  # noqa: E402


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

    def test_credit_stays_under_the_coordinates(self):
        # The OSM credit is drawn at axes y=0.02, va='bottom'. Its top must
        # stay below the coordinate ink on every sheet in this list.
        for width, height in ((900, 1200), (5400, 7200), (7200, 9600), (10059, 14370)):
            laid = lisbon(width, height)
            coords = 0.0162 * min(width, height)
            ink_bottom = laid["coords_baseline"] + CAP_DESCENT * coords
            gap_from_bottom = height - ink_bottom
            credit = (30.0 / 3600.0) * min(width, height)
            credit_top_from_bottom = 0.02 * height + 1.04 * credit
            self.assertGreater(
                gap_from_bottom,
                credit_top_from_bottom,
                f"{width}x{height} credit overlaps coordinates",
            )

    def test_zero_tracking_stays_centred(self):
        laid = lisbon(5400, 7200, tracking=0)
        self.assertAlmostEqual(laid["city_x"], 0.5, places=6)


if __name__ == "__main__":
    unittest.main()
