/**
 * Clean-print camera and style prep.
 *
 * The editor (mapvibe-studio, Terraink's model) stores line widths already
 * multiplied by 5.5^0.8 and CSS-shrinks the map by 1/5.5. Zoom stops are
 * evaluated at that internal map's zoom. Terraink's exporter keeps that zoom
 * and grows the framebuffer with
 *   pixelRatio = (exportPx / previewPx) / overzoom
 * which is exportPx / internalPx, and never below 1.
 *
 * useStoreConfig persists zoom, center, bearing, pitch, and bounds. It does
 * not persist the internal container size or the overzoom. At bearing 0 and
 * pitch 0 those bounds are exactly the internal viewport, so the viewport
 * in pixels is determined by bounds + zoom. mapWidth / mapHeight, when a
 * future snapshot includes them (map.getContainer().clientWidth/Height, the
 * pre-CSS-scale size), replace that derivation and stay correct when the
 * map is rotated or pitched.
 */

export const MAP_OVERZOOM_SCALE = 5.5;
/** Already baked into generateMapStyle line-width stops. Do not apply again. */
export const OVERZOOM_LINE_WIDTH_SCALE = Math.pow(MAP_OVERZOOM_SCALE, 0.8);
/** Terraink MIN_EFFECTIVE_CONTAINER_PX. Used only when a snapshot has no zoom. */
export const FALLBACK_INTERNAL_WIDTH_PX = 3300;
const TILE_SIZE = 512;

export const CLEAN_MINOR_HIGH_LINE_OPACITY = [
  'interpolate', ['linear'], ['zoom'],
  7, 0.12,
  10.5, 0.48,
  12.5, 0.88,
  15, 1,
] as const;

export const CLEAN_MINOR_HIGH_CASING_OPACITY = [
  'interpolate', ['linear'], ['zoom'],
  7, 0,
  10.5, 0.28,
  12.5, 0.65,
  15, 0.92,
] as const;

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type FadeKind = 'none' | 'text' | 'bottom';

/**
 * Editor GradientFades maps `fullbleed` onto the same bottom ease-in as
 * `default`. `none` draws nothing. `text` keeps the legacy top-and-bottom wash.
 */
export function fadeKind(fs: string | undefined | null): FadeKind {
  if (fs === 'none') return 'none';
  if (fs === 'text') return 'text';
  return 'bottom';
}

export function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

export function mercatorLat(y: number): number {
  return ((2 * Math.atan(Math.exp(y))) - Math.PI / 2) * (180 / Math.PI);
}

export function zoomForBounds(
  b: MapBounds,
  vpW: number,
  vpH: number,
  tileSize = TILE_SIZE,
  maxZoom = Infinity,
): number {
  const lngRange = Math.abs(b.east - b.west) * (Math.PI / 180);
  const latRange = Math.abs(mercatorY(b.north) - mercatorY(b.south));
  if (lngRange < 1e-9 || latRange < 1e-9) return maxZoom;
  const zW = Math.log2((vpW * 2 * Math.PI) / (lngRange * tileSize));
  const zH = Math.log2((vpH * 2 * Math.PI) / (latRange * tileSize));
  return Math.min(zW, zH, maxZoom);
}

/** Internal pixels that frame `b` at `zoom`. Inverse of zoomForBounds. */
export function viewportPxForBounds(
  b: MapBounds,
  zoom: number,
  tileSize = TILE_SIZE,
): { w: number; h: number } {
  const world = tileSize * Math.pow(2, zoom);
  const lngRange = Math.abs(b.east - b.west) * (Math.PI / 180);
  const latRange = Math.abs(mercatorY(b.north) - mercatorY(b.south));
  return {
    w: (lngRange * world) / (2 * Math.PI),
    h: (latRange * world) / (2 * Math.PI),
  };
}

