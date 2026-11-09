/**
 * MapVibe Render Service — server.ts v3.5.0
 *
 * v3.0.0: Replace Playwright/SwiftShader browser pipeline with
 *   @maplibre/maplibre-gl-native (native OpenGL/EGL, no browser).
 *   Resolves vector-tile blank-map bug at zoom >= 13 in headless containers.
 *   Compositing (applyFades, drawPosterText) now runs via node-canvas
 *   using the identical Canvas 2D API — zero logic changes to poster rendering.
 *
 * Base image changed: mcr.microsoft.com/playwright → node:20-bookworm-slim
 *   (smaller image, explicit GL/EGL deps instead of bundled Chromium)
 *
 * Env vars:
 *   RENDER_API_SECRET        — required; auth for /render and /fulfill
 *   MAX_CONCURRENT           — max simultaneous renders (default: 4)
 *   MAX_QUEUE_SIZE           — max requests waiting in queue before 503 (default: 20)
 *   PRINTFUL_API_KEY         — Printful OAuth token
 *   PRINTFUL_STORE_ID        — Printful store ID (default: 17897492)
 *   BLOB_READ_WRITE_TOKEN    — Vercel Blob write token
 *   MAPTILER_API_KEY         — MapTiler API key (optional; used for glyph CDN)
 *   SITE_ORIGIN              — Site origin (default: https://mapvibestudio.com)
 *   VERCEL_APP_ORIGIN        — Vercel app origin for sprite absolutization
 */
import express, { Request, Response } from 'express';
import { timingSafeEqual, createHmac } from 'crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { put } from '@vercel/blob';
import sharp from 'sharp';
import PQueue from 'p-queue';
import {
  ALLOWED_TILE_HOSTS,
  PRIVATE_IP_RE,
  isAllowedUrl,
  extractUrls,
  validateStyleJsonUrls,
} from './url-allowlist.js';
import { computeRenderDims, PRODUCTION_RENDER_CAPS } from './render-dims.js';
import { memoryWatch } from './memory-watch.js';
import { planFulfillment } from './fulfill-plan.js';
import { healthIdentity } from './health-info.js';
import { applyFades, drawPosterText } from './poster-text.js';
import {
  preparePrintStyle,
  resolvePrintCamera,
} from './print-parity.js';
import {
  notifyFulfillFail,
} from './alerting.js';
import {
  requestIdMiddleware,
  getRequestId,
} from './request-id.js';
import {
  PRINTFUL_API_V1,
  PRINTFUL_API_V2,
  PRINTFUL_TERMINAL_STATUSES,
  type PrintfulOrderMatch,
  getPrintfulHeaders,
  resolveCatalogPlacement,
  findExistingPrintfulOrder,
  resolveExternalId,
  tryUpdateExistingOrder,
} from './printful.js';
import {
  GELATO_API_V4,
  recipientToGelatoAddress,
  fulfillGelato,
} from './gelato.js';
import {
  rejectImageRender,
  resolveFulfillRoute,
  type FulfillRoute,
} from './detail-routing.js';
import { notifyRejectedFulfillRoute } from './style-fail.js';
import { applyNeighbourhoodDetail } from './detailed-style.js';
import { encodePrintPng } from './print-png.js';
import { loadPackagedSrgbIcc } from './srgb-icc.js';

// Vendored ICC sRGB profile (sRGB2014). Print encodes embed this file.
// A missing or invalid profile fails startup so a print cannot ship untagged.
const packagedSrgbIcc = loadPackagedSrgbIcc();
console.log(`[startup] sRGB ICC profile loaded (${packagedSrgbIcc.bytes} bytes)`);

// Native renderer + compositing
// Load native renderer — log error but keep service alive if GL is unavailable
// eslint-disable-next-line @typescript-eslint/no-var-requires
let mbgl: any = null;
let mbglLoadError: string | null = null;
try {
  mbgl = require('@maplibre/maplibre-gl-native');
  console.log('[startup] @maplibre/maplibre-gl-native loaded OK');
} catch (e: any) {
  mbglLoadError = e?.message ?? String(e);
  console.error('[startup] FATAL: @maplibre/maplibre-gl-native failed to load:', mbglLoadError);
}

// Load node-canvas — same pattern
// eslint-disable-next-line @typescript-eslint/no-var-requires
let canvasModule: any = null;
try {
  canvasModule = require('canvas');
  console.log('[startup] canvas loaded OK');
} catch (e: any) {
  console.error('[startup] FATAL: canvas failed to load:', e?.message ?? e);
}
const createCanvas: any = canvasModule?.createCanvas;
const registerFont: any = canvasModule?.registerFont;

const app = express();
// Mint or accept x-request-id BEFORE bodyParser so every line of a request's
// logs can carry the same join key. See ./request-id.ts. Capture via
// getRequestId(res) inside handlers and concatenate into existing
// [fulfill/*] log strings — no logger-wrapper refactor needed.
app.use(requestIdMiddleware);
app.use(express.json({ limit: '2mb' }));

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET ?? '';

if (!API_SECRET) {
  console.error('[render] FATAL: RENDER_API_SECRET env var not set — refusing to start');
  process.exit(1);
}

// ── Printful constants / client extracted to ./printful.ts ──────────────────
// PRINTFUL_KEY / PRINTFUL_STORE_ID env vars are read lazily inside
// getPrintfulHeaders() so vitest stubEnv works without dynamic re-imports.

const PRINTFUL_KEY      = process.env.PRINTFUL_API_KEY      ?? '';
const PRINTFUL_STORE_ID = process.env.PRINTFUL_STORE_ID     ?? '17897492';

// ── Gelato constants / client extracted to ./gelato.ts ─────────────────────
// GELATO_API_KEY / GELATO_STORE_ID env vars are read lazily inside
// fulfillGelato so vitest stubEnv works without dynamic re-imports.
// Kept here as a local alias for the request-time API-key presence check.
const GELATO_KEY = process.env.GELATO_API_KEY ?? '';

// ── Config-render constants ──────────────────────────────────────────────────
const MAPTILER_API_KEY  = process.env.MAPTILER_API_KEY      ?? '';
const SITE_ORIGIN       = process.env.SITE_ORIGIN           ?? 'https://mapvibestudio.com';
const VERCEL_APP_ORIGIN = process.env.VERCEL_APP_ORIGIN     ?? 'https://mapvibe-studio-alpha.vercel.app';
const MAX_RENDER_PX_WH  = PRODUCTION_RENDER_CAPS.maxEdgePx;  // full 400 DPI up to 24×36; larger sizes drop DPI
const MAX_PX            = PRODUCTION_RENDER_CAPS.maxPx; // max single render/tile pixels; fits 400 DPI 24×36 (138 MP)
const MAX_ZOOM_RENDER   = 17;

// DPI policy (v3.6.0). These were inline literals at the computeRenderDims()
// call site; they are named here so /health can publish the SAME values the
// renderer actually uses. The studio-side preflight mirror
// (api/_render-limits.ts) re-derives these to decide, before dispatch, whether
// a paid order is renderable — a number moving on one side only is the exact
// drift that produced a stale gate on a live on-sale size.
const TARGET_DPI          = PRODUCTION_RENDER_CAPS.targetDpi;          // ceiling we never exceed
const MIN_SINGLE_PASS_DPI = PRODUCTION_RENDER_CAPS.minSinglePassDpi;  // advertised customer standard; below this, tile

// RENDER_ENGINE is no longer an engine switch. `osm` used to select the
// Python pipeline for snapshots with no styleJson. Those requests now fail.
// The value is still read so the failure names the old route (env-osm-legacy-config).
const RENDER_ENGINE  = process.env.RENDER_ENGINE  ?? 'maplibre';
if (RENDER_ENGINE === 'osm') {
  console.warn('[startup] RENDER_ENGINE=osm no longer selects a renderer. A snapshot without a usable styleJson fails instead of printing the Python map.');
}

const MAX_CONCURRENT    = parseInt(process.env.MAX_CONCURRENT    ?? '4',  10);
const MAX_QUEUE_SIZE    = parseInt(process.env.MAX_QUEUE_SIZE    ?? '20', 10);
const renderQueue       = new PQueue({ concurrency: MAX_CONCURRENT });
// ── Option C map style constants ─────────────────────────────────────────────
/**
 * Option C map style — confirmed Mon Jun 1 2026.
 *   • Road/path line layers:  line-width forced to 3.5 px
 *   • Park/greenery fill layers: visibility forced to 'visible'
 *
 * Applied to EVERY print render (renderConfigToBlobUrl) so output is
 * always consistent regardless of what the config snapshot stores.
 * Preview renders (/render) are unchanged — the editor controls those.
 */
const OPTION_C_LINE_WIDTH = 3.5;
// All road/path layer id patterns
const ROAD_LAYER_RE = /road|street|highway|motorway|trunk|primary|secondary|tertiary|residential|service|link|path|transit|rail/i;
// Secondary + minor roads to suppress — secondary through alley layers create visual noise
// at poster scale; hiding them reveals motorway / trunk / primary clearly for a premium finish.
const MINOR_ROAD_RE = /secondary|tertiary|residential|service|path|pedestrian|alley/i;
const PARK_LAYER_RE = /park|green|grass|vegetation|wood|forest|nature|meadow|garden|scrub/i;


