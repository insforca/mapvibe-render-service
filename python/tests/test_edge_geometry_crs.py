"""project_graph leaves unsimplified edge geometries in lon/lat.

plot_graph then draws those degrees into a metre axis and the PNG is one
solid colour. Pyrosm graphs are unsimplified and carry LineStrings.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import networkx as nx
    import osmnx as ox
    from PIL import Image
    from shapely.geometry import LineString
    from mapvibe_render import _reproject_degree_edge_geometries  # noqa: E402
    _DEPS = True
except ImportError:
    _DEPS = False


@unittest.skipUnless(_DEPS, 'OSM render dependencies are not installed')
class EdgeGeometryCrsTest(unittest.TestCase):
    def _graph(self):
        # Two nodes a short walk apart in Lisbon, plus a curved geometry.
        g = nx.MultiDiGraph(crs='EPSG:4326')
        g.add_node(1, x=-9.145, y=38.720)
        g.add_node(2, x=-9.140, y=38.722)
        g.add_edge(
            1, 2,
            geometry=LineString([(-9.145, 38.720), (-9.143, 38.723), (-9.140, 38.722)]),
            highway='primary',
            length=500,
        )
        return g

    def test_project_graph_leaves_unsimplified_geometry_in_degrees(self):
        projected = ox.project_graph(self._graph())
        geom = projected.edges[1, 2, 0]['geometry']
        x, y = geom.coords[0]
        self.assertLessEqual(abs(x), 180)
        self.assertGreater(abs(projected.nodes[1]['x']), 1000)

    def test_helper_moves_geometry_into_the_graph_crs_and_the_sheet_is_not_blank(self):
        projected = ox.project_graph(self._graph())
        fixed = _reproject_degree_edge_geometries(projected)
        geom = fixed.edges[1, 2, 0]['geometry']
        x, y = geom.coords[0]
        self.assertGreater(abs(x), 1000)
        self.assertAlmostEqual(x, fixed.nodes[1]['x'], delta=50)
        self.assertAlmostEqual(y, fixed.nodes[1]['y'], delta=50)

        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(2, 2), facecolor='#F8F8F6')
        ax.set_facecolor('#F8F8F6')
        ox.plot_graph(fixed, ax=ax, node_size=0, edge_color='#222222', edge_linewidth=2, show=False, close=False)
        # Frame on the projected nodes, the way fulfillment frames on bounds.
        xs = [fixed.nodes[n]['x'] for n in fixed.nodes]
        ys = [fixed.nodes[n]['y'] for n in fixed.nodes]
        pad = 20
        ax.set_xlim(min(xs) - pad, max(xs) + pad)
        ax.set_ylim(min(ys) - pad, max(ys) + pad)
        fig.savefig('/tmp/edge-crs-check.png', dpi=40, facecolor='#F8F8F6')
        plt.close(fig)
        im = Image.open('/tmp/edge-crs-check.png')
        colors = im.getcolors(maxcolors=50_000)
        self.assertIsNotNone(colors)
        self.assertGreater(len(colors), 1)


if __name__ == '__main__':
    unittest.main()
