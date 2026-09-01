/**
 * Detailed-roads fulfillment routing (feat/fulfill-detailed-osm).
 *
 * Problem: editor-authored (styleJson) snapshots always replay fulfillment
 * through the vector-tile pipeline. Poster-zoom tiles carry almost no
 * residential/service road data in low-density suburbs (order #1086's Fair
 * Haven tile holds 3 minor-road features), so the editor's "Detailed" mode
 * cannot be reproduced on the print file through that path — the layers turn
 * on, but there is nothing to draw. The OSM engine in this same service draws
 * from the full OpenStreetMap dataset and reproduces Detailed correctly.
 *
 * Contract (additive; default behaviour is unchanged byte-for-byte):
 *  - Snapshot minorRoads === true AND bounds present → OSM engine, Detailed.
 *  - FulfillBody.detailedRoads overrides the snapshot for staff reprints:
 *    true forces the Detailed/OSM path, false forces the legacy tile path.
 *  - Detailed wanted but NO bounds → stay on the tile path and warn loudly.
 *    Framing fidelity outranks road detail: without a bounds rectangle the
 *    OSM engine would reframe the poster via dist-around-center — the exact
 *    pre-#79 failure mode (crop drift vs the approved editor view).
 *
 * Why routing a styleJson config through the OSM engine is safe NOW (it was
 * not on 2026-08-04, see the #1086 incident note in server.ts):
 *  1. Crop: v2 snapshots carry bounds, and the OSM engine frames from bounds
 *     since #79 — the print matches the approved editor view.
 *  2. Theme: themeJsonFromEditorTheme() derives the engine palette from the
 *     snapshot's nested editor theme, so no load_theme() filename fallback.
 *  3. Chrome: fulfillment always sets full_bleed + no_fade, so no axes chrome.
 */

export interface DetailRoutingFields {
  engine?: 'maplibre' | 'osm';
  styleJson?: unknown;
  minorRoads?: boolean;
  bounds?: { west: number; south: number; east: number; north: number };
}

export interface FulfillRoute {
  engine: 'osm' | 'maplibre';
  /** Only meaningful when engine === 'osm'. */
  minorRoads: boolean;
  /** Stable slug for the log line — never silent (post-#79 rule). */
  reason: string;
  /** Present when a Detailed request could not be honoured. */
  warning?: string;
}

export function resolveFulfillRoute(
  cfg: DetailRoutingFields,
  renderEngineEnv: string | undefined,
  detailedOverride?: boolean,
): FulfillRoute {
  const wantDetailed = detailedOverride ?? cfg.minorRoads === true;

  // Pre-existing rules, unchanged: explicit OSM snapshots, and legacy
  // flat-palette-era configs (no styleJson) under RENDER_ENGINE=osm.
  if (cfg.engine === 'osm') {
    return { engine: 'osm', minorRoads: wantDetailed, reason: 'cfg-engine-osm' };
  }
  if (renderEngineEnv === 'osm' && !cfg.styleJson) {
    return { engine: 'osm', minorRoads: wantDetailed, reason: 'env-osm-legacy-config' };
  }

  // NEW: Detailed-roads orders route through the OSM engine — but only when
  // the snapshot carries a bounds rectangle, so print framing stays identical
  // to the approved editor view.
  if (wantDetailed) {
    if (cfg.bounds) {
      return {
        engine: 'osm',
        minorRoads: true,
        reason: detailedOverride === true ? 'detailed-override' : 'snapshot-minor-roads',
      };
    }
    return {
      engine: 'maplibre',
      minorRoads: false,
      reason: 'detailed-without-bounds',
      warning:
        'Detailed roads requested but the snapshot has no bounds — staying on ' +
        'the tile path to preserve framing; minor roads will be missing from ' +
        'the print file',
    };
  }

  return { engine: 'maplibre', minorRoads: false, reason: 'default-tile-path' };
}

// ── Editor-theme → OSM engine palette ────────────────────────────────────────

interface EditorThemeRoads {
  major?: string;
  minor_high?: string;
  minor_mid?: string;
  minor_low?: string;
}

interface EditorThemeShape {
  map?: {
    land?: string;
    water?: string;
    parks?: string;
    rail?: string;
    roads?: EditorThemeRoads;
  };
  ui?: { text?: string };
}

/**
 * Derive the Python engine's theme_json from a snapshot's nested editor theme
 * (`cfg.theme`). Editor snapshots that predate the ShopifyExportOverlay v3.1
 * flat-palette fields (e.g. order #1086) carry their palette ONLY here; without
 * this the OSM path falls back to load_theme(osmTheme) and prints the wrong
 * colours on theme-filename drift.
 *
 * Returns undefined when the nested theme lacks the minimum fields (land,
 * roads, ui.text) — callers then keep the existing load_theme fallback.
 */
export function themeJsonFromEditorTheme(
  theme: unknown,
): Record<string, string> | undefined {
  const t = theme as EditorThemeShape | null | undefined;
  const m = t?.map;
  const text = t?.ui?.text;
  if (!m?.land || !m.roads || !text) return undefined;
  const r = m.roads;
  const major = r.major ?? text;
  return {
    bg: m.land,
    text,
    gradient_color: m.land,
    water: m.water ?? m.land,
    parks: m.parks ?? m.land,
    road_motorway: major,
    road_primary: r.minor_high ?? major,
    road_secondary: r.minor_mid ?? r.minor_high ?? major,
    road_tertiary: r.minor_mid ?? r.minor_high ?? major,
    road_residential: r.minor_low ?? r.minor_mid ?? major,
    road_default: r.minor_mid ?? r.minor_high ?? major,
    rail: m.rail ?? r.minor_mid ?? major,
  };
}
