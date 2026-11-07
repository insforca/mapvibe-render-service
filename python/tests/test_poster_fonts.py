"""Detailed poster text uses the same Roboto faces as the Clean engine."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poster_fonts import resolve_poster_fonts  # noqa: E402

_PYTHON_DIR = Path(__file__).resolve().parents[1]


def _names_face(path: Path, text: str) -> bool:
    data = path.read_bytes()
    return text.encode("latin1") in data or text.encode("utf-16-be") in data


class PosterFontTest(unittest.TestCase):
    def test_city_country_and_coords_resolve_to_editor_faces(self):
        fonts = resolve_poster_fonts(str(_PYTHON_DIR))
        self.assertEqual(set(fonts), {"bold", "light", "regular"})
        bold = Path(fonts["bold"])
        light = Path(fonts["light"])
        regular = Path(fonts["regular"])
        self.assertEqual(bold.name, "Roboto-Bold.ttf")
        self.assertEqual(light.name, "Roboto-Light.ttf")
        self.assertEqual(regular.name, "Roboto-Regular.ttf")
        self.assertNotEqual(bold, light)
        self.assertNotEqual(light, regular)
        self.assertTrue(_names_face(bold, "Roboto"))
        self.assertTrue(_names_face(light, "Roboto"))
        self.assertTrue(_names_face(regular, "Roboto"))
        for path in (bold, light, regular):
            self.assertNotIn("Playfair", path.name)
            self.assertNotIn("DejaVu", path.name)
            self.assertNotIn("Plex", path.name)

    def test_missing_face_does_not_return_a_partial_set(self):
        self.assertEqual(resolve_poster_fonts("/no/such/renderer"), {})


if __name__ == "__main__":
    unittest.main()