/** Bounds of a north-up viewport centered on `center` ([lng, lat]). */
export function boundsForViewport(
  center: [number, number],
  zoom: number,
  cssW: number,
  cssH: number,
  tileSize = TILE_SIZE,
): MapBounds {
  const world = tileSize * Math.pow(2, zoom);
  const lngSpan = (cssW / world) * 360;
  const mercSpan = (cssH / world) * 2 * Math.PI;
  const mercC = mercatorY(center[1]);
  return {
    west: center[0] - lngSpan / 2,
    east: center[0] + lngSpan / 2,
    north: mercatorLat(mercC + mercSpan / 2),
    south: mercatorLat(mercC - mercSpan / 2),
  };
}

export type PrintCameraSource =
  | 'editor-viewport'
  | 'snapshot-viewport'
  | 'fallback-zoom'
  | 'output-pixels';

export interface PrintCamera {
  zoom: number;
  cssWidth: number;
  cssHeight: number;
  /** Value passed to the native Map `ratio`. Always >= 1. */
  pixelRatio: number;
  bufferWidth: number;
  bufferHeight: number;
  outputWidth: number;
  outputHeight: number;
  /** Framebuffer is not the output size; caller scales with a high-quality kernel. */
  downscale: boolean;
  source: PrintCameraSource;
}

export interface PrintCameraInput {
  zoom: number;
  bounds?: MapBounds;
  outputWidth: number;
  outputHeight: number;
  /** Visible window / full sheet. 1 for posters and frames. */
  visibleFractionW?: number;
  visibleFractionH?: number;
  /** Internal map container, from a future snapshot. Pre-CSS-scale pixels. */
  mapWidth?: number;
  mapHeight?: number;
  maxZoom?: number;
}

function clampFraction(v: number | undefined): number {
  if (v == null || !Number.isFinite(v) || v <= 0 || v > 1) return 1;
  return v;
}

/** HeadlessFrontend framebuffer edge: uint32(float(css) * float(ratio)). */
export function stillExtent(css: number, ratio: number): number {
  const product = Math.fround(Math.fround(css) * Math.fround(ratio));
  if (!Number.isFinite(product) || product <= 0) return 1;
  return Math.trunc(product);
}

function sheetSize(
  visibleW: number,
  visibleH: number,
  fractionW: number,
  fractionH: number,
): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(visibleW / fractionW)),
    h: Math.max(1, Math.round(visibleH / fractionH)),
  };
}

/**
 * Logical viewport + pixel ratio for one still.
 *
 * The zoom is the editor zoom whenever the snapshot has one, so line-width
 * and opacity stops do not move when the sheet has more pixels. Resolution
 * is the pixel ratio. Bounds stay the framed window: the logical viewport is
 * the internal map (expanded by the canvas wrap), not the print pixel grid.
 */
export function resolvePrintCamera(input: PrintCameraInput): PrintCamera {
  const outputWidth = Math.max(1, Math.round(input.outputWidth));
  const outputHeight = Math.max(1, Math.round(input.outputHeight));
  const fractionW = clampFraction(input.visibleFractionW);
  const fractionH = clampFraction(input.visibleFractionH);
  const maxZoom = input.maxZoom ?? Infinity;

  if (!input.bounds) {
    const zoom = Math.min(Number.isFinite(input.zoom) ? input.zoom : 0, maxZoom);
    return {
      zoom,
      cssWidth: outputWidth,
      cssHeight: outputHeight,
      pixelRatio: 1,
      bufferWidth: outputWidth,
      bufferHeight: outputHeight,
      outputWidth,
      outputHeight,
      downscale: false,
      source: 'output-pixels',
    };
  }

  const explicitViewport =
    input.mapWidth != null && input.mapWidth > 0 &&
    input.mapHeight != null && input.mapHeight > 0;

  let zoom = input.zoom;
  let source: PrintCameraSource = explicitViewport ? 'snapshot-viewport' : 'editor-viewport';
  let visibleW: number;
  let visibleH: number;

  if (!Number.isFinite(zoom) || zoom <= 0) {
    const sheetW = FALLBACK_INTERNAL_WIDTH_PX;
    const sheetH = Math.max(1, Math.round(sheetW * (outputHeight / outputWidth)));
    visibleW = sheetW * fractionW;
    visibleH = sheetH * fractionH;
    zoom = zoomForBounds(input.bounds, visibleW, visibleH, TILE_SIZE, maxZoom);
    source = 'fallback-zoom';
    const css = sheetSize(visibleW, visibleH, fractionW, fractionH);
    return finishCamera(zoom, css.w, css.h, outputWidth, outputHeight, source);
  }

  if (zoom > maxZoom) zoom = maxZoom;

  if (explicitViewport) {
    visibleW = input.mapWidth as number;
    visibleH = input.mapHeight as number;
  } else {
    const derived = viewportPxForBounds(input.bounds, zoom);
    visibleW = derived.w;
    visibleH = derived.h;
  }

  const css = sheetSize(visibleW, visibleH, fractionW, fractionH);
  return finishCamera(zoom, css.w, css.h, outputWidth, outputHeight, source);
}

