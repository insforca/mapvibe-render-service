import { describe, it, expect } from 'vitest';
import {
  hasUsableMapStyle,
  rejectImageRender,
  resolveFulfillRoute,
  styleStateOf,
} from '../detail-routing.js';

const STYLE = { version: 8, layers: [{ id: 'water', type: 'fill' }] };

const BOUNDS = { west: -74.063, south: 40.3078, east: -73.9953, north: 40.3767 };

describe('resolveFulfillRoute — MapLibre when the editor style is usable', () => {
  it('Clean with a real style stays on the tile path', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({
      engine: 'maplibre',
      minorRoads: false,
      reason: 'default-tile-path',
      styleState: 'usable',
    });
    expect(r.engine === 'maplibre' ? r.warning : undefined).toBeUndefined();
  });

  it('does not let RENDER_ENGINE=osm steal a usable styleJson', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, bounds: BOUNDS }, 'osm');
    expect(r.engine).toBe('maplibre');
    expect(r.reason).toBe('default-tile-path');
  });

  it('routes Detailed snapshots that carry a style through MapLibre', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, minorRoads: true, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({ engine: 'maplibre', minorRoads: true, reason: 'detailed-style-parity' });
    expect(r.engine === 'maplibre' ? r.warning : 'unexpected').toBeUndefined();
  });

  it('Detailed without bounds stays on the tile path with a loud warning when the style is usable', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, minorRoads: true }, undefined);
    expect(r.engine).toBe('maplibre');
    expect(r.engine === 'maplibre' && r.warning).toMatch(/no bounds/);
  });

  it('detailedRoads=true on a styled snapshot replays that style as Detailed', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, bounds: BOUNDS }, undefined, true);
    expect(r).toMatchObject({ engine: 'maplibre', minorRoads: true, reason: 'detailed-override' });
  });

  it('detailedRoads=false forces the Clean tile path on a styled Detailed snapshot', () => {
    const r = resolveFulfillRoute({ styleJson: STYLE, minorRoads: true, bounds: BOUNDS }, undefined, false);
    expect(r).toMatchObject({ engine: 'maplibre', minorRoads: false, reason: 'default-tile-path' });
  });
});

describe('resolveFulfillRoute — loud failure, no Python map', () => {
  it('rejects explicit engine=osm even when a style is present', () => {
    const r = resolveFulfillRoute({ engine: 'osm', styleJson: STYLE, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'osm-engine-retired',
      reason: 'cfg-engine-osm',
      styleState: 'usable',
    });
    expect(r.engine === 'rejected' && r.message).toMatch(/retired/);
    expect(JSON.stringify(r)).not.toContain('water');
  });

  it('rejects engine=osm with no style and records the style state', () => {
    const missing = resolveFulfillRoute({ engine: 'osm' }, undefined);
    expect(missing).toMatchObject({
      engine: 'rejected',
      failReason: 'osm-engine-retired',
      reason: 'cfg-engine-osm',
      styleState: 'missing',
    });
    const empty = resolveFulfillRoute({ engine: 'osm', styleJson: { layers: [] } }, undefined, true);
    expect(empty).toMatchObject({
      engine: 'rejected',
      failReason: 'osm-engine-retired',
      reason: 'cfg-engine-osm',
      styleState: 'empty',
      minorRoads: true,
    });
  });

  it('rejects RENDER_ENGINE=osm legacy configs that have no styleJson', () => {
    const r = resolveFulfillRoute({}, 'osm');
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'env-osm-legacy-config',
      styleState: 'missing',
    });
  });

  it('Detailed with bounds but no style is missing-style, former route detailed-osm-no-style', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'detailed-osm-no-style',
      styleState: 'empty',
      minorRoads: false,
    });
    expect(hasUsableMapStyle({})).toBe(false);
    expect(hasUsableMapStyle({ layers: [] })).toBe(false);
    expect(hasUsableMapStyle(STYLE)).toBe(true);
    expect(styleStateOf(null)).toBe('missing');
    expect(styleStateOf('coral')).toBe('unusable');
  });

  it('detailedRoads=true with no style names the override route', () => {
    const r = resolveFulfillRoute({ styleJson: {}, bounds: BOUNDS }, undefined, true);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'detailed-override-no-style',
      styleState: 'empty',
    });
  });

  it('Detailed without bounds and without a style fails instead of warning', () => {
    const r = resolveFulfillRoute({ minorRoads: true }, undefined);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'detailed-without-bounds',
      styleState: 'missing',
    });
  });

  it('a Clean snapshot with an empty style fails; the former route is the tile path', () => {
    const r = resolveFulfillRoute({ styleJson: {}, bounds: BOUNDS }, undefined);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'default-tile-path',
      styleState: 'empty',
    });
  });

  it('an empty style under RENDER_ENGINE=osm is not the legacy env route (styleJson is present)', () => {
    const r = resolveFulfillRoute({ styleJson: {} }, 'osm');
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'default-tile-path',
      styleState: 'empty',
    });
  });

  it('env osm plus Detailed bounds and a missing style keeps the legacy env route', () => {
    const r = resolveFulfillRoute({ minorRoads: true, bounds: BOUNDS }, 'osm');
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'env-osm-legacy-config',
      styleState: 'missing',
    });
  });

  it('detailedRoads=false cannot print an empty style', () => {
    const r = resolveFulfillRoute({ styleJson: {}, minorRoads: true, bounds: BOUNDS }, undefined, false);
    expect(r).toMatchObject({
      engine: 'rejected',
      failReason: 'missing-style',
      reason: 'default-tile-path',
    });
  });
});

describe('rejectImageRender — /render does not spawn Python and does not email', () => {
  it('rejects engine=osm before considering the style', () => {
    const r = rejectImageRender({ engine: 'osm', styleJson: STYLE });
    expect(r).toMatchObject({
      status: 400,
      failReason: 'osm-engine-retired',
      styleState: 'usable',
    });
    expect(r?.error).toMatch(/retired/);
  });

  it('rejects a missing or empty styleJson', () => {
    expect(rejectImageRender({ styleJson: undefined })).toMatchObject({
      status: 400,
      failReason: 'missing-style',
      styleState: 'missing',
    });
    expect(rejectImageRender({ styleJson: {} })?.styleState).toBe('empty');
    expect(rejectImageRender({ styleJson: { layers: [] } })?.error).toMatch(/empty/);
  });

  it('accepts a usable style and ignores the fact that no engine field was sent', () => {
    expect(rejectImageRender({ styleJson: STYLE })).toBeNull();
    expect(rejectImageRender({ engine: 'maplibre', styleJson: STYLE })).toBeNull();
  });
});
