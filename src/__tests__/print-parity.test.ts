import { describe, expect, it } from 'vitest';
import {
  CLEAN_MINOR_HIGH_CASING_OPACITY,
  CLEAN_MINOR_HIGH_LINE_OPACITY,
  FALLBACK_INTERNAL_WIDTH_PX,
  MAP_OVERZOOM_SCALE,
  OVERZOOM_LINE_WIDTH_SCALE,
  boundsForViewport,
  evalInterpolate,
  EDITOR_BOTTOM_FADE_HEIGHT,
  editorBottomFadeAlpha,
  fadeKind,
  preparePrintStyle,
  resolvePrintCamera,
  viewportPxForBounds,
  zoomForBounds,
} from '../print-parity.js';

/**
 * Lisbon, 18×24 portrait. Internal editor map is a 480×640 CSS frame
 * overzoomed ×5.5 (studio MapPreview), which is the size getBounds() was
 * measured against. A 300 DPI print of that sheet is 5400×7200.
 */
const EDITOR_ZOOM = 12.4;
const INTERNAL_W = 480 * MAP_OVERZOOM_SCALE;
const INTERNAL_H = 640 * MAP_OVERZOOM_SCALE;
const PRINT_W = 18 * 300;
const PRINT_H = 24 * 300;
const LISBON: [number, number] = [-9.1393, 38.7223];

function lisbonBounds() {
  return boundsForViewport(LISBON, EDITOR_ZOOM, INTERNAL_W, INTERNAL_H);
}

