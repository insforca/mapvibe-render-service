import { describe, it, expect } from 'vitest';
import {
  resolveFulfillRoute,
  themeJsonFromEditorTheme,
} from '../detail-routing.js';

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

  it('routes Detailed snapshots with bounds through the OSM engine', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({ engine: 'osm', minorRoads: true, reason: 'snapshot-minor-roads' });
  });

  it('Detailed without bounds stays on the tile path with a loud warning', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true }, undefined);
    expect(r.engine).toBe('maplibre');
    expect(r.warning).toMatch(/no bounds/);
  });

  it('detailedRoads=true override forces the OSM path on a Clean snapshot (staff reprint)', () => {
    const r = resolveFulfillRoute({ styleJson: {}, bounds: BOUNDS }, undefined, true);
    expect(r).toMatchObject({ engine: 'osm', minorRoads: true, reason: 'detailed-override' });
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
      road_secondary: '#EAA8BC',
      road_residential: '#F0C0D0',
      rail: '#F9A8D4',
    });
  });

  it('falls back per-field when road tiers are missing', () => {
    const tj = themeJsonFromEditorTheme({
      map: { land: '#111', roads: { major: '#eee' } },
      ui: { text: '#fff' },
    });
    expect(tj).toMatchObject({
      road_primary: '#eee',
      road_residential: '#eee',
      rail: '#eee',
    });
  });

  it('returns undefined for malformed or absent themes (load_theme fallback preserved)', () => {
    expect(themeJsonFromEditorTheme(undefined)).toBeUndefined();
    expect(themeJsonFromEditorTheme(null)).toBeUndefined();
    expect(themeJsonFromEditorTheme('coral')).toBeUndefined();
    expect(themeJsonFromEditorTheme({ map: { land: '#111' } })).toBeUndefined();
    expect(themeJsonFromEditorTheme({ map: { roads: {} }, ui: { text: '#fff' } })).toBeUndefined();
  });
});
