/**
 * Detailed-mode adjustments on an editor MapLibre style.
 *
 * The live snapshot is already the style the customer approved, including
 * neighbourhood visibility and the Terraink opacity curves. This module is
 * for the staff `detailedRoads` override, which can land on a Clean snapshot
 * whose secondary / tertiary layers were hidden and whose trunk/primary
 * opacity was replaced with the arteries curve.
 *
 * It does not invent residential geometry. Classes the style paints at
 * opacity 0 stay at opacity 0 — that is the editor default for minor-low
 * and paths.
 */

export interface PaintedRoadClass {
  layerId: string;
  classes: string[];
  opacity: number;
}

const DETAILED_MINOR_HIGH_OPACITY = [
  'interpolate', ['linear'], ['zoom'],
  6, 0.84, 10, 0.92, 18, 1,
];

const DETAILED_MINOR_HIGH_CASING_OPACITY = [
  'interpolate', ['linear'], ['zoom'],
  6, 0.72, 12, 0.85, 18, 0.92,
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Layers Clean hides and Detailed shows. Major and minor-high stay as they are. */
export function isNeighbourhoodToggleLayer(id: string): boolean {
  if (/minor-high|major/.test(id)) return false;
  return /secondary|minor-mid|minor-low|overview-mid|overview-low|-path|path-/.test(id);
}

function opacityStops(expr: unknown): Array<[number, number]> | null {
  if (!Array.isArray(expr) || expr[0] !== 'interpolate') return null;
  const stops: Array<[number, number]> = [];
  // ["interpolate", interpolation, input, z0, v0, z1, v1, ...]
  for (let i = 3; i < expr.length; i += 2) {
    const z = expr[i];
    const v = expr[i + 1];
    if (typeof z === 'number' && typeof v === 'number') stops.push([z, v]);
  }
  return stops.length > 0 ? stops : null;
}

function hasStop(expr: unknown, zoom: number, value: number): boolean {
  const stops = opacityStops(expr);
  if (!stops) return false;
  return stops.some(([z, v]) => Math.abs(z - zoom) < 0.05 && Math.abs(v - value) < 0.02);
}

/** Linear interpolate, clamped to the outer stops. Non-expressions return the number or 1. */
export function lineOpacityAtZoom(expr: unknown, zoom: number): number {
  if (typeof expr === 'number' && isFinite(expr)) return expr;
  if (expr == null) return 1;
  const stops = opacityStops(expr);
  if (!stops) return 1;
  if (zoom <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z0, v0] = stops[i - 1];
    const [z1, v1] = stops[i];
    if (zoom <= z1) {
      const t = (zoom - z0) / (z1 - z0);
      return v0 + (v1 - v0) * t;
    }
  }
  return last[1];
}

function classesFromFilter(filter: unknown): string[] {
  if (!Array.isArray(filter)) return [];
  if (filter[0] === 'all') {
    const found: string[] = [];
    for (const part of filter.slice(1)) found.push(...classesFromFilter(part));
    return found;
  }
  if (filter[0] === 'match' && Array.isArray(filter[2])) {
    return filter[2].filter((c): c is string => typeof c === 'string');
  }
  return [];
}

/**
 * Road classes a style will actually ink at `zoom` (opacity > 0, visible,
 * inside the layer's zoom range). Overview layers that have faded to 0 drop out.
 */
export function paintedRoadClasses(style: unknown, zoom: number): PaintedRoadClass[] {
  if (!isRecord(style) || !Array.isArray(style.layers)) return [];
  const out: PaintedRoadClass[] = [];
  for (const layer of style.layers) {
    if (!isRecord(layer) || layer.type !== 'line') continue;
    const id = String(layer.id ?? '');
    if (!/road|rail|waterway/.test(id)) continue;
    const layout = isRecord(layer.layout) ? layer.layout : {};
    if (layout.visibility === 'none') continue;
    const minzoom = typeof layer.minzoom === 'number' ? layer.minzoom : -Infinity;
    const maxzoom = typeof layer.maxzoom === 'number' ? layer.maxzoom : Infinity;
    if (zoom < minzoom || zoom >= maxzoom) continue;
    const paint = isRecord(layer.paint) ? layer.paint : {};
    const opacity = lineOpacityAtZoom(paint['line-opacity'], zoom);
    if (opacity <= 0.001) continue;
    const classes = classesFromFilter(layer.filter);
    out.push({ layerId: id, classes, opacity });
  }
  return out;
}

/**
 * Reveal the layers Detailed shows, and put trunk/primary opacity back on
 * the style-file curve when the Clean arteries curve is what's stored.
 * Returns a deep clone. Minor-low and path line-opacity are not raised.
 */
export function applyNeighbourhoodDetail(style: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(style ?? {})) as Record<string, unknown>;
  const layers = Array.isArray(clone.layers) ? clone.layers : [];
  for (const layer of layers) {
    if (!isRecord(layer)) continue;
    const id = String(layer.id ?? '');
    if (isNeighbourhoodToggleLayer(id)) {
      const layout = isRecord(layer.layout) ? layer.layout : {};
      layout.visibility = 'visible';
      layer.layout = layout;
    }
    const paint = isRecord(layer.paint) ? layer.paint : null;
    if (!paint) continue;
    if (id === 'road-minor-high' && hasStop(paint['line-opacity'], 7, 0.12)) {
      paint['line-opacity'] = DETAILED_MINOR_HIGH_OPACITY;
    }
    if (id === 'road-minor-high-casing' && hasStop(paint['line-opacity'], 7, 0)) {
      paint['line-opacity'] = DETAILED_MINOR_HIGH_CASING_OPACITY;
    }
  }
  clone.layers = layers;
  return clone;
}
