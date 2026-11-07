import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyNeighbourhoodDetail,
  isNeighbourhoodToggleLayer,
  lineOpacityAtZoom,
  paintedRoadClasses,
} from '../detailed-style.js';
import {
  generateEditorDetailedStyle,
  mapVibeToResolved,
} from '../editor-detailed-style.js';
import { resolvePrintCamera, viewportPxForBounds, zoomForBounds } from '../print-parity.js';

const BOUNDS = { west: -9.157, south: 38.7004, east: -9.127, north: 38.7316 };

describe('neighbourhood style patch', () => {
  it('shows secondary and tertiary without raising residential opacity', () => {
    const style = {
      version: 8,
      layers: [
        {
          id: 'road-secondary',
          type: 'line',
          layout: { visibility: 'none' },
          paint: { 'line-color': '#E090A8', 'line-opacity': 1 },
        },
        {
          id: 'road-minor-mid',
          type: 'line',
          layout: { visibility: 'none' },
          paint: { 'line-opacity': 0.7 },
        },
        {
          id: 'road-minor-low',
          type: 'line',
          layout: { visibility: 'none' },
          paint: { 'line-opacity': 0 },
        },
        {
          id: 'road-minor-high',
          type: 'line',
          layout: { visibility: 'visible' },
          paint: {
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.12, 10.5, 0.48, 12.5, 0.88, 15, 1],
          },
        },
        {
          id: 'road-minor-high-casing',
          type: 'line',
          paint: {
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 10.5, 0.28, 15, 0.92],
          },
        },
        {
          id: 'road-major',
          type: 'line',
          layout: { visibility: 'visible' },
          paint: { 'line-width': 2 },
        },
      ],
    };
    const patched = applyNeighbourhoodDetail(style);
    const byId = Object.fromEntries(
      (patched.layers as Array<Record<string, any>>).map(l => [l.id, l]),
    );
    expect(byId['road-secondary'].layout.visibility).toBe('visible');
    expect(byId['road-minor-mid'].layout.visibility).toBe('visible');
    expect(byId['road-minor-low'].layout.visibility).toBe('visible');
    expect(byId['road-minor-low'].paint['line-opacity']).toBe(0);
    expect(byId['road-major'].paint['line-width']).toBe(2);
    expect(lineOpacityAtZoom(byId['road-minor-high'].paint['line-opacity'], 6)).toBeCloseTo(0.84, 5);
    expect(lineOpacityAtZoom(byId['road-minor-high-casing'].paint['line-opacity'], 6)).toBeCloseTo(0.72, 5);
    expect(isNeighbourhoodToggleLayer('road-minor-high')).toBe(false);
    expect(isNeighbourhoodToggleLayer('road-secondary-casing')).toBe(true);
    // The input style is not mutated.
    expect((style.layers[0].layout as { visibility: string }).visibility).toBe('none');
  });
});

describe('editor Detailed style', () => {
  const themes = JSON.parse(readFileSync(join(__dirname, '../../assets/themes.json'), 'utf8')) as Array<{
    id: string;
    name: string;
    map: Record<string, string>;
  }>;

  it('matches the studio layer set for a real theme', () => {
    const entry = themes.find(t => t.id === 'vintage_noir');
    expect(entry).toBeTruthy();
    const theme = mapVibeToResolved(entry!);
    const style = generateEditorDetailedStyle(theme, { distanceMeters: 4000 });
    const layers = style.layers as Array<Record<string, any>>;
    const ids = layers.map(l => l.id);
    expect(ids).not.toContain('landcover');
    expect(ids).toEqual(expect.arrayContaining([
      'water', 'waterway', 'building', 'aeroway', 'rail',
      'road-secondary', 'road-secondary-casing', 'road-major-casing',
    ]));
    const secondary = layers.find(l => l.id === 'road-secondary');
    const primary = layers.find(l => l.id === 'road-minor-high');
    expect(secondary.paint['line-color']).toBe(theme.map.roads.minor_high);
    expect(secondary.paint['line-color']).toBe(primary.paint['line-color']);
    expect(secondary.paint['line-color']).not.toBe(theme.map.roads.minor_mid);
    const rail = layers.find(l => l.id === 'rail');
    expect(rail.paint['line-dasharray']).toEqual([2, 1.6]);
    const building = layers.find(l => l.id === 'building');
    expect(building.paint['fill-opacity']).toBe(0.84);
    expect(building.minzoom).toBe(8.2);
    const low = layers.find(l => l.id === 'road-minor-low');
    expect(low.paint['line-opacity']).toBe(0);

    const zoom = zoomForBounds(BOUNDS, 3300, 4400);
    const painted = paintedRoadClasses(style, zoom).map(p => p.layerId);
    expect(painted).toEqual(expect.arrayContaining([
      'road-major', 'road-minor-high', 'road-secondary', 'road-minor-mid', 'rail',
    ]));
    expect(painted).not.toContain('road-minor-low');
    expect(painted).not.toContain('road-path');
    // Overview layers have faded out by a city-poster zoom.
    expect(painted.some(id => id.includes('overview'))).toBe(false);
  });
});

describe('detailed print camera', () => {
  it('uses the shared Clean camera: snapshot zoom and pixel ratio, no second width scale', () => {
    const zoom = zoomForBounds(BOUNDS, 3300, 4400);
    const view = viewportPxForBounds(BOUNDS, zoom);
    const poster = resolvePrintCamera({
      zoom,
      bounds: BOUNDS,
      outputWidth: 5400,
      outputHeight: 7200,
    });
    expect(poster.source).toBe('editor-viewport');
    expect(poster.zoom).toBeCloseTo(zoom, 6);
    expect(poster.pixelRatio).toBeGreaterThan(1);
    expect(poster.cssWidth).toBeCloseTo(view.w, 0);
    expect(poster.cssHeight).toBeCloseTo(view.h, 0);

    const preview = resolvePrintCamera({
      zoom,
      bounds: BOUNDS,
      outputWidth: 900,
      outputHeight: 1200,
    });
    expect(preview.zoom).toBeCloseTo(zoom, 6);
    expect(preview.pixelRatio).toBe(1);
    expect(preview.downscale).toBe(true);
  });
});