function finishCamera(
  zoom: number,
  cssWidth: number,
  cssHeight: number,
  outputWidth: number,
  outputHeight: number,
  source: PrintCameraSource,
): PrintCamera {
  const desiredW = outputWidth / cssWidth;
  const desiredH = outputHeight / cssHeight;
  // One ratio. Terraink takes the larger axis and draws the GL canvas into
  // the export bitmap, and it never goes below 1 (a smaller export is scaled
  // down afterwards, which keeps stroke weight proportional).
  const pixelRatio = Math.fround(Math.max(desiredW, desiredH, 1));
  const bufferWidth = stillExtent(cssWidth, pixelRatio);
  const bufferHeight = stillExtent(cssHeight, pixelRatio);
  return {
    zoom,
    cssWidth,
    cssHeight,
    pixelRatio,
    bufferWidth,
    bufferHeight,
    outputWidth,
    outputHeight,
    downscale: bufferWidth !== outputWidth || bufferHeight !== outputHeight,
    source,
  };
}

/** Linear zoom interpolate. Stops outside the range clamp, matching MapLibre. */
export function evalInterpolate(expr: unknown, zoom: number): number | undefined {
  if (!Array.isArray(expr) || expr[0] !== 'interpolate' || expr.length < 5) return undefined;
  const stops: Array<{ z: number; v: number }> = [];
  for (let i = 3; i + 1 < expr.length; i += 2) {
    const z = Number(expr[i]);
    const v = Number(expr[i + 1]);
    if (!Number.isFinite(z) || !Number.isFinite(v)) return undefined;
    stops.push({ z, v });
  }
  if (stops.length === 0) return undefined;
  if (zoom <= stops[0].z) return stops[0].v;
  const last = stops[stops.length - 1];
  if (zoom >= last.z) return last.v;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (zoom >= a.z && zoom <= b.z) {
      const t = (b.z - a.z) === 0 ? 0 : (zoom - a.z) / (b.z - a.z);
      return a.v + t * (b.v - a.v);
    }
  }
  return undefined;
}

interface StyleLayer {
  id?: string;
  type?: string;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Clean print style. Does not multiply line-width: those stops are already
 * in editor pixels. On the arteries (Clean) path, trunk/primary and their
 * casing take the opacity curves the editor applies with setPaintProperty.
 * Neighbourhood leaves the style-file curve alone.
 */
export function preparePrintStyle<T extends { layers?: StyleLayer[] }>(
  style: T,
  opts?: { minorRoads?: boolean },
): T {
  const copy = JSON.parse(JSON.stringify(style)) as T;
  if (opts?.minorRoads === true || !Array.isArray(copy.layers)) return copy;
  for (const layer of copy.layers) {
    if (String(layer.type ?? '') !== 'line') continue;
    const opacity =
      layer.id === 'road-minor-high' ? CLEAN_MINOR_HIGH_LINE_OPACITY :
      layer.id === 'road-minor-high-casing' ? CLEAN_MINOR_HIGH_CASING_OPACITY :
      null;
    if (!opacity) continue;
    const paint = (layer.paint ?? {}) as Record<string, unknown>;
    paint['line-opacity'] = [...opacity];
    layer.paint = paint;
  }
  return copy;
}
