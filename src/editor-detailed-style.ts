/**
 * Studio Detailed style, for tests and the Lisbon parity renders.
 *
 * Fulfilment does not call this. A real order replays the snapshot's
 * styleJson. This generator mirrors generateMapStyle in mapvibe-studio as
 * the print-parity audit describes it, which is Terraink's style with:
 *   - no landcover layer
 *   - secondary split onto its own layers, painted with roads.minor_high
 *     and the minor-high width stops
 *   - residential and paths at line-opacity 0 unless the caller opts in
 *   - the Terraink detail opacity curves (not the Clean arteries curves)
 *
 * Width stops are multiplied by 5.5^0.8, matching MAP_OVERZOOM_SCALE.
 */

export interface ResolvedTheme {
  map: {
    land: string;
    water: string;
    waterway: string;
    parks: string;
    buildings?: string;
    aeroway: string;
    rail: string;
    roads: {
      major: string;
      minor_high: string;
      minor_mid: string;
      minor_low: string;
      path: string;
      outline: string;
    };
  };
  ui: { text: string };
}

const OVERZOOM = Math.pow(5.5, 0.8);
const SOURCE = 'openfreemap';

const MINOR_HIGH = ['primary', 'primary_link', 'motorway_link', 'trunk', 'trunk_link'];
const SECONDARY = ['secondary', 'secondary_link'];
const MINOR_MID = ['tertiary', 'tertiary_link', 'minor'];
const MINOR_LOW = ['residential', 'living_street', 'unclassified', 'road', 'street', 'street_limited', 'service'];
const PATH = ['path', 'pedestrian', 'cycleway', 'track'];

type Stops = Array<[number, number]>;

function boost(stops: Stops, extra = 1): Stops {
  return stops.map(([z, w]) => [z, w * OVERZOOM * extra]);
}

function widthExpr(stops: Stops): unknown[] {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([z, w]) => [z, w])];
}

function opacityExpr(stops: Stops): unknown[] {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([z, o]) => [z, o])];
}

function lineFilter(classes: string[]): unknown[] {
  return [
    'all',
    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    ['match', ['get', 'class'], classes, true, false],
  ];
}

function lineLayer(
  id: string,
  classes: string[],
  paint: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    source: SOURCE,
    'source-layer': 'transportation',
    type: 'line',
    filter: lineFilter(classes),
    paint,
    layout: {
      visibility: 'visible',
      'line-cap': 'round',
      'line-join': 'round',
    },
    ...extra,
  };
}

const HIGH_DETAIL: Stops = [[6, 0.46], [10, 0.8], [14, 1.48], [18, 2.7]];
const MID_DETAIL: Stops = [[6, 0.34], [10, 0.62], [14, 1.2], [18, 2.35]];
const LOW_DETAIL: Stops = [[6, 0.24], [10, 0.44], [14, 0.84], [18, 1.65]];
const PATH_DETAIL: Stops = [[8, 0.2], [12, 0.42], [16, 0.85], [18, 1.3]];
const MAJOR: Stops = [[0, 0.36], [3, 0.52], [9, 1.1], [14, 2.05], [18, 3.3]];
const HIGH_OVERVIEW: Stops = [[0, 0.1], [4, 0.18], [8, 0.3], [11, 0.46]];
const MID_OVERVIEW: Stops = [[0, 0.08], [4, 0.14], [8, 0.24], [11, 0.36]];
const LOW_OVERVIEW: Stops = [[0, 0.06], [4, 0.1], [8, 0.18], [11, 0.3]];
const PATH_OVERVIEW: Stops = [[5, 0.06], [8, 0.1], [11, 0.2]];
const WATERWAY: Stops = [[0, 0.2], [6, 0.34], [12, 0.8], [18, 2.4]];
const RAIL: Stops = [[3, 0.4], [6, 0.7], [10, 1], [18, 1.5]];

const HIGH_OPACITY: Stops = [[6, 0.84], [10, 0.92], [18, 1]];
const HIGH_CASING_OPACITY: Stops = [[6, 0.72], [12, 0.85], [18, 0.92]];
const MID_OPACITY: Stops = [[6, 0.62], [10, 0.74], [18, 0.86]];
const MID_CASING_OPACITY: Stops = [[6, 0.42], [12, 0.56], [18, 0.66]];
const LOW_OPACITY: Stops = [[6, 0.34], [10, 0.46], [18, 0.58]];
const PATH_OPACITY: Stops = [[8, 0.7], [12, 0.82], [18, 0.95]];
const PATH_CASING_OPACITY: Stops = [[8, 0.62], [12, 0.72], [18, 0.85]];