describe('editor camera (gap 1)', () => {
  it('recovers the internal viewport from bounds + zoom', () => {
    const bounds = lisbonBounds();
    const vp = viewportPxForBounds(bounds, EDITOR_ZOOM);
    expect(vp.w).toBeCloseTo(INTERNAL_W, 4);
    expect(vp.h).toBeCloseTo(INTERNAL_H, 4);
    expect(zoomForBounds(bounds, vp.w, vp.h)).toBeCloseTo(EDITOR_ZOOM, 6);
  });

  it('keeps the editor zoom when the print canvas is larger than the internal map', () => {
    const bounds = lisbonBounds();
    const shifted = zoomForBounds(bounds, PRINT_W, PRINT_H);
    // The old print path. A wider canvas reads as a higher zoom, so width
    // stops and the Clean opacity curve both move.
    expect(shifted - EDITOR_ZOOM).toBeGreaterThan(0.5);

    const camera = resolvePrintCamera({
      zoom: EDITOR_ZOOM,
      bounds,
      outputWidth: PRINT_W,
      outputHeight: PRINT_H,
    });
    expect(camera.zoom).toBe(EDITOR_ZOOM);
    expect(camera.cssWidth).toBe(Math.round(INTERNAL_W));
    expect(camera.cssHeight).toBe(Math.round(INTERNAL_H));
    // Terraink: container is already preview×overzoom, so ratio = export/internal
    // (= exportScale/overzoom) and is never below 1.
    expect(camera.pixelRatio).toBeGreaterThan(1);
    expect(camera.pixelRatio).toBeCloseTo(PRINT_W / INTERNAL_W, 2);
    expect(camera.pixelRatio).toBeCloseTo(PRINT_H / INTERNAL_H, 2);
    expect(camera.source).toBe('editor-viewport');
  });

  it('does not divide by overzoom a second time', () => {
    const camera = resolvePrintCamera({
      zoom: EDITOR_ZOOM,
      bounds: lisbonBounds(),
      outputWidth: PRINT_W,
      outputHeight: PRINT_H,
    });
    const exportScale = PRINT_W / 480;
    const terrainkRatio = exportScale / MAP_OVERZOOM_SCALE;
    expect(camera.pixelRatio).toBeCloseTo(terrainkRatio, 2);
    // Widths in the style are already × 5.5^0.8. The framebuffer scale is the
    // only extra factor, so a stroke's share of the sheet matches the preview.
    expect(OVERZOOM_LINE_WIDTH_SCALE).toBeCloseTo(Math.pow(5.5, 0.8), 8);
    const stylePx = 1.14 * OVERZOOM_LINE_WIDTH_SCALE;
    const printFraction = (stylePx * camera.pixelRatio) / PRINT_W;
    const previewFraction = (stylePx / MAP_OVERZOOM_SCALE) / 480;
    expect(printFraction).toBeCloseTo(previewFraction, 4);
  });

  it('clamps pixelRatio to 1 and downscales when the output is smaller than the internal map', () => {
    const camera = resolvePrintCamera({
      zoom: EDITOR_ZOOM,
      bounds: lisbonBounds(),
      outputWidth: 480,
      outputHeight: 640,
    });
    expect(camera.zoom).toBe(EDITOR_ZOOM);
    expect(camera.pixelRatio).toBe(1);
    expect(camera.cssWidth).toBe(Math.round(INTERNAL_W));
    expect(camera.bufferWidth).toBe(camera.cssWidth);
    expect(camera.downscale).toBe(true);
  });

  it('uses an explicit snapshot viewport when the editor stored one', () => {
    const camera = resolvePrintCamera({
      zoom: EDITOR_ZOOM,
      bounds: lisbonBounds(),
      outputWidth: PRINT_W,
      outputHeight: PRINT_H,
      mapWidth: 3000,
      mapHeight: 4000,
    });
    expect(camera.source).toBe('snapshot-viewport');
    expect(camera.cssWidth).toBe(3000);
    expect(camera.cssHeight).toBe(4000);
    expect(camera.zoom).toBe(EDITOR_ZOOM);
    expect(camera.pixelRatio).toBeCloseTo(PRINT_W / 3000, 3);
  });

  it('expands the sheet around the editor bounds for canvas wrap without changing zoom', () => {
    const camera = resolvePrintCamera({
      zoom: EDITOR_ZOOM,
      bounds: lisbonBounds(),
      outputWidth: PRINT_W,
      outputHeight: PRINT_H,
      visibleFractionW: 0.8,
      visibleFractionH: 0.75,
    });
    expect(camera.zoom).toBe(EDITOR_ZOOM);
    expect(camera.cssWidth).toBe(Math.round(INTERNAL_W / 0.8));
    expect(camera.cssHeight).toBe(Math.round(INTERNAL_H / 0.75));
  });

  it('derives a print-size-independent zoom when the snapshot has bounds but no zoom', () => {
    const bounds = lisbonBounds();
    const small = resolvePrintCamera({
      zoom: 0,
      bounds,
      outputWidth: 900,
      outputHeight: 1200,
    });
    const large = resolvePrintCamera({
      zoom: Number.NaN,
      bounds,
      outputWidth: PRINT_W,
      outputHeight: PRINT_H,
    });
    expect(small.source).toBe('fallback-zoom');
    expect(large.source).toBe('fallback-zoom');
    expect(small.zoom).toBeCloseTo(large.zoom, 6);
    expect(small.cssWidth).toBe(FALLBACK_INTERNAL_WIDTH_PX);
    // Must not be the old print-pixel zoom.
    expect(Math.abs(small.zoom - zoomForBounds(bounds, 900, 1200))).toBeGreaterThan(0.2);
  });

  it('keeps a boundless render on the output pixel grid at ratio 1', () => {
    const camera = resolvePrintCamera({
      zoom: 11,
      outputWidth: 800,
      outputHeight: 600,
    });
    expect(camera).toMatchObject({
      zoom: 11,
      cssWidth: 800,
      cssHeight: 600,
      pixelRatio: 1,
      bufferWidth: 800,
      bufferHeight: 600,
      downscale: false,
      source: 'output-pixels',
    });
  });
});

