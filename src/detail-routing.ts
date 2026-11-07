/**
 * Detailed-roads fulfillment routing.
 *
 * The editor's Detailed preview is the MapLibre style from generateMapStyle
 * (neighbourhood mode): casings, zoom-stopped widths, waterways, buildings,
 * aeroway, dashed rail, and the road classes whose line-opacity is above 0.
 * Residential and paths stay at opacity 0 unless the customer turned those
 * toggles on. Replaying that snapshot through the Python/OSM poster draws a
 * different map (one stroke per class, no casings, no zoom curve, no
 * buildings). Order #1086's missing residential roads were a zoom mismatch
 * against the same OpenFreeMap tiles, not a second street network the
 * editor was showing.
 *
 * Contract:
 *  - minorRoads (or detailedRoads override) AND bounds AND a style with
 *    layers → MapLibre, rendered at the snapshot zoom. Python is not used.
 *  - Same request but no usable style → OSM engine. There is nothing to
 *    replay, so the legacy street graph is still the only picture we can make.
 *  - cfg.engine === 'osm' stays on the OSM engine (explicit legacy snapshots).
 *  - Detailed wanted but NO bounds → tile path and a loud warning. Framing
 *    outranks road detail (pre-#79 crop drift).
 *  - detailedRoads false forces the Clean tile path.
 */

export interface DetailRoutingFields {
  engine?: 'maplibre' | 'osm';
  styleJson?: unknown;
  minorRoads?: boolean;
  bounds?: { west: number; south: number; east: number; north: number };
}

export interface FulfillRoute {
  engine: 'osm' | 'maplibre';
  /**
   * True when the print should show the editor's Detailed road set.
   * On the MapLibre path the style's own opacities decide which classes
   * are actually inked. On the OSM path it is forwarded as minor_roads.
   */
  minorRoads: boolean;
  /** Stable slug for the log line — never silent (post-#79 rule). */
  reason: string;
  /** Present when a Detailed request could not be honoured. */
  warning?: string;
}

/** A style the MapLibre renderer can replay. `{}` is not one. */
export function hasUsableMapStyle(style: unknown): boolean {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return false;
  const layers = (style as { layers?: unknown }).layers;
  return Array.isArray(layers) && layers.length > 0;
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

  // Detailed with the editor's own style replays that style. The style
  // already encodes which classes are visible and at what opacity. Python
  // remains only when there is no style to replay.
  if (wantDetailed) {
    if (cfg.bounds && hasUsableMapStyle(cfg.styleJson)) {
      return {
        engine: 'maplibre',
        minorRoads: true,
        reason: detailedOverride === true ? 'detailed-override' : 'detailed-style-parity',
      };
    }
    if (cfg.bounds) {
      return {
        engine: 'osm',
        minorRoads: true,
        reason: detailedOverride === true ? 'detailed-override-no-style' : 'detailed-osm-no-style',
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
  path?: string;
  outline?: string;
}

interface EditorThemeShape {
  name?: string;
  id?: string;
  map?: {
    land?: string;
    water?: string;
    waterway?: string;
    parks?: string;
    buildings?: string;
    aeroway?: string;
    rail?: string;
    roads?: EditorThemeRoads;
  };
  ui?: { text?: string };
}

function themeLabel(theme: unknown): string {
  if (!theme || typeof theme !== 'object') return 'unnamed';
  const t = theme as EditorThemeShape;
  return t.name || t.id || 'unnamed';
}

/**
 * Derive the Python engine's theme_json from a snapshot's nested editor theme
 * (`cfg.theme`). Editor snapshots that predate the ShopifyExportOverlay v3.1
 * flat-palette fields (e.g. order #1086) carry their palette ONLY here; without
 * this the OSM path falls back to load_theme(osmTheme) and prints the wrong
 * colours on theme-filename drift.
 *
 * Returns undefined when the nested theme lacks the minimum fields (land,
 * roads, ui.text). Callers must not then silently load midnight_blue or
 * the terracotta file when a theme object was actually provided.
 *
 * Secondary is roads.minor_high. The editor paints `road-secondary` with
 * that colour, the same as trunk and primary — not minor_mid.
 * A missing water colour is omitted. It is not replaced with land.
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
  const out: Record<string, string> = {
    name: themeLabel(theme),
    bg: m.land,
    text,
    gradient_color: m.land,
    parks: m.parks ?? m.land,
    road_motorway: major,
    road_primary: r.minor_high ?? major,
    road_secondary: r.minor_high ?? major,
    road_tertiary: r.minor_mid ?? r.minor_high ?? major,
    road_residential: r.minor_low ?? r.minor_mid ?? major,
    road_default: r.minor_mid ?? r.minor_high ?? major,
    rail: m.rail ?? r.minor_mid ?? major,
  };
  if (m.water) out.water = m.water;
  if (m.waterway) out.waterway = m.waterway;
  if (m.buildings) out.buildings = m.buildings;
  if (m.aeroway) out.aeroway = m.aeroway;
  if (r.outline) out.road_outline = r.outline;
  if (r.path) out.road_path = r.path;
  return out;
}

/**
 * Palette problems a caller should log next to the theme name.
 * Empty when the value is not a theme object, or when nothing was dropped.
 */
export function editorThemePaletteWarnings(theme: unknown): string[] {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return [];
  const t = theme as EditorThemeShape;
  const name = themeLabel(theme);
  const warnings: string[] = [];
  if (t.map && !t.map.water) {
    warnings.push(`theme '${name}': map.water is missing — not substituting land`);
  }
  if (t.map?.roads && !t.map.roads.minor_high) {
    warnings.push(
      `theme '${name}': roads.minor_high is missing — secondary uses major, not minor_mid`,
    );
  }
  return warnings;
}
