/**
 * Fulfillment routing for Clean and Detailed prints.
 *
 * Both modes replay the editor snapshot through MapLibre. The Python/OSMnx
 * renderer is retired: a snapshot with no usable style, and any snapshot that
 * asks for engine 'osm', fails instead of drawing a different map.
 *
 * Contract:
 *  - minorRoads (or detailedRoads override) AND bounds AND a style with
 *    layers → MapLibre, rendered at the snapshot zoom.
 *  - Same request but no usable style → rejected. The reason slug is the
 *    route the Python fallback used to take (detailed-osm-no-style, …).
 *  - cfg.engine === 'osm' → rejected (osm-engine-retired), even when a
 *    style is present. Explicit legacy snapshots are not silently replayed.
 *  - RENDER_ENGINE=osm with no styleJson → rejected. The env var used to
 *    select the Python pipeline; it no longer does. A usable styleJson is
 *    still MapLibre (the #1086 rule: the env must not steal a real style).
 *  - Detailed wanted, bounds missing, usable style → tile path and a loud
 *    warning. Framing outranks road detail (pre-#79 crop drift).
 *  - detailedRoads false forces the Clean tile path when the style is usable.
 */

export type StyleState = 'missing' | 'empty' | 'unusable' | 'usable';

export type StyleFailReason = 'missing-style' | 'osm-engine-retired';

export interface DetailRoutingFields {
  engine?: 'maplibre' | 'osm';
  styleJson?: unknown;
  minorRoads?: boolean;
  bounds?: { west: number; south: number; east: number; north: number };
}

export type FulfillRoute =
  | {
      engine: 'maplibre';
      /**
       * True when the print should show the editor's Detailed road set.
       * The style's own opacities decide which classes are actually inked.
       */
      minorRoads: boolean;
      /** Stable slug for the log line — never silent (post-#79 rule). */
      reason: string;
      styleState: 'usable';
      /** Present when a Detailed request could not be honoured. */
      warning?: string;
    }
  | {
      engine: 'rejected';
      minorRoads: boolean;
      /**
       * The route the retired Python renderer would have taken, or the
       * MapLibre path that cannot run without a style.
       */
      reason: string;
      failReason: StyleFailReason;
      styleState: StyleState;
      /** Caller-facing sentence. No style payload, no secrets. */
      message: string;
    };

export interface ImageRenderRejection {
  status: 400;
  failReason: StyleFailReason;
  styleState: StyleState;
  error: string;
}

/** Classify a snapshot style without reading layer paint or sources. */
export function styleStateOf(style: unknown): StyleState {
  if (style == null) return 'missing';
  if (typeof style !== 'object' || Array.isArray(style)) return 'unusable';
  const layers = (style as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) return 'empty';
  return 'usable';
}

/** A style the MapLibre renderer can replay. `{}` is not one. */
export function hasUsableMapStyle(style: unknown): boolean {
  return styleStateOf(style) === 'usable';
}

function styleStatePhrase(state: StyleState): string {
  if (state === 'missing') return 'missing';
  if (state === 'empty') return 'empty (no layers)';
  if (state === 'unusable') return 'unusable';
  return 'usable';
}

/**
 * What the Python router would have done with a snapshot that has no
 * usable style. Order matches the pre-retirement checks: the env legacy
 * path won over Detailed-without-a-style.
 */
function formerRouteWithoutStyle(
  cfg: DetailRoutingFields,
  renderEngineEnv: string | undefined,
  detailedOverride: boolean | undefined,
  wantDetailed: boolean,
): string {
  if (renderEngineEnv === 'osm' && !cfg.styleJson) return 'env-osm-legacy-config';
  if (wantDetailed && cfg.bounds) {
    return detailedOverride === true ? 'detailed-override-no-style' : 'detailed-osm-no-style';
  }
  if (wantDetailed) return 'detailed-without-bounds';
  return 'default-tile-path';
}

export function resolveFulfillRoute(
  cfg: DetailRoutingFields,
  renderEngineEnv: string | undefined,
  detailedOverride?: boolean,
): FulfillRoute {
  const wantDetailed = detailedOverride ?? cfg.minorRoads === true;
  const styleState = styleStateOf(cfg.styleJson);

  // Explicit engine=osm used to force the Python renderer, including when
  // a style was present. That request now fails. It is not replayed.
  if (cfg.engine === 'osm') {
    return {
      engine: 'rejected',
      minorRoads: wantDetailed,
      reason: 'cfg-engine-osm',
      failReason: 'osm-engine-retired',
      styleState,
      message:
        `OSM/Python renderer is retired (cfg-engine-osm). Not printed. ` +
        `styleJson is ${styleStatePhrase(styleState)}.`,
    };
  }

  if (styleState !== 'usable') {
    const former = formerRouteWithoutStyle(cfg, renderEngineEnv, detailedOverride, wantDetailed);
    return {
      engine: 'rejected',
      minorRoads: false,
      reason: former,
      failReason: 'missing-style',
      styleState,
      message:
        `No usable editor style (styleJson ${styleStatePhrase(styleState)}). ` +
        `Not printed. Previous route: ${former}.`,
    };
  }

  // Detailed with the editor's own style replays that style. The style
  // already encodes which classes are visible and at what opacity.
  if (wantDetailed) {
    if (cfg.bounds) {
      return {
        engine: 'maplibre',
        minorRoads: true,
        reason: detailedOverride === true ? 'detailed-override' : 'detailed-style-parity',
        styleState: 'usable',
      };
    }
    return {
      engine: 'maplibre',
      minorRoads: false,
      reason: 'detailed-without-bounds',
      styleState: 'usable',
      warning:
        'Detailed roads requested but the snapshot has no bounds — staying on ' +
        'the tile path to preserve framing; minor roads will be missing from ' +
        'the print file',
    };
  }

  return { engine: 'maplibre', minorRoads: false, reason: 'default-tile-path', styleState: 'usable' };
}

/**
 * /render (image-only) decision. Does not email. `RENDER_ENGINE` is ignored:
 * a usable style is MapLibre, and engine 'osm' or a missing style is a 400.
 */
export function rejectImageRender(input: {
  engine?: unknown;
  styleJson?: unknown;
}): ImageRenderRejection | null {
  const styleState = styleStateOf(input.styleJson);
  if (input.engine === 'osm') {
    return {
      status: 400,
      failReason: 'osm-engine-retired',
      styleState,
      error: 'OSM/Python renderer is retired. Send a MapLibre styleJson with at least one layer.',
    };
  }
  if (styleState !== 'usable') {
    return {
      status: 400,
      failReason: 'missing-style',
      styleState,
      error:
        `styleJson is ${styleStatePhrase(styleState)}. A MapLibre style with at least one layer ` +
        'is required. The OSM/Python fallback has been removed.',
    };
  }
  return null;
}