describe('Clean arterial opacity (gap 7)', () => {
  const terrainkOpacity = ['interpolate', ['linear'], ['zoom'], 6, 0.84, 10, 0.92, 18, 1];

  function style() {
    return {
      version: 8,
      layers: [
        {
          id: 'road-minor-high',
          type: 'line',
          paint: {
            'line-color': '#444444',
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.796, 10, 3.124, 14, 5.779],
            'line-opacity': terrainkOpacity,
          },
        },
        {
          id: 'road-minor-high-casing',
          type: 'line',
          paint: {
            'line-color': '#cccccc',
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.604, 10, 4.53],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.72, 12, 0.85, 18, 0.92],
          },
        },
        {
          id: 'road-major-casing',
          type: 'line',
          paint: { 'line-color': '#cccccc', 'line-width': 5.39 },
        },
        {
          id: 'waterway',
          type: 'line',
          paint: {
            'line-color': '#dddddb',
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.781, 12, 3.124, 18, 9.372],
          },
        },
        {
          id: 'building',
          type: 'fill',
          minzoom: 8,
          paint: { 'fill-color': '#bbbbba', 'fill-opacity': 0.84 },
        },
      ],
    };
  }

  it('evaluates the editor curve at the editor zoom, not the style-file curve', () => {
    expect(evalInterpolate(CLEAN_MINOR_HIGH_LINE_OPACITY, 11)).toBeCloseTo(0.58, 5);
    expect(evalInterpolate(terrainkOpacity, 11)).toBeCloseTo(0.93, 5);
    expect(evalInterpolate(CLEAN_MINOR_HIGH_CASING_OPACITY, 11)).toBeCloseTo(0.3725, 5);
  });

  it('writes the Clean trunk/primary curves and does not rescale widths', () => {
    const before = style();
    const after = preparePrintStyle(before, { minorRoads: false });
    const high = after.layers.find((l) => l.id === 'road-minor-high')!;
    const casing = after.layers.find((l) => l.id === 'road-minor-high-casing')!;
    const water = after.layers.find((l) => l.id === 'waterway')!;
    const major = after.layers.find((l) => l.id === 'road-major-casing')!;
    const building = after.layers.find((l) => l.id === 'building')!;

    expect(high.paint['line-opacity']).toEqual([...CLEAN_MINOR_HIGH_LINE_OPACITY]);
    expect(casing.paint['line-opacity']).toEqual([...CLEAN_MINOR_HIGH_CASING_OPACITY]);
    expect(high.paint['line-width']).toEqual(before.layers[0].paint['line-width']);
    expect(casing.paint['line-width']).toEqual(before.layers[1].paint['line-width']);
    expect(water.paint['line-width']).toEqual(before.layers[3].paint['line-width']);
    expect(major.paint['line-width']).toBe(5.39);
    expect(building).toEqual(before.layers[4]);
    // Caller style is not mutated.
    expect(before.layers[0].paint['line-opacity']).toEqual(terrainkOpacity);
  });

  it('leaves the Terraink curve in place for neighbourhood / Detailed', () => {
    const after = preparePrintStyle(style(), { minorRoads: true });
    const high = after.layers.find((l) => l.id === 'road-minor-high')!;
    expect(high.paint['line-opacity']).toEqual(terrainkOpacity);
  });

  it('keeps the snapshot opacity when the request carries the editor style', () => {
    // Wide view. The Clean override is lighter than the curve live getStyle() returns.
    expect(evalInterpolate(CLEAN_MINOR_HIGH_LINE_OPACITY, 11.5)).toBeCloseTo(0.68, 5);
    expect(evalInterpolate(terrainkOpacity, 11.5)).toBeCloseTo(0.935, 5);
    const after = preparePrintStyle(style(), { minorRoads: false, editorStyle: true });
    const high = after.layers.find((l) => l.id === 'road-minor-high')!;
    const casing = after.layers.find((l) => l.id === 'road-minor-high-casing')!;
    expect(high.paint['line-opacity']).toEqual(terrainkOpacity);
    expect(casing.paint['line-opacity']).toEqual(
      style().layers[1].paint['line-opacity'],
    );
    // Without an editor style the Clean curve is still installed.
    const bare = preparePrintStyle(style(), { minorRoads: false });
    expect(bare.layers.find((l) => l.id === 'road-minor-high')!.paint['line-opacity'])
      .toEqual([...CLEAN_MINOR_HIGH_LINE_OPACITY]);
  });
});

describe('fullbleed fade (gap 6)', () => {
  it('maps fullbleed onto the same bottom ease-in as the editor default', () => {
    expect(fadeKind('fullbleed')).toBe('bottom');
    expect(fadeKind('default')).toBe('bottom');
    expect(fadeKind('none')).toBe('none');
    expect(fadeKind('text')).toBe('text');
  });

  it('matches the editor .poster-fade band: bottom 14%, clear at 86% of the height', () => {
    expect(EDITOR_BOTTOM_FADE_HEIGHT).toBeCloseTo(0.14, 5);
    // Above the band the map is untouched. The city ink starts near 0.855,
    // just above this edge, so it is not sitting in a tall wash.
    expect(editorBottomFadeAlpha(0.80)).toBe(0);
    expect(editorBottomFadeAlpha(0.86)).toBe(0);
    // 90% of the height is 4/14 of the way up the band.
    expect(editorBottomFadeAlpha(0.90)).toBeCloseTo(0.21119, 4);
    // 94% of the height. The old city-anchor band was more opaque here.
    expect(editorBottomFadeAlpha(0.94)).toBeCloseTo(0.58122, 4);
    expect(editorBottomFadeAlpha(1)).toBe(1);
  });
});
