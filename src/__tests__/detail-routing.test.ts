import { describe, it, expect } from 'vitest';
import {
  editorThemePaletteWarnings,
  hasUsableMapStyle,
  resolveFulfillRoute,
  themeJsonFromEditorTheme,
} from '../detail-routing.js';

const STYLE = { version: 8, layers: [{ id: 'water', type: 'fill' }] };

const BOUNDS = { west: -74.063, south: 40.3078, east: -73.9953, north: 40.3767 };

describe('resolveFulfillRoute — engine selection', () => {
  it('default tile path is byte-for-byte unchanged (styleJson config, no detail)', () => {
    const r = resolveFulfillRoute({ styleJson: {}, bounds: BOUNDS }, undefined);
    expect(r.engine).toBe('maplibre');
    expect(r.minorRoads).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it('keeps the pre-existing cfg.engine=osm rule', () => {
    const r = resolveFulfillRoute({ engine: 'osm' }, undefined);
    expect(r.engine).toBe('osm');
    expect(r.reason).toBe('cfg-engine-osm');
  });

  it('keeps the pre-existing RENDER_ENGINE=osm legacy-config rule', () => {
    expect(resolveFulfillRoute({}, 'osm').engine).toBe('osm');
    // …but never steals styleJson configs (the 2026-08-04 #1086 incident rule)
    expect(resolveFulfillRoute({ styleJson: {} }, 'osm').engine).toBe('maplibre');
  });

  it('routes Detailed snapshots that carry a style through MapLibre', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, minorRoads: true, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({ engine: 'maplibre', minorRoads: true, reason: 'detailed-style-parity' });
    expect(r.warning).toBeUndefined();
  });

  it('Detailed with bounds but no style stays on the OSM engine', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({ engine: 'osm', minorRoads: true, reason: 'detailed-osm-no-style' });
    expect(hasUsableMapStyle({})).toBe(false);
    expect(hasUsableMapStyle(STYLE)).toBe(true);
  });

  it('Detailed without bounds stays on the tile path with a loud warning', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true }, undefined);
    expect(r.engine).toBe('maplibre');
    expect(r.warning).toMatch(/no bounds/);
  });

  it('detailedRoads=true on a styled snapshot replays that style as Detailed', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, bounds: BOUNDS }, undefined, true);
    expect(r).toMatchObject({ engine: 'maplibre', minorRoads: true, reason: 'detailed-override' });
  });

  it('detailedRoads=true with no style still uses the OSM engine', () => {
    const r = resolveFulfillRoute({ styleJson: {}, bounds: BOUNDS }, undefined, true);
    expect(r).toMatchObject({ engine: 'osm', minorRoads: true, reason: 'detailed-override-no-style' });
  });

  it('detailedRoads=false override forces the tile path on a Detailed snapshot', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true, bounds: BOUNDS }, undefined, false);
    expect(r.engine).toBe('maplibre');
  });

  it('override on cfg.engine=osm snapshots controls minor roads, not the engine', () => {
    expect(resolveFulfillRoute({ engine: 'osm' }, undefined, true).minorRoads).toBe(true);
    expect(resolveFulfillRoute({ engine: 'osm', minorRoads: true }, undefined, false).minorRoads).toBe(false);
  });
});

describe('themeJsonFromEditorTheme — nested editor palette derivation', () => {
  // Order #1086's actual nested theme (Pastel Symmetry / coral family).
  const WENDY_THEME = {
    name: 'Pastel Symmetry',
    map: {
      land: '#FFF4F8',
      water: '#B8D8EC',
      parks: '#E8F0D8',
      rail: '#F9A8D4',
      roads: {
        major: '#D4708A',
        minor_high: '#E090A8',
        minor_mid: '#EAA8BC',
        minor_low: '#F0C0D0',
      },
    },
    ui: { bg: '#FFF4F8', text: '#5C2040' },
  };

  it('derives the full engine palette from order #1086 theme', () => {
    const tj = themeJsonFromEditorTheme(WENDY_THEME);
    expect(tj).toMatchObject({
      bg: '#FFF4F8',
      text: '#5C2040',
      water: '#B8D8EC',
      parks: '#E8F0D8',
      road_motorway: '#D4708A',
      road_primary: '#E090A8',
      // Secondary is painted with minor_high, the same colour as primary.
      road_secondary: '#E090A8',
      road_tertiary: '#EAA8BC',
      road_residential: '#F0C0D0',
      rail: '#F9A8D4',
    });
    expect(tj?.water).toBe('#B8D8EC');
    expect(tj?.road_secondary).not.toBe('#EAA8BC');
  });

  it('does not replace a missing water colour with land', () => {
    const theme = {
      name: 'Broken Water',
      map: {
        land: '#FFF4F8',
        parks: '#E8F0D8',
        roads: { major: '#D4708A', minor_high: '#E090A8' },
      },
      ui: { text: '#5C2040' },
    };
    const tj = themeJsonFromEditorTheme(theme);
    expect(tj?.water).toBeUndefined();
    expect(tj?.bg).toBe('#FFF4F8');
    expect(tj?.road_secondary).toBe('#E090A8');
    expect(editorThemePaletteWarnings(theme)).toEqual([
      "theme 'Broken Water': map.water is missing — not substituting land",
    ]);
  });

  it('forwards waterway, buildings, aeroway, and the casing colour when present', () => {
    const tj = themeJsonFromEditorTheme({
      ...WENDY_THEME,
      map: {
        ...WENDY_THEME.map,
        waterway: '#99CCDD',
        buildings: '#F0C8D8',
        aeroway: '#E8F0D8',
        roads: { ...WENDY_THEME.map.roads, outline: '#CCCCCC' },
      },
    });
    expect(tj).toMatchObject({
      waterway: '#99CCDD',
      buildings: '#F0C8D8',
      aeroway: '#E8F0D8',
      road_outline: '#CCCCCC',
    });
  });

  it('falls back per-field when road tiers are missing', () => {
    const tj = themeJsonFromEditorTheme({
      map: { land: '#111', roads: { major: '#eee' } },
      ui: { text: '#fff' },
    });
    expect(tj).toMatchObject({
      road_primary: '#eee',
      road_secondary: '#eee',
      road_residential: '#eee',
      rail: '#eee',
    });
    expect(tj?.water).toBeUndefined();
    expect(editorThemePaletteWarnings({
      name: 'Major Only',
      map: { land: '#111', roads: { major: '#eee' } },
      ui: { text: '#fff' },
    })).toEqual([
      "theme 'Major Only': map.water is missing — not substituting land",
      "theme 'Major Only': roads.minor_high is missing — secondary uses major, not minor_mid",
    ]);
  });

  it('returns undefined for malformed or absent themes', () => {
    expect(themeJsonFromEditorTheme(undefined)).toBeUndefined();
    expect(themeJsonFromEditorTheme(null)).toBeUndefined();
    expect(themeJsonFromEditorTheme('coral')).toBeUndefined();
    expect(themeJsonFromEditorTheme({ map: { land: '#111' } })).toBeUndefined();
    expect(themeJsonFromEditorTheme({ map: { roads: {} }, ui: { text: '#fff' } })).toBeUndefined();
  });
});