// ── Print text-halo legibility system ────────────────────────────────────────
// Self-contained CIELAB pipeline (mirrors themes.ts computeHaloColor, no import).
// Applied to all symbol layers at print-render time so frame previews and Railway
// output match the editor canvas halo system from PR #130.
//
// Delta rule (tuned for print / cream-poster context):
//   L* >  85  →  L* − 8  (near-white: darken halo to avoid bleaching cream poster)
//   L* <  20  →  L* − 4  (near-black: deepen ink substrate)
//   20–85     →  no change (mid-tone: background IS the halo, zero visible ring)
//
// text-halo-width: print-optimised curve — max 3 px at z15 (editor max was 6 px).
// 3 px is sufficient to lift labels at poster scale without adding road-corridor weight.
function computeHaloColorForPrint(bgHex: string): string {
  const toLin = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const fromLin = (v: number) => { const c = Math.max(0, Math.min(1, v)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  const hex2 = (c: number) => Math.round(Math.max(0, Math.min(255, fromLin(c) * 255))).toString(16).padStart(2, '0');

  const ri = parseInt(bgHex.slice(1, 3), 16) / 255;
  const gi = parseInt(bgHex.slice(3, 5), 16) / 255;
  const bi = parseInt(bgHex.slice(5, 7), 16) / 255;
  const rl = toLin(ri), gl = toLin(gi), bl = toLin(bi);

  const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const Z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;

  const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  const Lstar = 116 * fy - 16;
  const astar = 500 * (fx - fy);
  const bstar = 200 * (fy - fz);

  if (Lstar >= 20 && Lstar <= 85) return bgHex; // mid-tone: no ring

  // Near-white: small L* drop + warm b* drift so halo reads as Rice White against
  // cream poster (#F5EDE4) rather than a clinical neutral grey ring. [Traditional Colors]
  // Near-black (L*≥10): ink-depth substrate (−3 L*). L*<10: use exact bg (avoids
  // clamp to pure #000000 which is meaningless against near-black grounds). [TC: Ink Ground]
  if (Lstar > 85) {
    const Lnew = Math.max(0, Lstar - 4);
    const aNew = astar + 0.5;    // barely visible warm bias
    const bNew = bstar + 2.5;    // ivory pull toward cream poster substrate
    const fy2 = (Lnew + 16) / 116;
    const fx2 = aNew / 500 + fy2;
    const fz2 = fy2 - bNew / 200;
    const finv2 = (t: number) => t > 0.2068966 ? t * t * t : (t - 16 / 116) / 7.787;
    const X2 = finv2(fx2) * Xn, Y2 = finv2(fy2) * Yn, Z2 = finv2(fz2) * Zn;
    const rl2 =  X2 * 3.2404542 - Y2 * 1.5371385 - Z2 * 0.4985314;
    const gl2 = -X2 * 0.9692660 + Y2 * 1.8760108 + Z2 * 0.0415560;
    const bl2 =  X2 * 0.0556434 - Y2 * 0.2040259 + Z2 * 1.0572252;
    return `#${hex2(rl2)}${hex2(gl2)}${hex2(bl2)}`;
  }

  if (Lstar < 10) return bgHex; // near-pure-black: exact bg avoids meaningless clamp

  const Lnew = Math.max(0, Lstar - 3);  // ink depth, slightly less than L*-4 to avoid clamp
  const fy2 = (Lnew + 16) / 116;
  const fx2 = astar / 500 + fy2;
  const fz2 = fy2 - bstar / 200;
  const finv = (t: number) => t > 0.2068966 ? t * t * t : (t - 16 / 116) / 7.787;
  const X2 = finv(fx2) * Xn, Y2 = finv(fy2) * Yn, Z2 = finv(fz2) * Zn;

  const rl2 =  X2 * 3.2404542 - Y2 * 1.5371385 - Z2 * 0.4985314;
  const gl2 = -X2 * 0.9692660 + Y2 * 1.8760108 + Z2 * 0.0415560;
  const bl2 =  X2 * 0.0556434 - Y2 * 0.2040259 + Z2 * 1.0572252;
  return `#${hex2(rl2)}${hex2(gl2)}${hex2(bl2)}`; // Ink Ground (near-black)
}

// Patch all symbol layers for print text-halo legibility.
// Called after patchStyleForOptionC so Road/park patches are already applied.
function patchStyleForHalo(style: Record<string, unknown>, bgHex?: string): Record<string, unknown> {
  const layers = style.layers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(layers)) return style;
  const haloColor = bgHex ? computeHaloColorForPrint(bgHex) : '#EBEBEB';
  // Print-optimised width curve: max 3 px at z15 — lifts labels without adding
  // visual weight to road corridors. (Editor uses up to 6 px; too aggressive for print.)
  const haloWidth = ['interpolate', ['linear'], ['zoom'], 10, 0.8, 12, 1.5, 14, 2.5, 15, 3];
  let patched = 0;
  for (const layer of layers) {
    if (String(layer.type ?? '') !== 'symbol') continue;
    const paint = (layer.paint ?? {}) as Record<string, unknown>;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = haloWidth;
    paint['text-halo-blur']  = 0.5;
    layer.paint = paint;
    patched++;
  }
  console.log(`[halo] ${patched} symbol layers patched — haloColor=${haloColor}`);
  return style;
}

function patchStyleForOptionC(style: Record<string, unknown>): Record<string, unknown> {
  const layers = style.layers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(layers)) return style;
  let roadPatched = 0;
  let roadHidden  = 0;
  let parkPatched = 0;
  for (const layer of layers) {
    const id   = String(layer.id   ?? '');
    const type = String(layer.type ?? '');
    // Road / path line layers
    if (type === 'line' && ROAD_LAYER_RE.test(id)) {
      if (MINOR_ROAD_RE.test(id)) {
        // Hide minor roads (tertiary / residential / service / path) — reduces poster clutter
        const layout = (layer.layout ?? {}) as Record<string, unknown>;
        layout['visibility'] = 'none';
        layer.layout = layout;
        roadHidden++;
      } else {
        // Enforce bold line width on major arteries (motorway / trunk / primary)
        const paint = (layer.paint ?? {}) as Record<string, unknown>;
        paint['line-width'] = OPTION_C_LINE_WIDTH;
        // Replace pure-black line-color with warm near-black (sumi ink #1D1B1C) for visual warmth
        if (paint['line-color'] === '#000000') paint['line-color'] = '#1D1B1C';
        layer.paint = paint;
        roadPatched++;
      }
    }
    // Park / greenery fill layers → ensure visible
    if (type === 'fill' && PARK_LAYER_RE.test(id)) {
      const layout = (layer.layout ?? {}) as Record<string, unknown>;
      layout['visibility'] = 'visible';
      layer.layout = layout;
      parkPatched++;
    }
  }
  console.log(`[optionC] style patched — ${roadPatched} road layers @ ${OPTION_C_LINE_WIDTH}px, ${roadHidden} secondary+minor road layers hidden, ${parkPatched} park layers visible`);
  return style;
}



// ── Auth ────────────────────────────────────────────────────────────────────
const COMPARE_KEY = Buffer.from('mapvibe-cte-v1');
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(Buffer.from(a)).digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(Buffer.from(b)).digest();
  return timingSafeEqual(ha, hb);
}
/**
 * Auth predicate with NO response side effect — for routes that must answer
 * unauthenticated callers (e.g. /health, which Railway probes without a key)
 * while still varying what they disclose. checkAuth() is the gate; this is the
 * question. Same constant-time comparison either way.
 */
function isAuthed(req: Request): boolean {
  const raw   = req.headers['x-api-key'] ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw[0] : '');
  return constantTimeEqual(token, API_SECRET);
}

function checkAuth(req: Request, res: Response): boolean {
  const ok = isAuthed(req);
  if (!ok) res.status(401).json({ error: 'Unauthorized' });
  return ok;
}

// Tile / asset allowlist + SSRF helpers extracted to ./url-allowlist.ts

// ── Font cache ───────────────────────────────────────────────────────────────
const FONT_CACHE_DIR = '/tmp/mapvibe-fonts';
const registeredFonts = new Set<string>();

