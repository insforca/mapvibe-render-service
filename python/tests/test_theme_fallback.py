"""A provided theme must not quietly become terracotta or land-coloured water."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from mapvibe_render import load_theme  # noqa: E402
except ImportError:
    load_theme = None  # CI's python job does not install the OSM stack.


@unittest.skipUnless(load_theme, 'OSM render dependencies are not installed')
class ThemeFallbackTest(unittest.TestCase):
    def test_named_theme_file_loads(self):
        theme = load_theme('vintage_noir')
        self.assertEqual(theme['road_motorway'], '#222222')
        self.assertNotEqual(theme['bg'], '#F5EDE4')

    def test_missing_theme_does_not_become_terracotta(self):
        with self.assertRaises(RuntimeError) as caught:
            load_theme('tk_not_a_real_theme')
        message = str(caught.exception)
        self.assertIn('tk_not_a_real_theme', message)
        self.assertIn('terracotta', message.lower())
        self.assertNotIn('#A0522D', message)


if __name__ == '__main__':
    unittest.main()
