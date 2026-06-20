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
import { spawnSync, spawn } from 'child_process';
import { tmpdir } from 'os';
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
import {
  type RoutingResult,
  ROUTING_CACHE_TTL_MS,
  isStrictRoutingLookup,
  resolveGelatoRouting,
} from './routing.js';
import {
  type FulfillFailReason,
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

// ── sRGB ICC v4 profile — fetched once at startup for PNG embedding ───────────
let sRGBIccPath: string | null = null;
(async () => {
  try {
    const iccPath = `${tmpdir()}/sRGB_v4_ICC.icc`;
    const res = await fetch('https://www.color.org/sRGB_v4_ICC_preference.icc', {
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(iccPath, buf);
      sRGBIccPath = iccPath;
      console.log(`[startup] sRGB ICC v4 profile cached (${buf.length} bytes)`);
    } else {
      console.warn(`[startup] sRGB ICC fetch HTTP ${res.status} — PNG will export without explicit ICC`);
    }
  } catch (e: any) {
    console.warn('[startup] sRGB ICC fetch failed — PNG will export without explicit ICC:', e?.message);
  }
})();
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Shopify Admin constants (for metafield-based provider auto-routing) ───────
// Required for /fulfill to auto-detect pod_partner + gelato_uid without caller passing them.
// SHOPIFY_ADMIN_TOKEN: Admin API token (Settings → Apps → develop apps → access token).
// SHOPIFY_SHOP: myshopify domain, e.g. mapvibe-studio.myshopify.com
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN ?? '';
const SHOPIFY_SHOP        = process.env.SHOPIFY_SHOP        ?? 'mapvibe-studio.myshopify.com';

// ── Config-render constants ──────────────────────────────────────────────────
const MAPTILER_API_KEY  = process.env.MAPTILER_API_KEY      ?? '';
const SITE_ORIGIN       = process.env.SITE_ORIGIN           ?? 'https://mapvibestudio.com';
const VERCEL_APP_ORIGIN = process.env.VERCEL_APP_ORIGIN     ?? 'https://mapvibe-studio-alpha.vercel.app';
const PREVIEW_CANVAS_PX = parseInt(process.env.PREVIEW_CANVAS_PX ?? '600', 10) || 600;
const CM_PER_INCH       = 2.54;
const MAX_RENDER_PX_WH  = 14400;  // raised: gives full 400 DPI up to Grand; Studio/Archival aspect-ratio-scaled
const MAX_PX            = 150_000_000; // max single render/tile pixels; fits 400 DPI Grand (138 MP) and AR-scaled Studio/Archival
const MAX_ZOOM_RENDER   = 17;

// ── OSM renderer config ───────────────────────────────────────────────────────
// RENDER_ENGINE=osm  → use Python/OSMnx pipeline for fulfillment renders
// RENDER_ENGINE=maplibre (default) → keep native GL pipeline during transition
const RENDER_ENGINE  = process.env.RENDER_ENGINE  ?? 'maplibre';
const MAPVIBE_PYTHON = process.env.MAPVIBE_PYTHON ?? 'python3';
const OSM_SCRIPT     = join(__dirname, '..', 'python', 'mapvibe_render.py');

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
function checkAuth(req: Request, res: Response): boolean {
  const raw   = req.headers['x-api-key'] ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw[0] : '');
  const ok    = constantTimeEqual(token, API_SECRET);
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
    // NOTE: use neutral aliases so design fonts (Playfair Display / DM Sans) are always fetched from Google Fonts
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

/** Register design-system fonts bundled in ./assets/fonts/ at Docker build time.
 *  This eliminates the Google Fonts download dependency — fonts are always
 *  available regardless of outbound network access.
 *
 *  WEIGHT-AWARE REGISTRATION (fixes editor vs print typography mismatch):
 *  drawPosterText requests three Playfair Display weights (300, 400, 700) and
 *  two DM Sans weights (300, 400). node-canvas requires a registered face for
 *  each weight — when only one face is registered per family, ALL weight
 *  requests collapse onto that face and node-canvas synthesises "bold" via
 *  stroke-thickening (faux-bold). Result: city name renders as faux-bold
 *  instead of true 700, country renders as regular instead of true 300 —
 *  visibly different from what the editor's browser engine renders.
 *
 *  Resolution order per (family, weight):
 *    1. Weight-specific static file (e.g. PlayfairDisplay-Bold.ttf) — preferred,
 *       commit these alongside the existing variable TTF.
 *    2. Variable file (PlayfairDisplay.ttf) registered with the requested
 *       weight metadata — node-canvas v3+ uses the wght variation axis to
 *       pick the right instance.
 *    3. Skip — ensureFont() Google Fonts fallback covers it on first use.
 */
function registerBundledFonts(): void {
  const FONTS_DIR = join(__dirname, '..', 'assets', 'fonts');

  // Each row: [family, weight (CSS number), static filename, variable fallback].
  // The static filename is preferred — drop weight-specific TTFs into assets/fonts/
  // to get true (not synthesised) weights. Variable fallback always exists.
  const bundled: Array<{
    family: string;
    weight: string;
    staticFile: string;
    variableFile: string;
  }> = [
    // Playfair Display weight 300 (Light) intentionally omitted: no static Light instance on
    // Google Fonts; variable wght axis starts at 400. Both browser and node-canvas apply
    // nearest-weight fallback → '300 Playfair' requests land on the registered 400 face,
    // identical to editor behaviour. Listing it would log a misleading wt=300 registration.
    { family: 'Playfair Display', weight: '400', staticFile: 'PlayfairDisplay-Regular.ttf', variableFile: 'PlayfairDisplay.ttf' },
    { family: 'Playfair Display', weight: '700', staticFile: 'PlayfairDisplay-Bold.ttf',    variableFile: 'PlayfairDisplay.ttf' },
    { family: 'DM Sans',          weight: '300', staticFile: 'DMSans-Light.ttf',            variableFile: 'DMSans.ttf' },
    { family: 'DM Sans',          weight: '400', staticFile: 'DMSans-Regular.ttf',          variableFile: 'DMSans.ttf' },
    // IBM Plex Mono — editor body font used for coordinates and attribution in PosterTextOverlay
    { family: 'IBM Plex Mono',    weight: '400', staticFile: 'IBMPlexMono-Regular.ttf',     variableFile: '' },
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

// ── Compositing constants (match COMPOSITING_JS header in v2.x) ─────────────
// ── Poster strip constants — MUST match src/features/poster/domain/textLayout.ts ─
// TEXT_DIMENSION_REFERENCE_PX = 3600, edge margin = 2%
// City: base=250px min=110px  Country: base=92px  Coords: base=58px  Attribution: base=30px
// Letter-spacing (em): city=0.15  country=0.20  coords=0.25
const _DR = 3600, _AB = 30,   _EM = .02,  _CB = 250,  _CM = 110;
const _CS  = .15,  _CTB = 92,  _CTS = .20, _COB = 58,  _COS = .25; // match textLayout.ts §CITY/COUNTRY/COORDS_LETTER_SPACING

// ── Compositing functions — Canvas 2D API; identical logic to v2.x ──────────
function _wa(hex: any, a: any){var h=(hex||'#000').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';}
function _ph(hex: any){var h=(hex||'#808080').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return{r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0};}
function _dr(ctx: any, rx: any, ry: any, w: any, h: any, i?: any){i=i||4;var rw=Math.round(w),rh=Math.round(h);if(rw<=0||rh<=0)return;var t=ctx.getTransform(),ax=Math.round(rx+t.e),ay=Math.round(ry+t.f),id=ctx.getImageData(ax,ay,rw,rh),d=id.data,B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];for(var py=0;py<rh;py++){var rb=py*rw,br=(py&3)*4;for(var px=0;px<rw;px++){var ii=(rb+px)*4,dv=Math.round(((B[br+(px&3)]/15)-0.5)*2*i);d[ii]=Math.max(0,Math.min(255,d[ii]+dv));d[ii+1]=Math.max(0,Math.min(255,d[ii+1]+dv));d[ii+2]=Math.max(0,Math.min(255,d[ii+2]+dv));}}ctx.putImageData(id,ax,ay);}
function applyFades(ctx: any, W: any, H: any, color: any, fs: any, layout?: any){// 'fullbleed' is the canonical Option 4 name; maps to the bottom-only fade path
if(fs==='fullbleed')return; // fullbleed = no gradient, map fills edge-to-edge
if(fs==='none')return;if(fs==='text'){var tH=Math.round(H*0.25),tg=ctx.createLinearGradient(0,0,0,tH);tg.addColorStop(0,_wa(color,1));tg.addColorStop(.4,_wa(color,.45));tg.addColorStop(.7,_wa(color,.12));tg.addColorStop(1,_wa(color,0));ctx.fillStyle=tg;ctx.fillRect(0,0,W,tH);_dr(ctx,0,0,W,tH);var fH=Math.round(H*.065),gH=Math.round(H*.15),fT=H-fH-gH,fg=ctx.createLinearGradient(0,fT,0,fT+gH);fg.addColorStop(0,_wa(color,0));fg.addColorStop(.10,_wa(color,.04));fg.addColorStop(.22,_wa(color,.10));fg.addColorStop(.36,_wa(color,.26));fg.addColorStop(.5,_wa(color,.44));fg.addColorStop(.64,_wa(color,.63));fg.addColorStop(.76,_wa(color,.80));fg.addColorStop(.87,_wa(color,.92));fg.addColorStop(.95,_wa(color,.98));fg.addColorStop(1,color);ctx.fillStyle=fg;ctx.fillRect(0,fT,W,gH);ctx.fillStyle=color;ctx.fillRect(0,H-fH,W,fH);_dr(ctx,0,fT,W,gH+fH);} else {var _ds=Math.max(.45,Math.min(W,H)/_DR),_m=textMetrics(W,H,layout||'centered'),_bY0=_m.cY-_CB*_ds*.55,bY=Math.round(Math.max(_bY0-H*.035,H*.6)),bH=H-bY,bg=ctx.createLinearGradient(0,H,0,bY);if(process.env.DISABLE_EASEIN_FADE==='true'){bg.addColorStop(0,_wa(color,1));bg.addColorStop(.30,_wa(color,.70));bg.addColorStop(.65,_wa(color,.20));bg.addColorStop(1,_wa(color,0));}else{bg.addColorStop(0,_wa(color,1));bg.addColorStop(.12,_wa(color,.94));bg.addColorStop(.26,_wa(color,.80));bg.addColorStop(.40,_wa(color,.62));bg.addColorStop(.54,_wa(color,.43));bg.addColorStop(.66,_wa(color,.27));bg.addColorStop(.78,_wa(color,.14));bg.addColorStop(.88,_wa(color,.055));bg.addColorStop(.95,_wa(color,.014));bg.addColorStop(1,_wa(color,0));}ctx.fillStyle=bg;ctx.fillRect(0,bY,W,bH);_dr(ctx,0,bY,W,bH);}}
function fmtCoords(lat: any, lon: any){return Math.abs(lat).toFixed(4)+'\u00b0 '+(lat>=0?'N':'S')+' / '+Math.abs(lon).toFixed(4)+'\u00b0 '+(lon>=0?'E':'W');}
function fmtCity(c: any){if(!c)return'';var lc=0,ac=0;for(var i=0;i<c.length;i++){var ch=c[i];if(/[A-Za-z\u00C0-\u024F]/.test(ch)){lc++;ac++;}else if(/\p{L}/u.test(ch)){ac++;}}return(ac===0||lc/ac>.8)?c.toUpperCase():c;}
function shrinkFont(base: any, min: any, len: any, sp: any){len=Math.max(len,1);var s=base;if(len>10)s=Math.max(min,base*(10/len));var wE=len*.62+(len-1)*sp,mW=_DR*.92;if(wE*s>mW)s=Math.max(min,mW/wE);return s;}
function textMetrics(w: any, h: any, layout: any, cfs?: any, ctFS?: any, coFS?: any){
  // Y-ratios match textLayout.ts: TEXT_CITY_Y=0.885 DIVIDER=0.900 COUNTRY=0.915 COORDS=0.934
  // Editorial: EDITORIAL_CITY=0.820 DIVIDER=0.855 COUNTRY=0.885 COORDS=0.920
  if(layout==='editorial'){var x=w*.06;return{cX:x,cY:h*.820,dX:x,dY:h*.855,coX:x,coY:h*.885,crX:x,crY:h*.920,al:'left',dW:120};}
  var cx=w*.5,cY=h*.885;return{cX:cx,cY,dX:cx,dY:h*.900,coX:cx,coY:h*.915,crX:cx,crY:h*.934,al:'center',dW:w*.2};
}
function drawSpaced(ctx: any, text: any, x: any, y: any, sp: any, fs: any, al: any){if(sp===0){ctx.fillText(text,x,y);return;}var s=sp*fs,tot=ctx.measureText(text).width+s*(text.length-1),sx=al==='center'?x-tot/2:al==='right'?x-tot:x,sa=ctx.textAlign;ctx.textAlign='left';var cx=sx;for(var i=0;i<text.length;i++){var ch=text[i];ctx.fillText(ch,cx,y);cx+=ctx.measureText(ch).width+s;}ctx.textAlign=sa;}
function drawPosterText(ctx: any, W: any, H: any, theme: any, lat: any, lon: any, city: any, country: any, ff: any, showText: any, credits: any, layout: any){var land=(theme&&theme.map&&theme.map.land)||'#808080',rgb=_ph(land),luma=(.2126*rgb.r+.7152*rgb.g+.0722*rgb.b)/255;var tc=(theme&&theme.ui&&theme.ui.text)||(luma<.5?'#FFFFFF':'#111111'),ac=luma<.52?'#f5faff':'#0e1822';var tFF=ff?'"'+ff+'","Playfair Display",serif':'"Playfair Display",serif';var bFF=ff?'"'+ff+'","IBM Plex Mono",monospace':'"IBM Plex Mono",monospace';var ds=Math.max(.45,Math.min(W,H)/_DR),afs=_AB*ds;if(showText){var cl=fmtCity(city||''),cfs=shrinkFont(_CB*ds,_CM*ds,(city||'').length,_CS),ctFS=_CTB*ds,coFS=_COB*ds,m=textMetrics(W,H,layout||'centered',cfs,ctFS,coFS);ctx.fillStyle=tc;ctx.textAlign=m.al;ctx.textBaseline='middle';ctx.font='700 '+cfs+'px '+tFF;var _cW=ctx.measureText(cl).width+_CS*cfs*(cl.length>1?cl.length-1:0);if(m.al==='center')m.dW=Math.min(_cW,W*.20);m.cY=m.dY-cfs*.50;var _hr=_ph(land).r,_hg=_ph(land).g,_hb=_ph(land).b;ctx.shadowColor='rgba('+_hr+','+_hg+','+_hb+',.90)';ctx.shadowBlur=Math.max(4,Math.round(7*ds));drawSpaced(ctx,cl,m.cX,m.cY,_CS,cfs,m.al);ctx.strokeStyle=tc;ctx.lineWidth=3*ds;ctx.beginPath();if(m.al==='center'){ctx.moveTo(m.dX-m.dW/2,m.dY);ctx.lineTo(m.dX+m.dW/2,m.dY);}else{ctx.moveTo(m.dX,m.dY);ctx.lineTo(m.dX+m.dW,m.dY);}ctx.stroke();ctx.font='300 '+ctFS+'px '+tFF;drawSpaced(ctx,(country||'').toUpperCase(),m.coX,m.coY,_CTS,ctFS,m.al);ctx.globalAlpha=.75;ctx.font='400 '+coFS+'px '+bFF;drawSpaced(ctx,fmtCoords(lat,lon),m.crX,m.crY,_COS,coFS,m.al);ctx.globalAlpha=1;if(m.al==='center'){var fc=fmtCoords(lat,lon);var cW=ctx.measureText(fc).width+_COS*coFS*(fc.length>1?fc.length-1:0);var gL=24*ds,gG=9*ds;ctx.strokeStyle=tc;ctx.globalAlpha=.55;ctx.lineWidth=Math.max(1,1.5*ds);ctx.lineCap='round';ctx.beginPath();ctx.moveTo(m.crX-cW/2-gG-gL,m.crY);ctx.lineTo(m.crX-cW/2-gG,m.crY);ctx.moveTo(m.crX+cW/2+gG,m.crY);ctx.lineTo(m.crX+cW/2+gG+gL,m.crY);ctx.stroke();ctx.globalAlpha=1;}}ctx.shadowBlur=0;ctx.shadowColor='transparent';ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='right';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('\u00a9 OpenStreetMap contributors',W*(1-_EM),H*(1-_EM));ctx.globalAlpha=1;if(credits){ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='left';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('created with mapvibestudio.com',W*_EM,H*(1-_EM));ctx.globalAlpha=1;}}

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
 * Derive the correct MapLibre zoom level for a given bounding box and canvas.
 * Canvas-size-agnostic: same bounds always fills the same poster proportion
 * regardless of paper size. Mirrors terraink.app / MapLibre cameraForBounds.
 */
function zoomForBounds(b: MapBounds, vpW: number, vpH: number, tileSize = 512): number {
  const latToMerc = (lat: number) =>
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const lngRange = Math.abs(b.east - b.west) * (Math.PI / 180);
  const latRange = Math.abs(latToMerc(b.north) - latToMerc(b.south));
  // Guard against degenerate bounds (single point)
  if (lngRange < 1e-9 || latRange < 1e-9) return MAX_ZOOM_RENDER;
  const zW = Math.log2((vpW * 2 * Math.PI) / (lngRange * tileSize));
  const zH = Math.log2((vpH * 2 * Math.PI) / (latRange * tileSize));
  return Math.min(zW, zH, MAX_ZOOM_RENDER);
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

  // Full-resolution native GL render — Railway now has 4 GB RAM (Workstream A).
  // DEVICE_SCALE defaults to 1 (full res, no upscale, no Lanczos blur).
  // Emergency rollback without redeploy: set RENDER_DEVICE_SCALE=2 in Railway env.
  const DEVICE_SCALE = parseInt(process.env.RENDER_DEVICE_SCALE ?? '1', 10) || 1;
  const vpW = Math.ceil(w / DEVICE_SCALE);
  const vpH = Math.ceil(h / DEVICE_SCALE);
  w = vpW * DEVICE_SCALE;
  h = vpH * DEVICE_SCALE;

  // Ensure design-system fonts are always loaded from Google Fonts
  await Promise.all([ensureFont('Playfair Display', '400'), ensureFont('Playfair Display', '700'), ensureFont('DM Sans', '300'), ensureFont('DM Sans', '400'), ensureFont('IBM Plex Mono', '400')]);
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
    ratio: DEVICE_SCALE,
  });

  let rawRgba: Buffer;
  try {
    map.load(styleJson);

    // Use bounds-derived zoom if available — canvas-size-agnostic
    const renderZoomForCanvas = bounds ? zoomForBounds(bounds, vpW, vpH) : zoom;

    rawRgba = await new Promise<Buffer>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Native render timeout (55s)')), 55_000);
      map.render(
        { zoom: renderZoomForCanvas, center: [lng, lat], width: vpW, height: vpH, bearing, pitch },
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

  // When DEVICE_SCALE=1 (default), vpW=w and vpH=h — rawRgba IS the final buffer.
  // When DEVICE_SCALE>1 (emergency revert path), Lanczos upscale to w×h.
  const finalRgba = DEVICE_SCALE > 1
    ? await sharp(rawRgba, { raw: { width: vpW, height: vpH, channels: 4 } })
        .resize(w, h, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
        .raw()
        .toBuffer()
    : rawRgba;

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

  // Encode as sRGB RGB PNG via Sharp — flattens alpha onto white.
  // pHYs density = actual DPI after dimension caps (passed via params.dpi; defaults to 400).
  // compressionLevel 9 = maximum lossless compression (~10-15% smaller files vs 6).
  // sRGB ICC v4 profile embedded when available (fetched once at startup).
  const rawData = (cv.getContext('2d') as any).getImageData(0, 0, w, h).data;
  const actualDensity = params.dpi ?? 400;
  const metadataOpts: { density: number; icc?: string } = { density: actualDensity };
  if (sRGBIccPath) metadataOpts.icc = sRGBIccPath;
  const pngBuf = await sharp(Buffer.from(rawData), { raw: { width: w, height: h, channels: 4 } })
    .flatten({ background: '#ffffff' })
    .withMetadata(metadataOpts)
    .toColorspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();
  const modeLabel = DEVICE_SCALE > 1 ? `${vpW}x${vpH}→${w}x${h}px (Lanczos${DEVICE_SCALE}x)` : `${w}x${h}px (native-res)`;
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
    const tileBuf = await renderPngInternal({
      ...params,
      width:   totalW,
      height:  thisTileH,
      bounds:  { west: bounds.west, east: bounds.east, north: tileNorth, south: tileSouth },
      overlay: undefined,
      dpi:     undefined,
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
  const metaOpts: { density: number; icc?: string } = { density: actualDensity };
  if (sRGBIccPath) metaOpts.icc = sRGBIccPath;

  const pngBuf = await sharp(Buffer.from(finalRaw), { raw: { width: totalW, height: totalH, channels: 4 } })
    .flatten({ background: '#ffffff' })
    .withMetadata(metaOpts)
    .toColorspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();

  console.log(`[tiled] done in ${Math.round((Date.now() - totalStart) / 1000)}s — ${totalW}×${totalH}px @ ${actualDensity} DPI`);
  return pngBuf;
}



// ── OSM Python renderer ───────────────────────────────────────────────────────

interface OsmRenderParams {
  city?:           string;
  country?:        string;
  lat:             number;
  lng:             number;
  display_city:    string;
  display_country: string;
  theme_name?:     string;
  theme_json?:     unknown;
  dist?:           number;
  /**
   * Override for matplotlib's axis half-extent. When omitted, Python uses
   * `dist` itself (legacy /fulfill contract). `/render` passes the post-
   * formula fetch radius so the visible axes equal what OSMnx actually has
   * data for, eliminating the empty background area on bounds-tight previews.
   */
  crop_dist?:      number;
  width_in:        number;
  height_in:       number;
  dpi:             number;
  show_text?:      boolean;
  full_bleed?:     boolean;
  no_fade?:        boolean;
  minor_roads?:    boolean;
}

/**
 * Render a city map poster using the Python/OSMnx pipeline (maptoposter).
 * Full bleed, no fade, minor roads hidden — museum-grade output at target DPI.
 *
 * DPI contract:
 *   • Standard sizes  → 400 DPI (caller must pass actualDpi)
 *   • Archival        → ≥300 DPI (tiled path maintains this via actualDpi)
 *
 * @param params  OsmRenderParams
 * @returns       PNG Buffer
 */
async function renderOsmPython(params: OsmRenderParams, signal?: AbortSignal): Promise<Buffer> {
  const tmpFile = join(tmpdir(), `mapvibe-osm-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const payload = JSON.stringify({ ...params, output_path: tmpFile });
  const renderStart = Date.now();

  // Async spawn so the caller can kill the Python subprocess when the client
  // (Vercel proxy / Shopify webhook) disconnects mid-render. The previous
  // spawnSync blocked the Node event loop for the full 30-90 s of an OSM
  // render — even if /render's request had already closed, we kept Overpass
  // fetching, matplotlib drawing, and PNG encoding. Production observation
  // 2026-06-14: a 72 s render finished and was discarded after Vercel's 50 s
  // proxy timeout because the disconnect handler couldn't run while spawnSync
  // held the loop. Pure waste on both sides.
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(MAPVIBE_PYTHON, [OSM_SCRIPT], { timeout: 300_000 });

    // Collect stderr for diagnostic logging AND forward it to the parent
    // process's stderr in real time. The earlier version only kept stderrBuf
    // for the failure path (lines 926 / 930). On the success path, the entire
    // Python log — including `[mapvibe_render] Fetch phase Xs — streets=…`,
    // `Done — N bytes`, geocode warnings, etc. — was silently discarded, so
    // Railway showed only the `[render] Queued` / `[osm] render done` lines
    // emitted from this file. That made it impossible to tell whether 0024's
    // graph cache was hitting or missing on any given render (production
    // 2026-06-16 logs). Forwarding to process.stderr keeps Railway's log
    // collector flushing each line as Python writes it, while stderrBuf still
    // tail-buffers the last 800 bytes for error-path reporting.
    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrBuf += chunk.toString();
    });

    // Send the params payload over stdin, then close — Python reads stdin to
    // EOF before parsing.
    child.stdin.write(payload);
    child.stdin.end();

    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    // SIGTERM gives Python a chance to flush; SIGKILL is the hard fallback if
    // it ignores the polite ask for 2 seconds.
    const killChild = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000);
    };

    const onAbort = () => {
      const elapsed = Math.round((Date.now() - renderStart) / 1000);
      console.warn(`[osm] aborted at ${elapsed}s — killing Python subprocess (pid=${child.pid})`);
      killChild();
      settle(() => {
        try { unlinkSync(tmpFile); } catch { /* may not exist */ }
        const err = new Error('aborted') as Error & { code?: string };
        err.code = 'ABORTED';
        reject(err);
      });
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: Error) => {
      settle(() => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`[osm] Python spawn error: ${err.message}`));
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      signal?.removeEventListener('abort', onAbort);
      const elapsed = Math.round((Date.now() - renderStart) / 1000);

      if (code !== 0) {
        try { unlinkSync(tmpFile); } catch { /* may not exist */ }
        settle(() => reject(new Error(`[osm] Python renderer exited ${code}: ${stderrBuf.slice(-800)}`)));
        return;
      }
      if (!existsSync(tmpFile)) {
        settle(() => reject(new Error(`[osm] Python renderer produced no output file. stderr: ${stderrBuf.slice(-500)}`)));
        return;
      }

      const pngBuf = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
      console.log(`[osm] render done in ${elapsed}s — ${pngBuf.length.toLocaleString()} bytes (${params.dpi} DPI, ${params.width_in?.toFixed(1)}×${params.height_in?.toFixed(1)}in)`);
      settle(() => resolve(pngBuf));
    });
  });
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
  // OSM renderer fields (only used when engine === 'osm' or RENDER_ENGINE=osm)
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
}

/**
 * Download config snapshot, render PNG at 400 DPI, upload to Vercel Blob.
 * 400 DPI is the production standard. Dimensions are aspect-ratio-scaled when
 * either axis would exceed MAX_RENDER_PX_WH — preserves poster proportions.
 */
async function renderConfigToBlobUrl(
  configUrl: string,
  dimsOverride?: { widthCm: number; heightCm: number },
): Promise<string | null> {
  // 1. Download config snapshot
  let cfg: MapvibeConfigSnapshot;
  try {
    const cfgRes = await fetch(configUrl, { signal: AbortSignal.timeout(10_000) });
    if (!cfgRes.ok) throw new Error(`Config fetch HTTP ${cfgRes.status}`);
    const rawCfg = await cfgRes.json() as Record<string, unknown>;
    cfg = (rawCfg.snapshot ?? rawCfg) as MapvibeConfigSnapshot;
  } catch (err) {
    console.error('[fulfill] Config download failed:', err);
    return null;
  }

  // 2. Compute pixel dims at 400 DPI — HARD RULE: never under 300 DPI effective.
  //    dimsOverride (from SKU) takes priority over config snapshot.
  //
  //    v3.5.0 Tiled path: if nominalH > MAX_RENDER_PX_WH and bounds are present,
  //    we tile vertically (renderTiledPng). This gives Archival ~366 DPI vs 244 before.
  //    Single-pass path: AR-preserving scale (unchanged for all smaller sizes).
  const DPI      = 400;
  const widthCm  = dimsOverride?.widthCm  ?? (Number(cfg.widthCm)  || 40.64);
  const heightCm = dimsOverride?.heightCm ?? (Number(cfg.heightCm) || 50.80);
  const nominalW = Math.round((widthCm  / CM_PER_INCH) * DPI);
  const nominalH = Math.round((heightCm / CM_PER_INCH) * DPI);
  const dimSource = dimsOverride ? 'SKU override' : 'config snapshot';

  // Tiled if height exceeds single-pass limit and we have geographic bounds for subdivision
  const needsTiling = nominalH > MAX_RENDER_PX_WH && !!cfg.bounds;

  let width: number;
  let height: number;
  let actualDpi: number;
  let numTiles = 1;

  if (needsTiling) {
    // Width: cap to MAX_RENDER_PX_WH. Height: maintain AR (same scale as width).
    const wScale = Math.min(1, MAX_RENDER_PX_WH / nominalW);
    width        = Math.round(nominalW * wScale);
    height       = Math.round(nominalH * wScale);
    actualDpi    = Math.round(width / (widthCm / CM_PER_INCH));
    const maxTileH = Math.floor(MAX_PX / width);
    numTiles       = Math.ceil(height / maxTileH);
    console.log(`[fulfill] Config render [TILED×${numTiles}] (${dimSource}): ${widthCm}×${heightCm}cm → ${width}×${height}px @ ${actualDpi} DPI`);
  } else {
    // AR-preserving single-pass
    const dimScale = Math.min(1, MAX_RENDER_PX_WH / Math.max(nominalW, nominalH));
    width          = Math.round(nominalW * dimScale);
    height         = Math.round(nominalH * dimScale);
    actualDpi      = Math.round(width / (widthCm / CM_PER_INCH));
    console.log(`[fulfill] Config render [single-pass] (${dimSource}): ${widthCm}×${heightCm}cm → ${width}×${height}px @ ${actualDpi} DPI`);
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

  // ── Option C print render: enforce 3.5 px roads + parks visible ──────────
  styleJson = patchStyleForOptionC(styleJson);
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

  // 5. Render via OSM Python pipeline or native MapLibre pipeline
  //    OSM path: activated by cfg.engine === 'osm' OR RENDER_ENGINE env var
  //    Inherits the same 400 DPI / tiled / AR-preserving dimension logic above.
  const useOsm = cfg.engine === 'osm' || RENDER_ENGINE === 'osm';
  let pngBuffer: Buffer;

  if (useOsm) {
    const widthIn  = widthCm  / CM_PER_INCH;
    const heightIn = heightCm / CM_PER_INCH;
    const osmParams: OsmRenderParams = {
      city:            cfg.city            ?? '',
      country:         cfg.country         ?? '',
      lat:             cfg.center[1],        // MapLibre center = [lng, lat]
      lng:             cfg.center[0],
      display_city:    cfg.displayCity     ?? '',
      display_country: cfg.displayCountry  ?? '',
      theme_name:      cfg.osmTheme        ?? 'midnight_blue',
      dist:            cfg.osmDist         ?? 15000,
      width_in:        widthIn,
      height_in:       heightIn,
      dpi:             actualDpi,
      show_text:       cfg.showPosterText  !== false,
      full_bleed:      true,
      no_fade:         true,
      // Snapshot's road-detail toggle. Falls back to false when the order
      // was placed by the studio version that didn't persist the field,
      // matching the historical hardcoded behaviour byte-for-byte.
      minor_roads:     cfg.minorRoads === true,
    };
    console.log(`[fulfill] OSM render: ${cfg.displayCity}, ${cfg.displayCountry} @ ${actualDpi} DPI (${widthIn.toFixed(1)}×${heightIn.toFixed(1)}in) minor_roads=${osmParams.minor_roads}`);
    try {
      pngBuffer = await renderOsmPython(osmParams);
    } catch (err) {
      console.error('[fulfill] OSM render error:', err);
      return null;
    }
  } else {
  // Native MapLibre pipeline — tiled or single-pass
  const sharedParams: RenderParams = {
    styleJson,
    center:    cfg.center,
    zoom:      renderZoom,
    bearing:   cfg.bearing ?? 0,
    pitch:     cfg.pitch   ?? 0,
    bounds:    cfg.bounds,
    printMode: true,
    dpi:       actualDpi,
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
    if (needsTiling) {
      pngBuffer = await renderTiledPng(sharedParams, width, height, numTiles);
    } else {
      pngBuffer = await renderPngInternal({ ...sharedParams, width, height });
    }
  } catch (err) {
    console.error('[fulfill] Render error:', err);
    return null;
  }
  } // end else (MapLibre path)

  // 6. Validate PNG magic bytes
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!pngBuffer.slice(0, 8).equals(PNG_MAGIC)) {
    console.error('[fulfill] Render returned invalid PNG (bad magic bytes)');
    return null;
  }

  // 7. Upload to Vercel Blob
  try {
    const hash = Math.random().toString(36).slice(2, 10);
    const blob = await put(`poster-${Date.now()}-${hash}.png`, pngBuffer, {
      access: 'public', contentType: 'image/png',
      ...(process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {}),
    });
    console.log(`[fulfill] PNG uploaded: ${blob.url} (${width}x${height}px @ ${actualDpi} DPI)`);
    return blob.url;
  } catch (err) {
    console.error('[fulfill] Blob upload failed:', err);
    return null;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────


app.get('/health', (_req: Request, res: Response) => res.json({
  status: 'ok',
  version: '3.5.0',
  engine:  RENDER_ENGINE,
  queue: {
    size:           renderQueue.size,
    pending:        renderQueue.pending,
    maxConcurrent:  MAX_CONCURRENT,
    maxQueueSize:   MAX_QUEUE_SIZE,
  },
  uptime: process.uptime(),
}));

// POST /render — synchronous render, returns PNG
app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const {
    styleJson, center, zoom, bounds, width=2400, height=2400, bearing=0, pitch=0, printMode=false,
    displayCity, displayCountry, fontFamily, showPosterText, fadeStyle, includeCredits, textLayout, theme,
    // ── OSM/maptoposter routing ─────────────────────────────────────────────
    // engine — per-request override; falls back to RENDER_ENGINE env var.
    // osmTheme / osmDist — already plumbed by api/render-and-upload (PR #140).
    // previewMode — sent by the editor's live preview tile (studio PR #142)
    //   so the server can shape DPI / quality cheaply. Print previews and
    //   live preview tile go through this endpoint; full-print fulfillment
    //   goes through /fulfill which has its own OSM branch.
    engine, osmTheme, osmDist, previewMode,
    // themeJson — Python-shaped palette object assembled by the Vercel proxy
    // from the studio's flat per-color fields. When present we hand it to
    // renderOsmPython as `theme_json`; Python uses it directly instead of
    // `load_theme(osmTheme)`, so the preview matches the editor's actual
    // colors (vintage_noir cream/black instead of midnight_blue navy/gold).
    themeJson,
    // minorRoads — editor's Clean / Detailed road-detail toggle. When the
    // studio sends `true` we include residential / service / footway in
    // both the Overpass fetch and the matplotlib draw, matching what the
    // user is looking at in the editor canvas. Falls back to false (the
    // historical hardcoded default) when omitted.
    minorRoads,
    // dpi — explicit DPI override from the studio's two-stage preview.
    //   Stage 1 (rough): dpi=32, preview_max_px=480 → ~3-6s
    //   Stage 2 (full):  dpi=96, preview_max_px=480 → faster than today
    // Falls back to the previewMode heuristic (96 / 300) when absent.
    dpi: dpiOverride,
    // preview_max_px — cap the PNG long edge so max(W,H) px == this value.
    // Supersedes the OSM_MAX_PIXELS pixel-budget when present.
    preview_max_px,
  } = req.body;

  // useOsm decides routing for THIS request. Per-request `engine` wins so a
  // legacy MapLibre fallback is still reachable while RENDER_ENGINE=osm is
  // the global default.
  const useOsm = engine === 'osm' || (engine !== 'maplibre' && RENDER_ENGINE === 'osm');

  if (!center||zoom==null) { res.status(400).json({error:'Missing required fields: center, zoom'}); return; }

  // styleJson is mandatory only on the MapLibre path. The Python/OSM pipeline
  // builds its own style from `osmTheme` + the theme JSON bundled in the
  // image, so it ignores styleJson entirely.
  if (!useOsm) {
    if (!styleJson||typeof styleJson!=='object'||Array.isArray(styleJson)) { res.status(400).json({error:'styleJson must be a non-null object'}); return; }
    const urlError = validateStyleJsonUrls(styleJson);
    if (urlError) { res.status(400).json({ error: urlError }); return; }
  }

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

  // Track client connection so we can abort an in-progress render when the
  // proxy / browser disconnects mid-flight. Without this, a Vercel proxy that
  // times out at 50 s still leaves a Python subprocess running on Railway for
  // the full render duration — pure waste on compute + Blob upload + nothing
  // delivered to the user.
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
    console.warn(`[render] Client disconnected before response — aborting${useOsm ? ' OSM render' : ' MapLibre render'}`);
    clientAbort.abort();
  };
  res.on('close', onClientClose);

  console.log(`[render] Queued — size=${renderQueue.size} pending=${renderQueue.pending} engine=${useOsm ? 'osm' : 'maplibre'}${previewMode ? ' previewMode' : ''}`);
  await renderQueue.add(async () => {
    const renderStart = Date.now();
    try {
      // If the client gave up while we were waiting in the queue, skip the
      // render entirely — no point spawning Python for output nobody will
      // receive.
      if (clientGone) {
        console.warn(`[render] Skipping queued render — client already gone`);
        return;
      }
      let png: Buffer;
      if (useOsm) {
        // Studio sends width/height as pixels already shaped for the target
        // DPI: ~96 for the live preview tile (capped at 2400 px long edge),
        // higher for the in-app print preview. Derive DPI accordingly so
        // width_in / height_in stay accurate; the Python renderer uses these
        // to size the matplotlib figure and pick line weights.
        // DPI: explicit override wins (two-stage preview uses dpi=32 for rough,
        // dpi=96 for full); falls back to the historical previewMode heuristic.
        const dpi = (Number.isFinite(dpiOverride) && dpiOverride > 0)
          ? dpiOverride
          : (previewMode ? 96 : 300);

        // Canvas sizing: preview_max_px caps the long edge so the PNG's longest
        // dimension equals exactly preview_max_px pixels (aspect ratio preserved).
        // When absent, fall through to the legacy pixel-budget cap.
        let capW = width, capH = height;
        if (typeof preview_max_px === 'number' && preview_max_px > 0) {
          const pmx   = Math.round(preview_max_px);
          const scale = pmx / Math.max(capW, capH);
          if (scale < 1) {
            capW = Math.round(capW * scale);
            capH = Math.round(capH * scale);
            console.log(`[render][osm] preview_max_px=${pmx}: ${width}×${height} → ${capW}×${capH}`);
          }
        } else {
          // Legacy pixel-budget fallback — keeps existing behaviour when studio
          // does not send preview_max_px (e.g. old clients, /fulfill path).
          const OSM_MAX_PIXELS = previewMode ? 6_000_000 : 12_000_000;
          if (capW * capH > OSM_MAX_PIXELS) {
            const k = Math.sqrt(OSM_MAX_PIXELS / (capW * capH));
            capW = Math.round(capW * k);
            capH = Math.round(capH * k);
            console.warn(`[render][osm] Pixel budget exceeded: ${width}×${height} → ${capW}×${capH} (cap ${(OSM_MAX_PIXELS/1e6).toFixed(0)} MP)`);
          }
        }
        const widthIn  = capW / dpi;
        const heightIn = capH / dpi;

        // Compensate for the Python pipeline's coverage formula:
        //   comp_dist = dist * (max(W_in, H_in) / min(W_in, H_in)) / 4
        // The studio's `osmDist` is the half-diagonal of the editor's bbox
        // (the radius that just covers what the user designed). To make
        // `comp_dist` come out equal to that radius we have to pre-divide
        // by the aspect inflation and pre-multiply by 4. Without this, a
        // 1.4-aspect portrait at osmDist=5000 ended up with comp_dist≈1750m
        // — Python fetched ~3.5 km of road graph and dropped it into a
        // 16.67"-tall figure, producing the "small cluster in a sea of
        // empty background" preview the customer was seeing.
        const userOsmDist = typeof osmDist === 'number' ? osmDist : 2000;
        const aspectRatio = Math.max(widthIn, heightIn) / Math.min(widthIn, heightIn);
        const compensatedDist = Math.round(userOsmDist * 4 / aspectRatio);
        // Python's `dist` parameter drives the matplotlib axis half-extent
        // via get_crop_limits, but the OSMnx fetch radius is
        // `comp_dist = dist * aspectRatio / 4`. After the compensation above
        // comp_dist == userOsmDist, but the axes would still span the much
        // larger `dist` value — leaving a tiny road cluster floating in
        // empty background. Override `crop_dist` so the visible area equals
        // what we actually fetched.
        // Inscribe the crop rectangle inside the fetch circle.
        // The crop rectangle has half-width = crop_dist and
        // half-height = crop_dist × figAspect (set in get_crop_limits),
        // so its half-diagonal is crop_dist × √(1 + aspectRatio²).
        // Setting crop_dist = userOsmDist / √(1 + aspectRatio²) makes
        // the half-diagonal equal the fetch radius exactly — no empty
        // facecolor wedges at the corners of portrait/landscape posters.
        // Bonus: the rectangle's full diagonal equals 2×userOsmDist, which
        // is the editor's bbox diagonal (boundsToOsmDist returns the
        // half-diagonal), so preview scale matches what the user designed.
        const cropDistOverride = Math.round(userOsmDist / Math.sqrt(1 + aspectRatio * aspectRatio));

        png = await renderOsmPython({
          city:            '',                                     // OSMnx geocodes from lat/lng
          country:         '',
          lat:             center[1],                              // MapLibre center = [lng, lat]
          lng:             center[0],
          display_city:    displayCity    ?? '',
          display_country: displayCountry ?? '',
          theme_name:      osmTheme       ?? 'midnight_blue',
          // theme_json wins over theme_name in Python: load_theme is skipped
          // when an explicit dict is passed in. Studio + Vercel proxy build
          // this from the full MapVibe palette so editor and preview agree.
          theme_json:      themeJson,
          dist:            compensatedDist,
          crop_dist:       cropDistOverride,
          width_in:        widthIn,
          height_in:       heightIn,
          dpi,
          show_text:       showPosterText !== false,
          full_bleed:      true,
          no_fade:         true,
          // Editor's Clean / Detailed pill — when true, Python skips the
          // major-road custom_filter and renders residential / service /
          // footway too. Defaults to the historical false when the studio
          // (or a non-studio caller) omits the field.
          minor_roads:     minorRoads === true,
          // preview_max_px forwarded so Python can belt-and-suspenders scale
          // the figure dimensions independently of the pixel cap above.
          ...(typeof preview_max_px === 'number' ? { preview_max_px } : {}),
        }, clientAbort.signal);
      } else {
        png = await renderPngInternal({ styleJson, center, zoom, bounds, bearing, pitch, width, height, printMode, overlay });
      }
      // Last-chance check: if the proxy disconnected between Python finishing
      // and us sending the bytes, drop the response and the PNG on the floor —
      // no upstream is listening, and the studio retry-once has already
      // started a fresh request.
      if (clientGone) {
        console.warn(`[render] Render completed but client gone — discarding ${png.length} bytes`);
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      // Don't cache previews — same URL, different inputs each time.
      if (!printMode && !useOsm) res.setHeader('Cache-Control', 'public, max-age=3600');
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
  });
});

// POST /fulfill — async Printful fulfillment
interface FulfillBody {
  externalId:       string;
  recipient:        PrintfulRecipient;
  variantId:        number;
  catalogVariantId: number;
  label:            string;
  quantity:         number;
  pngUrl?:          string;
  configUrl?:       string;
  confirm?:         boolean;   // per-request override; falls back to PRINTFUL_AUTO_CONFIRM env var
  // Optional dimension override from SKU — ensures correct 300 DPI pixel count
  // regardless of what was saved in the config snapshot. Hard rule: 300 DPI minimum.
  widthCm?:         number;
  heightCm?:        number;
  // Dedícalo — gift/dedication card message to print on Printful packing slip
  gift?:            { message: string; para?: string };
  provider?:          'printful' | 'gelato';
  gelatoProductUid?:   string;               // Gelato product UID from custom.gelato_uid
  // When present, /fulfill auto-detects provider + gelatoProductUid from Shopify variant
  // metafields (custom.pod_partner, custom.gelato_uid) — caller need not pass provider explicitly.
  // Requires SHOPIFY_ADMIN_TOKEN env var to be set on Railway.
  shopifyVariantId?:   number;               // Shopify numeric variant ID from order webhook
}


// ── Gelato fulfillment ───────────────────────────────────────────────────────

/**
 * Auto-routing: read custom.pod_partner and custom.gelato_uid metafields from
 * a Shopify variant via the Admin REST API.
 *
 * Returns resolved provider ('gelato' or 'printful') and the Gelato product UID
 * (null if not a Gelato variant or if lookup fails — caller should default to Printful).
 *
 * Requires SHOPIFY_ADMIN_TOKEN env var. If not set, always returns 'printful'.
 * On any network or API failure, logs a warning and falls back to 'printful'.
 */
// Routing type, cache, and resolveGelatoRouting extracted to ./routing.ts
// STRICT_ROUTING_LOOKUP env-gate is read via isStrictRoutingLookup() at the
// call site below so vitest can stub it without dynamic re-import.

// recipientToGelatoAddress + fulfillGelato extracted to ./gelato.ts
// notifyFulfillFail + ALERT_WEBHOOK_URL extracted to ./alerting.ts

app.post('/fulfill', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const {
    externalId, recipient, variantId, catalogVariantId, label, quantity,
    pngUrl, configUrl, confirm: confirmOverride,
    widthCm: widthCmOverride, heightCm: heightCmOverride,
    gift,
  } = req.body as FulfillBody;

  if (!externalId || !recipient || !variantId || !catalogVariantId || !label || !quantity) {
    res.status(400).json({ error: 'Missing required fields: externalId, recipient, variantId, catalogVariantId, label, quantity' });
    return;
  }
  if (!pngUrl && !configUrl) {
    res.status(400).json({ error: 'Either pngUrl or configUrl must be provided' });
    return;
  }
  const provider = ((req.body as FulfillBody).provider ?? 'printful').toLowerCase();
  if (provider !== 'printful' && provider !== 'gelato') {
    res.status(400).json({ error: `Unknown provider '${provider}'. Accepted: printful, gelato` });
    return;
  }
  if (provider === 'printful' && !PRINTFUL_KEY) {
    console.error('[fulfill] PRINTFUL_API_KEY not configured');
    res.status(500).json({ error: 'PRINTFUL_API_KEY not configured on Railway' });
    return;
  }
  if (provider === 'gelato' && !GELATO_KEY) {
    console.error('[fulfill] GELATO_API_KEY not configured');
    res.status(500).json({ error: 'GELATO_API_KEY not configured on Railway' });
    return;
  }

  // ── Pre-flight routing resolution ─────────────────────────────────────────
  // When the caller did NOT pass `provider` explicitly AND we have a Shopify
  // variant ID, look up the routing metafields SYNCHRONOUSLY so the result
  // is known before we ACK with 202. Cached per variant (10-min TTL); typical
  // call costs ~50ms on cache miss, ~0ms on hit.
  //
  // 'lookup-error' handling depends on STRICT_ROUTING_LOOKUP:
  //   - default (off)  : log at ERROR level, fall through to legacy silent
  //                      Printful default. Caller behaviour unchanged.
  //   - "true" (on)    : return 422 so the caller can retry or specify
  //                      provider explicitly. ONLY flip on once n8n + the
  //                      editor's shopify-order-webhook handle 422.
  //
  // 'no-metafield' is always treated as a legitimate Printful default (the
  // metafield genuinely isn't set for legacy variants); 'ok' uses the
  // resolved provider directly.
  const callerProvidedProvider = !!(req.body as FulfillBody).provider;
  const preflightVariantId = (req.body as FulfillBody).shopifyVariantId;
  let preflightRouting: RoutingResult | null = null;
  if (!callerProvidedProvider && preflightVariantId) {
    preflightRouting = await resolveGelatoRouting(preflightVariantId);
    if (preflightRouting.status === 'lookup-error' && isStrictRoutingLookup()) {
      console.error(`[fulfill] STRICT_ROUTING_LOOKUP=true and lookup failed for variant ${preflightVariantId} — rejecting`);
      res.status(422).json({
        error: 'POD vendor routing unavailable for this variant',
        hint:  'retry once Shopify is reachable, or pass provider explicitly (printful|gelato)',
      });
      return;
    }
    // STRICT_ROUTING_LOOKUP off + lookup-error → fall through; the loud
    // ERROR log inside resolveGelatoRouting is the only signal you get
    // until strict mode is enabled. preflightRouting remains a lookup-error
    // result, which the async block below treats as "no routing info" and
    // proceeds with the legacy Printful default.
  }

  res.status(202).json({ success: true, accepted: true, externalId });

  void (async () => {
    let finalPngUrl: string | null = pngUrl ?? null;

    if (!finalPngUrl && configUrl) {
      console.log(`[fulfill] Config path — rendering for ${externalId}`);
      // Use render queue — config renders in fulfill compete with /render for concurrency slots
      await renderQueue.add(async () => {
        const dimsOverride = (widthCmOverride && heightCmOverride)
          ? { widthCm: widthCmOverride, heightCm: heightCmOverride }
          : undefined;
        finalPngUrl = await renderConfigToBlobUrl(configUrl, dimsOverride);
      });
      if (!finalPngUrl) {
        console.error(`[fulfill] Config render FAILED for ${externalId}`);
        notifyFulfillFail(externalId, 'config-render', `renderConfigToBlobUrl returned null for ${configUrl}`);
        return;
      }
    }

    // ── Provider routing (resolved pre-flight above) ──────────────────────
    // Use preflightRouting from the synchronous block to avoid a duplicate
    // Shopify call. preflightRouting is null when the caller passed provider
    // explicitly OR no shopifyVariantId was supplied.
    let resolvedProvider = provider;
    let resolvedGelatoUid: string | null = (req.body as FulfillBody).gelatoProductUid ?? null;
    if (preflightRouting && preflightRouting.status === 'ok' && preflightRouting.provider === 'gelato') {
      resolvedProvider = 'gelato';
      if (!resolvedGelatoUid && preflightRouting.gelatoProductUid) {
        resolvedGelatoUid = preflightRouting.gelatoProductUid;
      }
    }

    // ── Gelato branch ──────────────────────────────────────────────────────
    if (resolvedProvider === 'gelato') {
      if (!resolvedGelatoUid) {
        console.error(`[fulfill/gelato] Missing gelatoProductUid for ${externalId} (not in request body and not found in Shopify metafields)`);
        notifyFulfillFail(externalId, 'missing-gelato-uid', 'No gelatoProductUid in request body or Shopify metafield');
        return;
      }
      await fulfillGelato(externalId, recipient, resolvedGelatoUid, quantity, label, finalPngUrl!);
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
    const wasUpdated = await tryUpdateExistingOrder(externalId, finalPngUrl!, variantId, quantity, label, autoConfirm, pfHeaders, gift);
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
    await resolveCatalogPlacement(variantId, pfHeaders);
  const v2Payload = {
      external_id: effectiveExternalId, shipping: 'STANDARD', recipient, confirm: autoConfirm,
      ...(giftMessage ? { packing_slip: { message: giftMessage } } : {}),
      items: [{ source: 'catalog', catalog_variant_id: variantId, quantity,
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
          items: [{ variant_id: variantId, quantity,
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


// ── OSM graph pre-warm endpoint ───────────────────────────────────────────────
// Called by the studio the moment a city is selected (fire-and-forget from the
// browser). Triggers the OSMnx graph fetch + disk-cache write without doing a
// full render, so by the time the user clicks "Preview" (~10-60 s later) the
// graph is already cached → first preview renders in ~3 s instead of 15-60 s.
app.post('/warm', (req: Request, res: Response): void => {
  if (!checkAuth(req, res)) return;
  const { lat, lon, dist = 5000 } = req.body as { lat?: number; lon?: number; dist?: number };
  if (!lat || !lon) { res.status(400).json({ error: 'lat and lon required' }); return; }
  // Respond immediately — don't block the caller
  res.json({ ok: true });
  // Background: run a 1×1 px render just to prime the OSMnx graph cache.
  // The render output is discarded; only the on-disk graph cache write matters.
  void renderOsmPython({
    lat,
    lng: lon,
    display_city: '',
    display_country: '',
    width_in: 1,
    height_in: 1,
    dpi: 10,          // 10 px — minimal matplotlib figure, negligible CPU
    dist: Math.min(Number(dist), 15_000),
    show_text: false,
    no_fade: true,
    minor_roads: false,
  }, AbortSignal.timeout(120_000)).then(
    ()  => console.log(`[warm] OSM graph cached for ${lat},${lon} dist=${dist}`),
    (e) => console.log(`[warm] OSM graph warmup ended for ${lat},${lon}: ${(e as Error).message}`),
  );
});

app.listen(PORT, () => console.log(`MapVibe Render Service v3.5.0 on port ${PORT}`));


// ── Startup city seed ──────────────────────────────────────────────────────────
// On boot, pre-warm the OSMnx graph cache for the top 300 cities (defined in
// python/top_cities.json) using the same low-DPI warm render as /warm.
// Each city fires at 2-second intervals so Overpass is never hammered.
// Cities already in the R2 / disk cache will complete in ~2s each (fast path).
// The first 50 cities warm in ~2 min; all 300 in ~10 min in the background.
interface SeedCity { city: string; country: string; lat: number; lon: number; dist?: number; }
function runStartupCitySeed(): void {
  const seedPath = join(__dirname, '..', 'python', 'top_cities.json');
  let cities: SeedCity[];
  try {
    cities = JSON.parse(readFileSync(seedPath, 'utf-8')) as SeedCity[];
  } catch (e) {
    console.warn('[seed] top_cities.json not found or invalid — skipping startup seed:', (e as Error).message);
    return;
  }
  console.log(`[seed] Startup city seed: ${cities.length} cities queued at 10s intervals, 600s timeout per city`);
  let idx = 0;
  function warmNext(): void {
    if (idx >= cities.length) {
      console.log('[seed] Startup city seed complete');
      return;
    }
    const c = cities[idx++];
    void renderOsmPython({
      lat:             c.lat,
      lng:             c.lon,
      display_city:    '',
      display_country: '',
      width_in:        1,
      height_in:       1,
      dpi:             10,
      dist:            Math.min(c.dist ?? 8000, 15_000),
      show_text:       false,
      no_fade:         true,
      minor_roads:     false,
    }, AbortSignal.timeout(600_000)).then(
      () => console.log(`[seed] ✓ ${c.city}, ${c.country} (${idx}/${cities.length})`),
      (e: Error) => console.log(`[seed] ✗ ${c.city}: ${e.message}`),
    ).finally(() => setTimeout(warmNext, 10_000));
  }
  // Delay first warm by 15s to let the service fully boot before hitting Overpass.
  setTimeout(warmNext, 15_000);
}

runStartupCitySeed();