export interface EditorStyleOptions {
  includeRoadMinorLow?: boolean;
  includeRoadPath?: boolean;
  includeRoadOutline?: boolean;
  /** Ground span of the frame. ≤ 30 km uses the studio's 8.2 building minzoom. */
  distanceMeters?: number;
}

/** MapVibe theme entry (assets/themes.json) → the resolved theme the editor stores. */
export function mapVibeToResolved(entry: {
  name?: string;
  map: Record<string, string>;
}): ResolvedTheme & { name?: string } {
  const m = entry.map;
  return {
    name: entry.name,
    map: {
      land: m.background,
      water: m.water,
      waterway: m.waterway,
      parks: m.parks,
      buildings: m.buildings,
      aeroway: m.aeroway,
      rail: m.rail,
      roads: {
        major: m.roadMajor,
        minor_high: m.roadMinorHigh,
        minor_mid: m.roadMinorMid,
        minor_low: m.roadMinorLow,
        path: m.roadPath,
        outline: m.roadOutline,
      },
    },
    ui: { text: m.textColor, bg: m.overlayBg } as ResolvedTheme['ui'] & { bg?: string },
  };
}

export function generateEditorDetailedStyle(
  theme: ResolvedTheme,
  options: EditorStyleOptions = {},
): Record<string, unknown> {
  const minorLow = options.includeRoadMinorLow === true;
  const pathOn = options.includeRoadPath === true;
  const outline = options.includeRoadOutline !== false;
  const buildingMin = (options.distanceMeters ?? 10_000) <= 30_000 ? 8.2 : 8;
  const roads = theme.map.roads;
  const building = theme.map.buildings || theme.map.land;

  const layers: Record<string, unknown>[] = [
    { id: 'background', type: 'background', paint: { 'background-color': theme.map.land } },
    {
      id: 'park',
      source: SOURCE,
      'source-layer': 'park',
      type: 'fill',
      paint: { 'fill-color': theme.map.parks },
    },
    {
      id: 'water',
      source: SOURCE,
      'source-layer': 'water',
      type: 'fill',
      paint: { 'fill-color': theme.map.water },
    },
    lineLayer('waterway', ['river', 'canal', 'stream', 'ditch'], {
      'line-color': theme.map.waterway,
      'line-width': widthExpr(boost(WATERWAY)),
    }, { 'source-layer': 'waterway' }),
    {
      id: 'aeroway',
      source: SOURCE,
      'source-layer': 'aeroway',
      type: 'fill',
      filter: ['match', ['geometry-type'], ['MultiPolygon', 'Polygon'], true, false],
      paint: { 'fill-color': theme.map.aeroway, 'fill-opacity': 0.85 },
    },
    {
      id: 'building',
      source: SOURCE,
      'source-layer': 'building',
      type: 'fill',
      minzoom: buildingMin,
      paint: { 'fill-color': building, 'fill-opacity': 0.84 },
    },
    lineLayer('rail', ['rail', 'transit'], {
      'line-color': theme.map.rail,
      'line-width': widthExpr(boost(RAIL)),
      'line-opacity': opacityExpr([[0, 0.56], [12, 0.62], [18, 0.72]]),
      'line-dasharray': [2, 1.6],
    }),
    lineLayer('road-minor-overview-high', MINOR_HIGH, {
      'line-color': roads.minor_high,
      'line-width': widthExpr(boost(HIGH_OVERVIEW)),
      'line-opacity': opacityExpr([[0, 0.66], [8, 0.76], [12, 0]]),
    }, { minzoom: 0, maxzoom: 11.8 }),
    lineLayer('road-secondary-overview', SECONDARY, {
      'line-color': roads.minor_high,
      'line-width': widthExpr(boost(HIGH_OVERVIEW)),
      'line-opacity': opacityExpr([[0, 0.66], [8, 0.76], [12, 0]]),
    }, { minzoom: 0, maxzoom: 11.8 }),
    lineLayer('road-minor-overview-mid', MINOR_MID, {
      'line-color': roads.minor_mid,
      'line-width': widthExpr(boost(MID_OVERVIEW)),
      'line-opacity': opacityExpr([[0, 0.46], [8, 0.56], [12, 0]]),
    }, { minzoom: 0, maxzoom: 11.8 }),
    lineLayer('road-minor-overview-low', MINOR_LOW, {
      'line-color': roads.minor_low,
      'line-width': widthExpr(boost(LOW_OVERVIEW)),
      'line-opacity': minorLow ? opacityExpr([[0, 0.26], [8, 0.34], [12, 0]]) : 0,
    }, { minzoom: 0, maxzoom: 11.8 }),
    lineLayer('road-path-overview', PATH, {
      'line-color': roads.path,
      'line-width': widthExpr(boost(PATH_OVERVIEW)),
      'line-opacity': pathOn ? opacityExpr([[5, 0.45], [9, 0.58], [12, 0]]) : 0,
    }, { minzoom: 5, maxzoom: 11.8 }),
    lineLayer('road-major-casing', ['motorway'], {
      'line-color': roads.outline,
      'line-width': widthExpr(boost(MAJOR, 1.38)),
      'line-opacity': outline ? 0.95 : 0,
    }),
    lineLayer('road-minor-high-casing', MINOR_HIGH, {
      'line-color': roads.outline,
      'line-width': widthExpr(boost(HIGH_DETAIL, 1.45)),
      'line-opacity': outline ? opacityExpr(HIGH_CASING_OPACITY) : 0,
    }, { minzoom: 6 }),
    lineLayer('road-secondary-casing', SECONDARY, {
      'line-color': roads.outline,
      'line-width': widthExpr(boost(HIGH_DETAIL, 1.45)),
      'line-opacity': outline ? opacityExpr(HIGH_CASING_OPACITY) : 0,
    }, { minzoom: 6 }),
    lineLayer('road-minor-mid-casing', MINOR_MID, {
      'line-color': roads.outline,
      'line-width': widthExpr(boost(MID_DETAIL, 1.15)),
      'line-opacity': outline ? opacityExpr(MID_CASING_OPACITY) : 0,
    }, { minzoom: 6 }),
    lineLayer('road-path-casing', PATH, {
      'line-color': roads.outline,
      'line-width': widthExpr(boost(PATH_DETAIL, 1.6)),
      'line-opacity': outline && pathOn ? opacityExpr(PATH_CASING_OPACITY) : 0,
    }, { minzoom: 8 }),
    lineLayer('road-major', ['motorway'], {
      'line-color': roads.major,
      'line-width': widthExpr(boost(MAJOR)),
    }),
    lineLayer('road-minor-high', MINOR_HIGH, {
      'line-color': roads.minor_high,
      'line-width': widthExpr(boost(HIGH_DETAIL)),
      'line-opacity': opacityExpr(HIGH_OPACITY),
    }, { minzoom: 6 }),
    lineLayer('road-secondary', SECONDARY, {
      'line-color': roads.minor_high,
      'line-width': widthExpr(boost(HIGH_DETAIL)),
      'line-opacity': opacityExpr(HIGH_OPACITY),
    }, { minzoom: 6 }),
    lineLayer('road-minor-mid', MINOR_MID, {
      'line-color': roads.minor_mid,
      'line-width': widthExpr(boost(MID_DETAIL)),
      'line-opacity': opacityExpr(MID_OPACITY),
    }, { minzoom: 6 }),
    lineLayer('road-minor-low', MINOR_LOW, {
      'line-color': roads.minor_low,
      'line-width': widthExpr(boost(LOW_DETAIL)),
      'line-opacity': minorLow ? opacityExpr(LOW_OPACITY) : 0,
    }, { minzoom: 6 }),
    lineLayer('road-path', PATH, {
      'line-color': roads.path,
      'line-width': widthExpr(boost(PATH_DETAIL)),
      'line-opacity': pathOn ? opacityExpr(PATH_OPACITY) : 0,
    }, { minzoom: 8 }),
  ];

  return {
    version: 8,
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        maxzoom: 14,
      },
    },
    layers,
  };
}