/** Register system fallback fonts at startup so poster text renders without network calls. */
function registerSystemFonts(): void {
  const candidates: Array<{ path: string; family: string; weight?: string; style?: string }> = [
    // Liberation fonts (fonts-liberation apt package)
    // Neutral aliases so a custom poster family is not satisfied by a system face.
    { path: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',    family: 'Liberation-Sans-Fallback' },
    { path: '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',    family: 'Liberation-Mono-Fallback' },
    // Open Sans (fonts-open-sans)
    { path: '/usr/share/fonts/truetype/open-sans/OpenSans-Regular.ttf',           family: 'OpenSans-Fallback' },
    // DejaVu fallbacks
    { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',                    family: 'DejaVu-Sans-Fallback' },
    { path: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',                family: 'DejaVu-Mono-Fallback' },
  ];
  for (const c of candidates) {
    if (existsSync(c.path) && !registeredFonts.has(c.family)) {
      try {
        registerFont(c.path, { family: c.family, weight: c.weight ?? 'regular', style: c.style ?? 'normal' });
        registeredFonts.add(c.family);
        console.log(`[fonts] Registered ${c.family} from ${basename(c.path)}`);
      } catch (err) {
        console.warn(`[fonts] Could not register ${c.path}:`, err);
      }
    }
  }
}

/** Download a Google Font TTF and register it with node-canvas. Cached in /tmp. */
async function ensureFont(fontFamily: string, weight?: string): Promise<void> {
  if (!fontFamily || registeredFonts.has(fontFamily)) return;
  mkdirSync(FONT_CACHE_DIR, { recursive: true });
  const fontPath = join(FONT_CACHE_DIR, `${fontFamily.replace(/\s+/g, '_')}.ttf`);
  try {
    let ttfBuf: Buffer | null = null;
  if (existsSync(fontPath)) {
    const raw = readFileSync(fontPath);
    // Validate TTF magic: 00 01 00 00 | 'true' (0x74727565) | 'OTTO' (0x4F54544F)
    const validFont = raw.length > 4 && (
      (raw[0] === 0x00 && raw[1] === 0x01) ||
      (raw[0] === 0x74 && raw[1] === 0x72) ||
      (raw[0] === 0x4F && raw[1] === 0x54)
    );
    if (validFont) {
      ttfBuf = raw;
    } else {
      console.warn(`[ensureFont] Bad magic in cached ${fontPath} — purging and re-fetching`);
      try { unlinkSync(fontPath); } catch {}
    }
  }
    if (!ttfBuf) {
      // Fetch CSS from Google Fonts requesting TTF (older UA)
      const cssUrl = `https://fonts.googleapis.com/css?family=${encodeURIComponent(fontFamily)}:300,400,700`;
      const cssRes = await fetch(cssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!cssRes.ok) throw new Error(`Google Fonts CSS ${cssRes.status}`);
      const css = await cssRes.text();
      // Match any Google Fonts URL (modern kit= URLs no longer end with .ttf/.woff extension)
  const match = css.match(/src:\s*url\(([^)]+fonts\.gstatic\.com[^)]+)\)\s*format\(['\"](?:truetype|woff|opentype)['\"]\)/i)
             || css.match(/src:\s*url\((https?:\/\/[^)]+\.(?:ttf|woff))\)/i);
      if (!match) throw new Error('No TTF URL in Google Fonts CSS');
      const fontRes = await fetch(match[1], { signal: AbortSignal.timeout(15_000) });
      if (!fontRes.ok) throw new Error(`Font download ${fontRes.status}`);
      ttfBuf = Buffer.from(await fontRes.arrayBuffer());
      writeFileSync(fontPath, ttfBuf);
    }
    registerFont(fontPath, { family: fontFamily, ...(weight ? { weight } : {}) });
    registeredFonts.add(fontFamily);
    console.log(`[fonts] Registered ${fontFamily} from Google Fonts`);
  } catch (err) {
    console.warn(`[fonts] ${fontFamily} unavailable, falling back to system font:`, err);
  }
}

/** Register the editor poster faces bundled in ./assets/fonts/.
 *
 *  The editor's poster block is Roboto: city 700, coordinates 400, country
 *  and the credit line 300. node-canvas matches faces by the name table, and
 *  Light and Regular both ship as family "Roboto", so a weight-300 request
 *  lands on Regular. Roboto-Light.ttf is renamed to family "Roboto Light"
 *  (glyphs unchanged; Apache-2.0) and registered under that family.
 */
function registerBundledFonts(): void {
  const FONTS_DIR = join(__dirname, '..', 'assets', 'fonts');

  const bundled: Array<{
    family: string;
    weight: string;
    staticFile: string;
    variableFile: string;
  }> = [
    { family: 'Roboto Light', weight: '300', staticFile: 'Roboto-Light.ttf',    variableFile: 'Roboto-Light.ttf' },
    { family: 'Roboto',       weight: '400', staticFile: 'Roboto-Regular.ttf',  variableFile: 'Roboto-Regular.ttf' },
    { family: 'Roboto',       weight: '700', staticFile: 'Roboto-Bold.ttf',     variableFile: 'Roboto-Bold.ttf' },
  ];

  for (const { family, weight, staticFile, variableFile } of bundled) {
    const fontKey = `${family}:${weight}`;
    if (registeredFonts.has(fontKey)) continue;

    const staticPath   = join(FONTS_DIR, staticFile);
    const variablePath = join(FONTS_DIR, variableFile);
    const pathToUse    = existsSync(staticPath) ? staticPath : (existsSync(variablePath) ? variablePath : null);
    const sourceLabel  = pathToUse === staticPath ? `${staticFile} (static)` : `${variableFile} (variable)`;

    if (!pathToUse) {
      console.warn(`[fonts] Neither ${staticFile} nor ${variableFile} found in ${FONTS_DIR}`);
      continue;
    }

    try {
      registerFont(pathToUse, { family, weight });
      registeredFonts.add(fontKey);
      registeredFonts.add(family); // plain family name — ensureFont() lookup key
      console.log(`[fonts] Bundled font registered: ${family} wt=${weight} from ${sourceLabel}`);
    } catch (err) {
      console.warn(`[fonts] Could not register ${family} wt=${weight} from ${sourceLabel}:`, err);
    }
  }
}

// Register bundled design fonts first (no network required)
registerBundledFonts();
// Register available system fonts as fallbacks
registerSystemFonts();

// Poster typography (drawPosterText) and fades (applyFades) are in ./poster-text.ts.
// fullbleed is the editor bottom ease-in; applyFades decides that via fadeKind.

// ── OverlayParams type ───────────────────────────────────────────────────────
interface OverlayParams {
  displayCity:    string;
  displayCountry: string;
  fontFamily:     string;
  showPosterText: boolean;
  fadeStyle:      string;
  includeCredits: boolean;
  textLayout:     string;
  theme:          unknown;
}

// ── Native render pipeline ───────────────────────────────────────────────────
interface RenderParams {
  styleJson:     object;
  center:        [number, number];
  zoom:          number;
  bearing?:      number;
  pitch?:        number;
  width?:        number;
  height?:       number;
  printMode?:    boolean;
  overlay?:      OverlayParams;
  bounds?:       MapBounds;
  /** Actual DPI to embed in PNG pHYs metadata. Defaults to 400. */
  dpi?:          number;
  /**
   * Fraction of the canvas that holds the editor's visible composition.
   * 1 means the bounds fill the sheet (posters, frames). Canvas print areas
   * are larger than the visible product; the fraction is visible/print so
   * the framed map stays in the centre and the margin is wrap. Zoom is not
   * recomputed from this — the editor zoom is kept and the sheet's logical
   * viewport grows by 1/fraction.
   */
  visibleFraction?: { w: number; h: number };
  /**
   * Editor Clean / Detailed toggle. Detailed (`true`) leaves every opacity
   * curve alone. Clean leaves them alone too when `editorStyle` is set.
   */
  minorRoads?: boolean;
  /**
   * The styleJson is the editor's `map.getStyle()` snapshot (or a stored
   * copy of one). Trunk/primary opacity is left as the snapshot painted it.
   * Omit this only for a style that never went through the editor.
   */
  editorStyle?: boolean;
  /**
   * Internal map container in pixels (map.getContainer() before the CSS
   * 1/5.5 shrink). Absent on current snapshots; derived from bounds + zoom.
   */
  mapWidth?: number;
  mapHeight?: number;
}


// ── Bounds-based zoom helper ─────────────────────────────────────────────────
/** Geographic bounding box stored in config snapshots. */
interface MapBounds {
  west:  number;
  south: number;
  east:  number;
  north: number;
}

/**
 * Render a MapLibre GL style to PNG using the native renderer.
 * Replaces the Playwright/SwiftShader browser pipeline from v2.x.
 * Works at any zoom level; no browser or WebGL limitations.
 */

async function renderPngInternal(params: RenderParams): Promise<Buffer> {
  const { styleJson, center, zoom, bearing = 0, pitch = 0, overlay, bounds } = params;
  const [lng, lat] = center;

  // Clamp output dimensions
  let w = Math.max(100, Math.min(Math.floor(Number(params.width  ?? 2400)), MAX_RENDER_PX_WH));
  let h = Math.max(100, Math.min(Math.floor(Number(params.height ?? 2400)), MAX_RENDER_PX_WH));
  const ps = Math.sqrt(MAX_PX / (w * h));
  if (ps < 1) { w = Math.floor(w * ps); h = Math.floor(h * ps); }

  // Editor zoom + Terraink pixel ratio. The logical viewport is the internal
  // map (bounds at cfg.zoom), not the print pixel grid, so line-width and
  // opacity stops stay where the customer saw them. pixelRatio grows the
  // framebuffer to the print size. RENDER_DEVICE_SCALE is not applied: it
  // used to stand in for this ratio and would scale strokes a second time.
  const camera = resolvePrintCamera({
    zoom,
    bounds,
    outputWidth: w,
    outputHeight: h,
    visibleFractionW: params.visibleFraction?.w,
    visibleFractionH: params.visibleFraction?.h,
    mapWidth: params.mapWidth,
    mapHeight: params.mapHeight,
    maxZoom: MAX_ZOOM_RENDER,
  });
  if (process.env.RENDER_DEVICE_SCALE && process.env.RENDER_DEVICE_SCALE !== '1') {
    console.warn('[render] RENDER_DEVICE_SCALE is ignored; resolution comes from the editor pixel ratio');
  }

  // Bundled Roboto is registered at startup. This only fetches if that file is missing.
  await ensureFont('Roboto');
  // Also load any per-poster custom font override
  if (overlay?.fontFamily) await ensureFont(overlay.fontFamily);

  const renderStart = Date.now();

  // Create native map instance
  const map = new mbgl.Map({
    request(req: { url: string }, callback: (err: Error | null, res?: { data: Buffer }) => void) {
      const { url } = req;
      if (!isAllowedUrl(url)) {
        try { const { hostname } = new URL(url); console.warn(`[render] Blocked: ${hostname}`); } catch {}
        callback(new Error(`Blocked URL: ${url}`));
        return;
      }
      fetch(url, { signal: AbortSignal.timeout(20_000) })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          return r.arrayBuffer();
        })
        .then(buf => callback(null, { data: Buffer.from(buf) }))
        .catch(err => callback(err as Error));
    },
    ratio: camera.pixelRatio,
  });

  let rawRgba: Buffer;
  try {
    // Line widths are not multiplied: the style already stores the overzoom boost.
    // An editor snapshot keeps its own trunk/primary opacity. The Clean curve
    // is installed only when the request did not carry an editor style.
    map.load(preparePrintStyle(styleJson as { layers?: Array<{ id?: string; type?: string; paint?: Record<string, unknown> }> }, {
      minorRoads: params.minorRoads === true,
      editorStyle: params.editorStyle === true,
    }));

    rawRgba = await new Promise<Buffer>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Native render timeout (55s)')), 55_000);
      map.render(
        { zoom: camera.zoom, center: [lng, lat], width: camera.cssWidth, height: camera.cssHeight, bearing, pitch },
        (err: Error | null, buf: Buffer) => {
          clearTimeout(timeoutId);
          if (err) reject(err);
          else resolve(buf);
        },
      );
    });
  } finally {
    try { map.release(); } catch {}
  }

  const bufW = camera.bufferWidth;
  const bufH = camera.bufferHeight;
  if (rawRgba.length !== bufW * bufH * 4) {
    throw new Error(`[render] framebuffer is ${rawRgba.length} bytes, expected ${bufW}×${bufH} at ratio ${camera.pixelRatio}`);
  }
  // Terraink draws the GL canvas into the export bitmap. When the output is
  // smaller than the internal map, ratio stays 1 and this scale-down keeps
  // stroke weight proportional. A 1px float remainder takes the same path.
  const finalRgba = (bufW === w && bufH === h)
    ? rawRgba
    : await sharp(rawRgba, { raw: { width: bufW, height: bufH, channels: 4 } })
        .resize(w, h, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
        .raw()
        .toBuffer();

  const bgColor = (overlay?.theme as any)?.map?.overlayBg ?? (overlay?.theme as any)?.ui?.bg ?? '#f5f5f0';
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d') as any;

  const imageData = ctx.createImageData(w, h);
  imageData.data.set(finalRgba.slice(0, w * h * 4));
  ctx.putImageData(imageData, 0, 0);

  // 3. Fades + poster text
  if (overlay) {
    const fc = bgColor; // resolved via map.overlayBg → ui.bg → '#f5f5f0'
    applyFades(ctx, w, h, fc, overlay.fadeStyle || 'default', overlay.textLayout || 'centered');
    drawPosterText(ctx, w, h, overlay.theme || {},
      lat, lng,
      overlay.displayCity    || '',
      overlay.displayCountry || '',
      overlay.fontFamily     || '',
      overlay.showPosterText !== false,
      overlay.includeCredits !== false,
      overlay.textLayout     || 'centered',
    );
  }

  // Encode as sRGB RGB PNG — flattens alpha onto white, writes DPI, embeds the
  // vendored sRGB ICC profile. compressionLevel 9 is lossless.
  const rawData = (cv.getContext('2d') as any).getImageData(0, 0, w, h).data;
  const actualDensity = params.dpi ?? 400;
  const pngBuf = await encodePrintPng(rawData, w, h, actualDensity);
  const modeLabel = `${w}x${h}px zoom=${camera.zoom.toFixed(3)} css=${camera.cssWidth}x${camera.cssHeight} ratio=${camera.pixelRatio} (${camera.source})`;
  console.log(`[render] done in ${Math.round((Date.now()-renderStart)/1000)}s — ${modeLabel} (Sharp-RGB, ${actualDensity}DPI sRGB)`);
  return pngBuf;
}

// ── Printful helpers ─────────────────────────────────────────────────────────
interface PrintfulRecipient {
  name:         string;
  address1:     string;
  address2?:    string;
  city:         string;
  state_code:   string;
  country_code: string;
  zip:          string;
  phone?:       string;
}

// PRINTFUL_TERMINAL_STATUSES, findExistingPrintfulOrder, resolveExternalId,
// tryUpdateExistingOrder — all in ./printful.ts (tested in __tests__/printful.test.ts).


// ── Mercator helpers for tiled rendering ────────────────────────────────────────
function mercLatToY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}
function mercYToLat(y: number): number {
  return ((2 * Math.atan(Math.exp(y))) - Math.PI / 2) * (180 / Math.PI);
}

/**
 * Render a large poster in vertical tiles, stitch with Sharp, apply overlay post-stitch.
 * Each tile renders via renderPngInternal (no overlay); tiles are stitched into a single
 * Sharp buffer; fade gradient + text overlay applied on the full-resolution node-canvas.
 *
 * Archival 100×150 cm at 400 DPI: 3 tiles → 14,400×21,600 px total → ~366 DPI.
 */
async function renderTiledPng(
  params: RenderParams,
  totalW: number,
  totalH: number,
  numTiles: number,
): Promise<Buffer> {
  if (!params.bounds) {
    throw new Error('[tiled] bounds required for tiled rendering');
  }
  const { overlay, bounds } = params;
  const totalStart = Date.now();

  const totalMercTop    = mercLatToY(bounds.north);
  const totalMercBottom = mercLatToY(bounds.south);
  const tileBaseH = Math.ceil(totalH / numTiles);

  const rawTileBuffers: Array<{ buf: Buffer; top: number }> = [];
  for (let i = 0; i < numTiles; i++) {
    const tileTop   = i * tileBaseH;
    const thisTileH = Math.min(tileBaseH, totalH - tileTop);
    const fracTop    = tileTop    / totalH;
    const fracBottom = (tileTop + thisTileH) / totalH;
    const tileMercTop    = totalMercTop + (totalMercBottom - totalMercTop) * fracTop;
    const tileMercBottom = totalMercTop + (totalMercBottom - totalMercTop) * fracBottom;
    const tileNorth      = mercYToLat(tileMercTop);
    const tileSouth      = mercYToLat(tileMercBottom);

    console.log(`[tiled] tile ${i + 1}/${numTiles}: ${totalW}×${thisTileH}px (y ${tileTop}–${tileTop + thisTileH})`);
    // Same editor zoom as the sheet. The tile's own centre keeps the slice
    // on its geographic band; the sheet centre would repeat the middle band.
    const tileCenterLng = (bounds.west + bounds.east) / 2;
    const tileCenterLat = mercYToLat((tileMercTop + tileMercBottom) / 2);
    const tileBuf = await renderPngInternal({
      ...params,
      center:  [tileCenterLng, tileCenterLat],
      width:   totalW,
      height:  thisTileH,
      bounds:  { west: bounds.west, east: bounds.east, north: tileNorth, south: tileSouth },
      overlay: undefined,
      dpi:     undefined,
      // The slice is the whole tile. A sheet-level wrap fraction must not be
      // applied again inside each strip (tiled + wrap is already refused).
      visibleFraction: undefined,
      mapWidth: undefined,
      mapHeight: undefined,
    });
    rawTileBuffers.push({ buf: tileBuf, top: tileTop });
  }

  console.log(`[tiled] stitching ${numTiles} tiles → ${totalW}×${totalH}px`);
  const stitchedRaw = await sharp({
    create: { width: totalW, height: totalH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
  })
    .composite(rawTileBuffers.map(({ buf, top }) => ({ input: buf, top, left: 0 })))
    .raw()
    .toBuffer();

  const cv  = createCanvas(totalW, totalH);
  const ctx = cv.getContext('2d');
  const imgData = ctx.createImageData(totalW, totalH);
  imgData.data.set(new Uint8ClampedArray(stitchedRaw));
  ctx.putImageData(imgData, 0, 0);

  if (overlay && params.printMode) {
    const theme = (overlay.theme ?? {}) as any;
    const [lng, lat] = params.center;
    applyFades(ctx, totalW, totalH, theme?.map?.fade ?? '#1B2A4A', overlay.fadeStyle ?? 'fullbleed', overlay.textLayout ?? 'centered');
    drawPosterText(
      ctx, totalW, totalH, theme, lat, lng,
      overlay.displayCity    ?? '',
      overlay.displayCountry ?? '',
      overlay.fontFamily     ?? '',
      overlay.showPosterText !== false,
      overlay.includeCredits !== false,
      overlay.textLayout     ?? 'centered',
    );
  }

  const finalRaw      = (ctx.getImageData(0, 0, totalW, totalH) as any).data;
  const actualDensity = params.dpi ?? 400;
  const pngBuf = await encodePrintPng(finalRaw, totalW, totalH, actualDensity);

  console.log(`[tiled] done in ${Math.round((Date.now() - totalStart) / 1000)}s — ${totalW}×${totalH}px @ ${actualDensity} DPI`);
  return pngBuf;
}

// ── MapvibeConfigSnapshot type ───────────────────────────────────────────────
interface MapvibeConfigSnapshot {
  styleJson:      unknown;
  center:         [number, number];
  zoom:           number;
  bearing?:       number;
  pitch?:         number;
  bounds?:        MapBounds;
  widthCm:        number;
  heightCm:       number;
  displayCity:    string;
  displayCountry: string;
  fontFamily:     string;
  showPosterText: boolean;
  fadeStyle:      string;
  includeCredits: boolean;
  textLayout:     string;
  theme:          unknown;
  // engine 'osm' is rejected. osmTheme / osmDist are ignored leftovers from
  // the Python renderer; current orders still send them.
  engine?:   'maplibre' | 'osm';
  city?:     string;
  country?:  string;
  osmTheme?: string;
  osmDist?:  number;
  // Editor's road-detail toggle, persisted by useStoreConfig. True ⇒ Detailed
  // (residential / service / footway included); false / undefined ⇒ Arteries.
  // Customers who never touched the toggle have this undefined, which matches
  // the historical hardcoded behaviour at fulfillment.
  minorRoads?: boolean;
  // Editor flag (useStoreConfig). True means bounds are already the print
  // sheet, so fulfillment must not expand them by the canvas wrap again.
  dimensionsArePrintArea?: boolean;
  // Internal map container (map.getContainer() client size, before the CSS
  // 1/5.5 shrink). Not sent by useStoreConfig today. When present it is the
  // logical viewport; otherwise it is derived from bounds + zoom.
  mapWidth?: number;
  mapHeight?: number;
  // Flat palette fields still arrive on snapshots from ShopifyExportOverlay.
  // MapLibre replays styleJson; these colours are not a second renderer.
  textColor?:          string;
  bgColor?:            string;
  waterColor?:         string;
  parksColor?:         string;
  roadMotorwayColor?:  string;
  roadPrimaryColor?:   string;
  roadSecondaryColor?: string;
  roadTertiaryColor?:  string;
  roadLocalColor?:     string;
  railColor?:          string;
}

/**
 * Download config snapshot, render PNG at 400 DPI, upload to Vercel Blob.
 * 400 DPI is the production standard. Dimensions are aspect-ratio-scaled when
 * either axis would exceed MAX_RENDER_PX_WH — preserves poster proportions.
 */
async function downloadConfigSnapshot(configUrl: string): Promise<MapvibeConfigSnapshot | null> {
  try {
    const cfgRes = await fetch(configUrl, { signal: AbortSignal.timeout(10_000) });
    if (!cfgRes.ok) throw new Error(`Config fetch HTTP ${cfgRes.status}`);
    const rawCfg = await cfgRes.json() as Record<string, unknown>;
    return (rawCfg.snapshot ?? rawCfg) as MapvibeConfigSnapshot;
  } catch (err) {
    console.error('[fulfill] Config download failed:', err);
    return null;
  }
}

interface PrintWindow {
  visibleFractionW: number;
  visibleFractionH: number;
  visibleWIn: number;
  visibleHIn: number;
  hasWrap: boolean;
}

type ConfigRenderResult =
  | { ok: true; url: string }
  | {
      ok: false;
      kind: 'rejected';
      route: Extract<FulfillRoute, { engine: 'rejected' }>;
      city?: string;
      country?: string;
    }
  | { ok: false; kind: 'failed' };

async function renderConfigToBlobUrl(
  configUrl: string,
  dimsOverride?: { widthCm: number; heightCm: number },
  detailedRoads?: boolean,
  preloadedCfg?: MapvibeConfigSnapshot | null,
  printWindow?: PrintWindow,
): Promise<ConfigRenderResult> {
  // 1. Download config snapshot (skipped when /fulfill already fetched it,
  // so a download failure can be a non-2xx before the 202 ack).
  let cfg: MapvibeConfigSnapshot;
  if (preloadedCfg) {
    cfg = preloadedCfg;
  } else {
    const downloaded = await downloadConfigSnapshot(configUrl);
    if (!downloaded) return { ok: false, kind: 'failed' };
    cfg = downloaded;
  }

  // No usable style, or an explicit request for the retired OSM engine.
  // Fail before any pixels. The caller logs [FULFILL-FAIL] and emails.
  const route = resolveFulfillRoute(cfg, RENDER_ENGINE, detailedRoads);
  if (route.engine === 'rejected') {
    const city = cfg.displayCity || cfg.city || undefined;
    const country = cfg.displayCountry || cfg.country || undefined;
    return { ok: false, kind: 'rejected', route, city, country };
  }

  // 2. Compute pixel dims — HARD RULE: never under 300 DPI effective.
  //    dimsOverride (from SKU) takes priority over config snapshot.
  //
  //    v3.6.0 DPI selection (extracted to ./render-dims.ts, unit-tested):
  //    prefer the highest DPI ≤ 400 whose FULL frame fits a single pass
  //    (edge + area caps), floored at 300 — the advertised customer standard.
  //    Sizes that fit 400 render at 400 exactly as before; sizes whose
  //    single-pass ceiling is ≥ 300 (e.g. 70×100 cm → 365 DPI) render
  //    single-pass instead of tiling; only ceilings < 300 (e.g. 100×150 cm)
  //    take the tiled path (bounds required) or the capped fallback.
  const widthCm  = dimsOverride?.widthCm  ?? (Number(cfg.widthCm)  || 40.64);
  const heightCm = dimsOverride?.heightCm ?? (Number(cfg.heightCm) || 50.80);
  const dimSource = dimsOverride ? 'SKU override' : 'config snapshot';

  const dims = computeRenderDims(widthCm, heightCm, !!cfg.bounds, {
    targetDpi: TARGET_DPI,
    minSinglePassDpi: MIN_SINGLE_PASS_DPI,
    maxEdgePx: MAX_RENDER_PX_WH,
    maxPx: MAX_PX,
  });
  const { width, height, actualDpi, numTiles } = dims;

  if (printWindow?.hasWrap && numTiles > 1) {
    console.error(`[fulfill] canvas print area ${widthCm}×${heightCm} cm would tile ×${numTiles}; refusing (wrap must be single-pass)`);
    return { ok: false, kind: 'failed' };
  }

  if (dims.mode === 'tiled') {
    console.log(`[fulfill] Config render [TILED×${numTiles}] (${dimSource}): ${widthCm}×${heightCm}cm → ${width}×${height}px @ ${actualDpi} DPI`);
  } else {
    const fallbackNote = dims.mode === 'single-pass-fallback' ? ' (FALLBACK — no bounds for tiling)' : '';
    console.log(`[fulfill] Config render [single-pass] (${dimSource}): ${widthCm}×${heightCm}cm → ${width}×${height}px @ ${actualDpi} DPI${fallbackNote}`);
    if (actualDpi < 300) {
      console.error(`[fulfill] WARNING: effective DPI ${actualDpi} is below the 300 DPI floor for ${widthCm}×${heightCm}cm${fallbackNote}`);
    }
  }

  // 3. Patch style: inject tile/glyph sources, absolutize relative URLs
  let styleJson: Record<string, unknown>;
  try {
    styleJson = JSON.parse(JSON.stringify(cfg.styleJson)) as Record<string, unknown>;
    const sources = styleJson.sources as Record<string, Record<string, unknown>> | undefined;
    if (sources) {
      for (const src of Object.values(sources)) {
        if (typeof src?.url === 'string') {
          const needsPatch = src.url.includes('openfreemap.org') || src.url.startsWith('/') || src.url.includes('mapvibestudio.com');
          if (needsPatch) {
            src.url = `https://tiles.openfreemap.org/planet`;
          }
        }
      }
    }
    if (typeof styleJson.glyphs === 'string' && (styleJson.glyphs.startsWith('/') || styleJson.glyphs.includes('mapvibestudio.com')))
      styleJson.glyphs = MAPTILER_API_KEY
        ? `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${MAPTILER_API_KEY}`
        : `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`;
    if (typeof styleJson.sprite === 'string' && styleJson.sprite.startsWith('/'))
      styleJson.sprite = VERCEL_APP_ORIGIN + styleJson.sprite;
  } catch {
    styleJson = cfg.styleJson as Record<string, unknown>;
  }

  // ── Print styling ─────────────────────────────────────────────────────────
  // Width stops stay in editor pixels. renderPngInternal evaluates them at
  // the snapshot zoom and scales the framebuffer with pixelRatio, the way
  // Terraink's exporter does. The old 2.5× multiply stacked on top of the
  // 5.5^0.8 boost and printed roads about 14× heavier than the preview.
  // Set OPTION_C_STYLE=1 to restore the legacy constant-width clamp.
  // Styled Detailed uses this same camera (resolvePrintCamera). It does not
  // multiply line widths either.
  if (process.env.OPTION_C_STYLE === '1') {
    styleJson = patchStyleForOptionC(styleJson);
  }
  // ── Text-halo legibility: halos are applied at the canvas (poster-text) level
  // only, NOT to MapLibre tile symbol layers. Tile halos create road-corridor
  // glow that adds visual noise in dense cities. Canvas halos in drawPosterText()
  // bind to letter forms and coalesce naturally into a unified background glow.
  // patchStyleForHalo() call removed — function retained for reference.


  // 4. Use the user's design zoom directly (no boost).
  // Print render must show the SAME geographic area as the user designed.
  // Zoom-boosting changes the geographic extent, causes tile timeouts at z17,
  // and produces blank renders. The higher pixel count (4800×6000) gives
  // print-quality output at the user's chosen zoom without changing the view.
  const userZoom   = typeof cfg.zoom === 'number' && isFinite(cfg.zoom) ? cfg.zoom : 0;
  const renderZoom = Math.min(MAX_ZOOM_RENDER, userZoom);

  // 5. MapLibre only. Detailed + a real style replays that style through
  //    the same camera as Clean (resolvePrintCamera: editor zoom, pixel
  //    ratio, no second line-width scale). Unusable styles already returned.
  if (route.warning) console.warn(`[fulfill] ${route.warning}`);
  console.log(`[fulfill] engine route: ${route.engine} (${route.reason})`);
  const useDetailedParity = route.reason === 'detailed-style-parity' || route.reason === 'detailed-override';
  let pngBuffer: Buffer;

  // Native MapLibre pipeline — tiled or single-pass. Clean and styled
  // Detailed share renderPngInternal (resolvePrintCamera + poster-text).
  // A staff detailedRoads override may be sitting on a Clean snapshot, so
  // reveal the neighbourhood layers before that render. preparePrintStyle
  // leaves the style-file opacity curve alone when minorRoads is true.
  if (route.reason === 'detailed-override') {
    styleJson = applyNeighbourhoodDetail(styleJson);
  }
  const sharedParams: RenderParams = {
    styleJson,
    center:    cfg.center,
    zoom:      renderZoom,
    bearing:   cfg.bearing ?? 0,
    pitch:     cfg.pitch   ?? 0,
    bounds:    cfg.bounds,
    // Snapshot flag, not the route flag. detailed-without-bounds stays on
    // this path with route.minorRoads false, but the editor was in
    // neighbourhood mode and its opacity curve must be left alone.
    // The stored styleJson is the editor snapshot either way, so trunk/primary
    // opacity is not rewritten with the Clean curve.
    minorRoads: useDetailedParity ? true : cfg.minorRoads === true,
    editorStyle: true,
    ...(typeof cfg.mapWidth === 'number' && typeof cfg.mapHeight === 'number'
      ? { mapWidth: cfg.mapWidth, mapHeight: cfg.mapHeight }
      : {}),
    printMode: true,
    dpi:       actualDpi,
    ...(printWindow?.hasWrap ? {
      visibleFraction: { w: printWindow.visibleFractionW, h: printWindow.visibleFractionH },
    } : {}),
    overlay: {
      displayCity:    cfg.displayCity    ?? '',
      displayCountry: cfg.displayCountry ?? '',
      fontFamily:     cfg.fontFamily     ?? '',
      showPosterText: cfg.showPosterText !== false,
      fadeStyle:      (cfg.fadeStyle && cfg.fadeStyle !== 'text') ? cfg.fadeStyle : 'fullbleed',
      includeCredits: cfg.includeCredits !== false,
      textLayout:     cfg.textLayout     ?? 'centered',
      theme:          cfg.theme          ?? {},
    },
  };

  try {
    if (numTiles > 1) {
      pngBuffer = await renderTiledPng(sharedParams, width, height, numTiles);
    } else {
      pngBuffer = await renderPngInternal({ ...sharedParams, width, height });
    }
  } catch (err) {
    console.error('[fulfill] Render error:', err);
    return { ok: false, kind: 'failed' };
  }

  // 6. Validate PNG magic bytes
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!pngBuffer.slice(0, 8).equals(PNG_MAGIC)) {
    console.error('[fulfill] Render returned invalid PNG (bad magic bytes)');
    return { ok: false, kind: 'failed' };
  }

  // 7. Upload to Vercel Blob
  try {
    const hash = Math.random().toString(36).slice(2, 10);
    const blob = await put(`poster-${Date.now()}-${hash}.png`, pngBuffer, {
      access: 'public', contentType: 'image/png',
      ...(process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {}),
    });
    console.log(`[fulfill] PNG uploaded: ${blob.url} (${width}x${height}px @ ${actualDpi} DPI)`);
    return { ok: true, url: blob.url };
  } catch (err) {
    console.error('[fulfill] Blob upload failed:', err);
    return { ok: false, kind: 'failed' };
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────


app.get('/health', (req: Request, res: Response) => {
  // Public on purpose. Railway probes /health with no key, and the studio
  // webhook reads `capabilities` to see that this build accepts dryRun and
  // an explicit catalogue SKU. commit/build are a git SHA or the version
  // alone — never an API key.
  const identity = healthIdentity();
  res.json({
  status: 'ok',
  version: identity.version,
  commit: identity.commit,
  build: identity.build,
  capabilities: identity.capabilities,
  engine:  'maplibre',
  queue: {
    size:           renderQueue.size,
    pending:        renderQueue.pending,
    maxConcurrent:  MAX_CONCURRENT,
    maxQueueSize:   MAX_QUEUE_SIZE,
  },
  preview: {
    size:           0,
    pending:        0,
    concurrency:    0,
  },
  uptime: process.uptime(),
  // Value-level drift surface (2026-09-02). `version` alone only catches a
  // release; a cap or DPI-floor edit that ships without a version bump is the
  // drift nobody sees. These are the SAME constants passed to
  // computeRenderDims() on the fulfillment path, so this block cannot disagree
  // with what a real render does — which is the whole point of publishing it.
  // Consumed by the studio-side preflight mirror check (api/_render-limits.ts,
  // MIRRORED_FROM_VERSION + checkRenderServiceDrift).
  //
  // AUTHENTICATED ONLY: these are operational parameters — they name the exact
  // payload dimensions that exhaust this renderer. /health itself stays public
  // because Railway probes it without a key, so the route answers 200 either
  // way and only the disclosure varies. An unauthenticated caller sees no
  // `renderLimits` key at all; the drift monitor MUST present x-api-key and
  // MUST treat an absent key as "unverified", never as "no drift".
  ...(isAuthed(req) ? {
    renderLimits: {
      maxEdgePx:        MAX_RENDER_PX_WH,
      maxPx:            MAX_PX,
      targetDpi:        TARGET_DPI,
      minSinglePassDpi: MIN_SINGLE_PASS_DPI,
      mirror:           'api/_render-limits.ts',
    },
  } : {}),
  // Observability only (2026-09-02): in-process RSS high-water mark plus the
  // current reading. `peak` answers "how close to the ceiling did we come?";
  // `current` and `lastRender.heldAfterMb` answer "did the memory come back?".
  // See src/memory-watch.ts for the sampling-resolution caveat.
  memory: memoryWatch.report(),
  });
});

// POST /render — synchronous render, returns PNG
app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const {
    styleJson, center, zoom, bounds, width=2400, height=2400, bearing=0, pitch=0, printMode=false,
    mapWidth, mapHeight,
    displayCity, displayCountry, fontFamily, showPosterText, fadeStyle, includeCredits, textLayout, theme,
    // engine 'osm' is a hard error. osmTheme / osmDist / themeJson are ignored.
    // previewMode marks an editor preview tile; it does not select a renderer.
    engine, previewMode,
    // minorRoads — editor's Clean / Detailed toggle. MapLibre replays the
    // snapshot style; preparePrintStyle leaves the opacity curve alone when
    // this is true.
    minorRoads,
  } = req.body;

  if (!center||zoom==null) { res.status(400).json({error:'Missing required fields: center, zoom'}); return; }

  // No Python fallback. engine=osm and a style with no layers both 400.
  // This path does not email — /render is also used for image tests.
  const imageRejection = rejectImageRender({ engine, styleJson });
  if (imageRejection) {
    const engineLabel = typeof engine === 'string' ? engine.slice(0, 32) : 'unset';
    console.error(`[render] rejected code=${imageRejection.failReason} styleState=${imageRejection.styleState} engine=${engineLabel}`);
    res.status(imageRejection.status).json({ error: imageRejection.error, code: imageRejection.failReason });
    return;
  }
  const urlError = validateStyleJsonUrls(styleJson);
  if (urlError) { res.status(400).json({ error: urlError }); return; }

  // Queue-depth check — reject immediately if queue is saturated
  if (renderQueue.size >= MAX_QUEUE_SIZE) {
    console.warn(`[render] Queue full (${renderQueue.size}/${MAX_QUEUE_SIZE}) — rejecting`);
    res.status(503).json({
      error: 'Render service busy — try again shortly',
      queueSize: renderQueue.size,
      maxQueueSize: MAX_QUEUE_SIZE,
    });
    return;
  }

  const overlay: OverlayParams | undefined =
    (displayCity || displayCountry || showPosterText !== false) ? {
      displayCity:    displayCity    ?? '',
      displayCountry: displayCountry ?? '',
      fontFamily:     fontFamily     ?? '',
      showPosterText: showPosterText !== false,
      fadeStyle:      fadeStyle      ?? 'default',
      includeCredits: includeCredits !== false,
      textLayout:     textLayout     ?? 'centered',
      theme:          theme          ?? {},
    } : undefined;

  // Track client connection so we can skip an in-progress render when the
  // proxy / browser disconnects mid-flight.
  const clientAbort = new AbortController();
  let clientGone = false;
  // IMPORTANT: listen on `res`, NOT `req`. `app.use(express.json())` fully
  // consumes the request body stream before this handler runs, so the
  // IncomingMessage (`req`) reaches EOF and emits 'close' immediately — a
  // `req.on('close')` listener fires microseconds after we attach it and
  // aborts every render at 0s (regression observed 2026-06-15: every
  // preview "Client disconnected before response — aborting at 0s").
  //
  // The ServerResponse (`res`) 'close' event is the correct disconnect
  // signal: it fires when the response finishes (normal) OR the underlying
  // socket is torn down before we finish (real disconnect). The
  // writableEnded guard distinguishes the two — if we've already called
  // res.end()/res.json(), writableEnded is true and this was a normal close,
  // so we do nothing.
  const onClientClose = () => {
    if (res.writableEnded) return; // normal completion — not a disconnect
    clientGone = true;
    console.warn('[render] Client disconnected before response — aborting MapLibre render');
    clientAbort.abort();
  };
  res.on('close', onClientClose);

  console.log(`[render] Queued — size=${renderQueue.size} pending=${renderQueue.pending} engine=maplibre${previewMode ? ' previewMode' : ''}`);
  await renderQueue.add(async () => memoryWatch.track(
    `render ${width}×${height}px maplibre${previewMode ? ' previewMode' : ''}`,
    async () => {
    const renderStart = Date.now();
    try {
      // If the client gave up while we were waiting in the queue, skip the
      // render entirely.
      if (clientGone) {
        console.warn(`[render] Skipping queued render — client already gone`);
        return;
      }
      const png = await renderPngInternal({
        styleJson, center, zoom, bounds, bearing, pitch, width, height, printMode, overlay,
        minorRoads: minorRoads === true,
        // styleJson on this route is the editor's map.getStyle() snapshot.
        editorStyle: true,
        ...(typeof mapWidth === 'number' && typeof mapHeight === 'number' ? { mapWidth, mapHeight } : {}),
      });
      // Last-chance check: if the proxy disconnected before we send the bytes,
      // drop the response. The studio retry has already started a fresh request.
      if (clientGone) {
        console.warn(`[render] Render completed but client gone — discarding ${png.length} bytes`);
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      // Don't cache previews — same URL, different inputs each time.
      if (!printMode) res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(png);
    } catch (err: any) {
      const elapsed = Math.round((Date.now()-renderStart)/1000);
      // ABORTED isn't a render failure — it's the client cancelling. Logged
      // by the abort path; don't double-log or surface as error.
      if (err?.code === 'ABORTED' || clientGone) return;
      console.error(`[render] Error after ${elapsed}s:`, err.message || err);
      // Sanitize: never surface err.message in the response body — it can
      // carry file paths, MapLibre/canvas/sharp internals. Full error stays
      // in the Railway log via console.error above; wire only carries the
      // generic phrase.
      if (!res.headersSent) res.status(500).json({ error: 'Render failed', elapsed });
    } finally {
      res.off('close', onClientClose);
    }
  }));
});


// POST /preview — retired with the Python OSM renderer.
// The editor already has the MapLibre snapshot. This used to spawn matplotlib.
app.post('/preview', (req: Request, res: Response): void => {
  if (!checkAuth(req, res)) return;
  console.error('[preview] rejected: Python OSM preview renderer is retired');
  res.status(410).json({
    error: 'Python OSM preview renderer is retired. Use the MapLibre editor snapshot.',
    code: 'osm-engine-retired',
  });
});


// POST /fulfill — catalogue SKUs from data/catalogue-skus.csv, with the
// pre-catalogue metafield path kept for orders that still omit sku.
// LEGACY_SKU_PASSTHROUGH defaults on. dryRun / an mv-canary tag resolves
// routing and returns before any Gelato or Printful call.
interface FulfillBody {
  externalId:       string;
  recipient:        PrintfulRecipient;
  /** Explicit catalogue or legacy SKU. Never inferred from externalId. */
  sku?:             string;
  lineItems?:       { sku?: string }[];
  /** When true, validate and return routing. Do not render or place an order. */
  dryRun?:          boolean;
  /** A string or array containing "mv-canary" is also a dry run. */
  tags?:            string | string[];
  /** Editor flag. Also read from the config snapshot when that is fetched. */
  dimensionsArePrintArea?: boolean;
  /** Catalogue path ignores this. Legacy path orders this Printful variant id. */
  variantId?:       number;
  catalogVariantId?: number;
  label:            string;
  quantity:         number;
  pngUrl?:          string;
  configUrl?:       string;
  confirm?:         boolean;   // per-request override; falls back to PRINTFUL_AUTO_CONFIRM env var
  // Catalogue path ignores these. Legacy path uses them as the render size.
  widthCm?:         number;
  heightCm?:        number;
  // Dedícalo — gift/dedication card message to print on Printful packing slip
  gift?:            { message: string; para?: string };
  /** Catalogue path ignores a disagreement. Legacy path honours an explicit value. */
  provider?:          'printful' | 'gelato';
  gelatoProductUid?:   string;
  shopifyVariantId?:   number;
  // Staff-reprint override for the editor's road-detail mode. When present it
  // outranks the snapshot's persisted minorRoads. true replays Detailed
  // through MapLibre when the style has layers. false forces Clean. Absent
  // means the snapshot decides. A missing style fails either way.
  detailedRoads?:      boolean;
}

// recipientToGelatoAddress + fulfillGelato extracted to ./gelato.ts
// notifyFulfillFail + ALERT_WEBHOOK_URL extracted to ./alerting.ts

app.post('/fulfill', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const body = req.body as FulfillBody;
  const {
    externalId, recipient, variantId, label, quantity,
    pngUrl, configUrl, confirm: confirmOverride,
    widthCm: widthCmOverride, heightCm: heightCmOverride,
    gift, detailedRoads,
  } = body;

  if (!externalId || !recipient || !label || !quantity) {
    res.status(400).json({ error: 'Missing required fields: externalId, recipient, label, quantity' });
    return;
  }

  const planInput = (extra: { configDownloaded?: boolean; dimensionsArePrintArea?: boolean }) => ({
    sku: body.sku,
    lineItems: body.lineItems,
    label,
    dryRun: body.dryRun,
    tags: body.tags,
    hasPngUrl: !!pngUrl,
    hasConfigUrl: !!configUrl,
    configDownloaded: extra.configDownloaded,
    dimensionsArePrintArea: extra.dimensionsArePrintArea === true,
    callerProvider: body.provider ?? null,
    variantId: variantId ?? null,
    catalogVariantId: body.catalogVariantId ?? null,
    shopifyVariantId: body.shopifyVariantId ?? null,
    gelatoProductUid: body.gelatoProductUid ?? null,
    widthCm: widthCmOverride ?? null,
    heightCm: heightCmOverride ?? null,
    quantity,
  });

  let dimensionsArePrintArea = body.dimensionsArePrintArea === true;
  let plan = await planFulfillment(planInput({ dimensionsArePrintArea }));

  // Catalogue canvas still needs the snapshot before we ack. Legacy orders
  // download it after 202, which is what they do today — the ack stays fast
  // so a slow blob fetch cannot hold the Shopify webhook open. A dry run
  // downloads only to read dimensionsArePrintArea and to fail a bad configUrl;
  // it does not render pixels and does not call a vendor.
  let preloadedCfg: MapvibeConfigSnapshot | null = null;
  if ((plan.kind === 'accept' || plan.kind === 'dry-run') && plan.mode === 'catalogue' && plan.needsRender && configUrl) {
    preloadedCfg = await downloadConfigSnapshot(configUrl);
    if (!preloadedCfg) {
      plan = await planFulfillment(planInput({ dimensionsArePrintArea, configDownloaded: false }));
    } else if (preloadedCfg.dimensionsArePrintArea === true && !dimensionsArePrintArea) {
      dimensionsArePrintArea = true;
      plan = await planFulfillment(planInput({ dimensionsArePrintArea: true, configDownloaded: true }));
    }
  }

  if (plan.kind === 'invalid') {
    res.status(plan.httpStatus).json({ error: plan.message, ...(plan.dryRun ? { dryRun: true } : {}) });
    return;
  }
  if (plan.kind === 'reject') {
    console.error(`[fulfill] [SKU-MISMATCH-ALERT] ${plan.reason} sku=${plan.sku ?? 'none'} ${plan.message}`);
    notifyFulfillFail(externalId, plan.reason, plan.message);
    res.status(plan.httpStatus).json({ error: plan.message, sku: plan.sku, ...(plan.dryRun ? { dryRun: true } : {}) });
    return;
  }
  if (plan.kind === 'dry-run') {
    console.log(`[fulfill] dry-run ${plan.body.vendor} sku=${plan.body.sku ?? 'absent'} — no vendor call`);
    res.status(200).json(plan.body);
    return;
  }

  const decision = plan;
  // Catalogue already downloaded the snapshot. Reject a missing style or an
  // explicit OSM engine before the 202, and email. Legacy orders still ack
  // first; the async render below raises the same alert and does not call a
  // vendor. Holding the legacy ack open for the blob fetch would risk a
  // Shopify webhook timeout and a second dispatch.
  if (preloadedCfg && decision.needsRender) {
    const styleRoute = resolveFulfillRoute(preloadedCfg, RENDER_ENGINE, detailedRoads);
    if (styleRoute.engine === 'rejected') {
      notifyRejectedFulfillRoute(styleRoute, {
        externalId,
        city: preloadedCfg.displayCity || preloadedCfg.city || undefined,
        country: preloadedCfg.displayCountry || preloadedCfg.country || undefined,
      });
      res.status(422).json({
        error: styleRoute.message,
        reason: styleRoute.failReason,
        formerRoute: styleRoute.reason,
        styleState: styleRoute.styleState,
      });
      return;
    }
  }
  if (decision.mode === 'catalogue') {
    const gate = decision.gate;
    if (gate.vendor === 'printful' && !PRINTFUL_KEY) {
      console.error('[fulfill] PRINTFUL_API_KEY not configured');
      res.status(500).json({ error: 'PRINTFUL_API_KEY not configured on Railway' });
      return;
    }
    if (gate.vendor === 'gelato' && !GELATO_KEY) {
      console.error('[fulfill] GELATO_API_KEY not configured');
      res.status(500).json({ error: 'GELATO_API_KEY not configured on Railway' });
      return;
    }
    if (gate.callerProviderIgnored) {
      console.error(`[fulfill] caller provider '${body.provider}' ignored for ${gate.sku}; catalogue vendor is ${gate.vendor}`);
    }
    if (gate.callerVariantIgnored) {
      console.error(`[fulfill] caller variantId ${variantId ?? 'none'} ignored for ${gate.sku}; catalogue product is ${gate.productRef}`);
    }
    if ((widthCmOverride && Math.abs(widthCmOverride - gate.widthCm) > 0.2)
        || (heightCmOverride && Math.abs(heightCmOverride - gate.heightCm) > 0.2)) {
      console.error(`[fulfill] caller dimensions ${widthCmOverride ?? '?'}×${heightCmOverride ?? '?'} cm ignored for ${gate.sku}; catalogue is ${gate.widthCm}×${gate.heightCm} cm`);
    }
    res.status(202).json({
      success: true,
      accepted: true,
      externalId,
      sku: gate.sku,
      vendor: gate.vendor,
    });
  } else {
    if (decision.callerProvider === 'printful' && !PRINTFUL_KEY) {
      console.error('[fulfill] PRINTFUL_API_KEY not configured');
      res.status(500).json({ error: 'PRINTFUL_API_KEY not configured on Railway' });
      return;
    }
    if (decision.callerProvider === 'gelato' && !GELATO_KEY) {
      console.error('[fulfill] GELATO_API_KEY not configured');
      res.status(500).json({ error: 'GELATO_API_KEY not configured on Railway' });
      return;
    }
    console.log(`[fulfill] legacy passthrough sku=${decision.sku ?? 'absent'} → ${decision.resolvedProvider}`);
    res.status(202).json({ success: true, accepted: true, externalId });
  }

  void (async () => {
    let finalPngUrl: string | null = null;
    let vendor: 'gelato' | 'printful';
    let gelatoUid: string | null = null;
    let orderedVariantId: number | null = null;
    let failSku = decision.mode === 'catalogue' ? decision.gate.sku : (decision.sku ?? 'legacy');

    if (decision.mode === 'legacy') {
      finalPngUrl = pngUrl ?? null;
      if (!finalPngUrl && configUrl) {
        console.log(`[fulfill] Config path — rendering for ${externalId}`);
        await renderQueue.add(async () => memoryWatch.track(
          `fulfill ${externalId} ${widthCmOverride ?? '?'}×${heightCmOverride ?? '?'}cm`,
          async () => {
            const dimsOverride = (widthCmOverride && heightCmOverride)
              ? { widthCm: widthCmOverride, heightCm: heightCmOverride }
              : undefined;
            const rendered = await renderConfigToBlobUrl(configUrl, dimsOverride, detailedRoads);
            if (rendered.ok) {
              finalPngUrl = rendered.url;
            } else if (rendered.kind === 'rejected') {
              notifyRejectedFulfillRoute(rendered.route, {
                externalId,
                city: rendered.city,
                country: rendered.country,
              });
            } else {
              console.error(`[fulfill] Config render FAILED for ${externalId}`);
              notifyFulfillFail(externalId, 'config-render', `renderConfigToBlobUrl failed for ${configUrl}`);
            }
          },
        ));
        if (!finalPngUrl) return;
      }
      vendor = decision.resolvedProvider;
      gelatoUid = decision.gelatoProductUid;
      orderedVariantId = decision.printfulVariantId;
    } else {
      const accepted = decision.gate;
      const printWindow = decision.printWindow;
      finalPngUrl = accepted.needsRender ? null : (pngUrl ?? null);
      if (accepted.needsRender) {
        console.log(`[fulfill] Config path — ${accepted.sku} ${accepted.widthCm}×${accepted.heightCm} cm → ${accepted.dims.width}×${accepted.dims.height}px @ ${accepted.dims.actualDpi} DPI wrap=${printWindow.wrapApplied}`);
        await renderQueue.add(async () => memoryWatch.track(
          `fulfill ${externalId} ${accepted.sku} ${accepted.widthCm}×${accepted.heightCm}cm`,
          async () => {
            const rendered = await renderConfigToBlobUrl(
              configUrl!,
              { widthCm: accepted.widthCm, heightCm: accepted.heightCm },
              detailedRoads,
              preloadedCfg,
              printWindow,
            );
            if (rendered.ok) {
              finalPngUrl = rendered.url;
            } else if (rendered.kind === 'rejected') {
              notifyRejectedFulfillRoute(rendered.route, {
                externalId,
                city: rendered.city,
                country: rendered.country,
              });
            } else {
              console.error(`[fulfill] Config render FAILED for ${externalId} (${accepted.sku})`);
              notifyFulfillFail(externalId, 'config-render', `renderConfigToBlobUrl failed for ${configUrl}`);
            }
          },
        ));
        if (!finalPngUrl) return;
      }
      vendor = accepted.vendor;
      gelatoUid = accepted.gelatoProductUid;
      orderedVariantId = accepted.printfulVariantId;
    }

    if (vendor === 'gelato') {
      if (!gelatoUid) {
        console.error(`[fulfill/gelato] Missing gelato product UID for ${externalId} (${failSku})`);
        notifyFulfillFail(externalId, 'missing-gelato-uid', `No Gelato product UID for ${failSku}`);
        return;
      }
      await fulfillGelato(externalId, recipient, gelatoUid, quantity, label, finalPngUrl!);
      return;
    }
    if (orderedVariantId == null) {
      notifyFulfillFail(externalId, 'sku-unrenderable', `SKU ${failSku} resolved to Printful without a variant id`);
      return;
    }
    // ── Printful branch (default) ───────────────────────────────────────────
    const autoConfirm = confirmOverride !== undefined ? confirmOverride : process.env.PRINTFUL_AUTO_CONFIRM === 'true';
    const pfHeaders: Record<string, string> = {
      Authorization: `Bearer ${PRINTFUL_KEY}`, 'Content-Type': 'application/json',
    };
    if (PRINTFUL_STORE_ID) pfHeaders['X-PF-Store-Id'] = PRINTFUL_STORE_ID;

    // If a draft/pending Printful order already exists, update it with the new PNG
    // instead of silently skipping (handles re-trigger after partial failures).
    const wasUpdated = await tryUpdateExistingOrder(externalId, finalPngUrl!, orderedVariantId, quantity, label, autoConfirm, pfHeaders, gift);
    if (wasUpdated) return;

    const resolvedId = await resolveExternalId(externalId);
    if (!resolvedId) return;  // locked active order — skip
    const effectiveExternalId = resolvedId;

  const giftMessage = gift?.message
      ? (gift.para ? `To ${gift.para}: ${gift.message}` : gift.message)
      : null;
  // v2 API: placements[].layers[] format required — Printful v2 rejects files[] with 400.
  // resolveCatalogPlacement() discovers placement/technique via catalog endpoints (cached),
  // falling back to { placement: 'default', technique: 'PRINTING' } if catalog auth fails.
  const { placement: v2Placement, technique: v2Technique } =
    await resolveCatalogPlacement(orderedVariantId, pfHeaders);
  const v2Payload = {
      external_id: effectiveExternalId, shipping: 'STANDARD', recipient, confirm: autoConfirm,
      ...(giftMessage ? { packing_slip: { message: giftMessage } } : {}),
      items: [{ source: 'catalog', catalog_variant_id: orderedVariantId, quantity,
                name: `MapVibe — ${label}`,
                placements: [{ placement: v2Placement, technique: v2Technique,
                               layers: [{ type: 'file', url: finalPngUrl }] }] }],
    };

    try {
      let pfRes = await fetch(`${PRINTFUL_API_V2}/orders`, { method: 'POST', headers: pfHeaders, body: JSON.stringify(v2Payload) });
      let pfData: any = await pfRes.json();
      let apiVersion = 'v2';

      if (!pfRes.ok) {
        console.warn(`[fulfill] v2 failed for ${externalId} (HTTP ${pfRes.status}) — v2 body: ${JSON.stringify(pfData)} — trying v1 fallback`);
        const v1Payload = {
          external_id: effectiveExternalId, shipping: 'STANDARD', recipient, confirm: autoConfirm,
          ...(giftMessage ? { gift: { subject: 'A gift for you', message: giftMessage } } : {}),
          items: [{ variant_id: orderedVariantId, quantity,
                    name: `MapVibe — ${label}`, files: [{ type: 'default', url: finalPngUrl }] }],
        };
        pfRes = await fetch(`${PRINTFUL_API_V1}/orders`, { method: 'POST', headers: pfHeaders, body: JSON.stringify(v1Payload) });
        pfData = await pfRes.json();
        apiVersion = 'v1-fallback';
      }

      if (pfRes.ok) {
        const orderId = pfData.result?.id ?? pfData.data?.id;
        console.log(`[fulfill] Printful order created (${apiVersion}): ${orderId} for ${effectiveExternalId} (base: ${externalId})`);
        return;
      }

      const errMsg: string = (pfData.result ?? pfData.error?.message ?? pfData.code ?? '') + '';
      const isDuplicate = errMsg.toLowerCase().includes('external_id')
        || errMsg.toLowerCase().includes('already exists')
        || errMsg.toLowerCase().includes('duplicate');

      if (isDuplicate) {
        const existingAfterRace = await findExistingPrintfulOrder(externalId);
        if (existingAfterRace) {
          console.log(`[fulfill] Race dedup resolved: Printful order ${existingAfterRace} for ${externalId}`);
          return;
        }
        console.error(`[fulfill] Race dedup failed for ${externalId}:`, pfData);
        return;
      }

      console.error(`[fulfill] Printful error for ${externalId}:`, pfData);
      notifyFulfillFail(externalId, 'printful-api', pfData);
    } catch (err: any) {
      console.error(`[fulfill] Uncaught error for ${externalId}:`, err);
      notifyFulfillFail(externalId, 'printful-uncaught', err);
    }
  })();
});


// POST /warm — retired with the Python OSM graph cache.
app.post('/warm', (req: Request, res: Response): void => {
  if (!checkAuth(req, res)) return;
  console.error('[warm] rejected: Python OSM graph warm-up is retired');
  res.status(410).json({
    error: 'Python OSM graph warm-up is retired. MapLibre does not use the OSMnx cache.',
    code: 'osm-engine-retired',
  });
});

const listenPort = typeof PORT === 'string' ? parseInt(PORT, 10) : PORT;
app.listen(listenPort, '0.0.0.0', () => console.log(`MapVibe Render Service on 0.0.0.0:${listenPort}`));
