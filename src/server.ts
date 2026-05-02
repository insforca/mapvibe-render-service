/**
 * MapVibe Render Service — server.ts v3.0.0
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
 * Env vars (unchanged from v2.x):
 *   RENDER_API_SECRET        — required; auth for /render and /fulfill
 *   PRINTFUL_API_KEY         — Printful OAuth token
 *   PRINTFUL_STORE_ID        — Printful store ID (default: 17897492)
 *   BLOB_READ_WRITE_TOKEN    — Vercel Blob write token
 *   MAPTILER_API_KEY         — MapTiler API key (optional; used for glyph CDN)
 *   SITE_ORIGIN              — Site origin (default: https://mapvibestudio.com)
 *   VERCEL_APP_ORIGIN        — Vercel app origin for sprite absolutization
 */
import express, { Request, Response } from 'express';
import { timingSafeEqual, createHmac } from 'crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { put } from '@vercel/blob';

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
app.use(express.json({ limit: '2mb' }));

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET ?? '';

if (!API_SECRET) {
  console.error('[render] FATAL: RENDER_API_SECRET env var not set — refusing to start');
  process.exit(1);
}

// ── Printful constants ──────────────────────────────────────────────────────
const PRINTFUL_API_V2   = 'https://api.printful.com/v2';
const PRINTFUL_API_V1   = 'https://api.printful.com';
const PRINTFUL_KEY      = process.env.PRINTFUL_API_KEY      ?? '';
const PRINTFUL_STORE_ID = process.env.PRINTFUL_STORE_ID     ?? '17897492';

// ── Config-render constants ──────────────────────────────────────────────────
const MAPTILER_API_KEY  = process.env.MAPTILER_API_KEY      ?? '';
const SITE_ORIGIN       = process.env.SITE_ORIGIN           ?? 'https://mapvibestudio.com';
const VERCEL_APP_ORIGIN = process.env.VERCEL_APP_ORIGIN     ?? 'https://mapvibe-studio-alpha.vercel.app';
const PREVIEW_CANVAS_PX = parseInt(process.env.PREVIEW_CANVAS_PX ?? '600', 10) || 600;
const CM_PER_INCH       = 2.54;
const MAX_RENDER_PX_WH  = 12288;
const MAX_ZOOM_RENDER   = 17;
const MAX_CONCURRENT    = 4;
let   activeRenders     = 0;

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

// ── Tile / asset allowlist ──────────────────────────────────────────────────
const ALLOWED_TILE_HOSTS = [
  'tiles.openfreemap.org','tile.openstreetmap.org',
  'a.tile.openstreetmap.org','b.tile.openstreetmap.org','c.tile.openstreetmap.org',
  'basemaps.cartocdn.com','api.maptiler.com','maps.geoapify.com',
  'mapvibe-studio-alpha.vercel.app',
];
const PRIVATE_IP_RE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd[0-9a-f]{2}:)/i;

function isAllowedUrl(url: string): boolean {
  try {
    const { protocol, hostname, host } = new URL(url);
    if (protocol !== 'https:') return false;
    if (PRIVATE_IP_RE.test(host)) return false;
    return ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch { return false; }
}

function extractUrls(obj: unknown, urls: string[] = []): string[] {
  if (typeof obj === 'string') { urls.push(obj); return urls; }
  if (Array.isArray(obj)) { obj.forEach(v => extractUrls(v, urls)); return urls; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) extractUrls(v, urls);
  }
  return urls;
}

function validateStyleJsonUrls(styleJson: object): string | null {
  const urls = extractUrls(styleJson).filter(u => u.startsWith('http'));
  for (const url of urls) {
    try {
      const { hostname } = new URL(url);
      if (!ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
        return `Tile host not in allowlist: ${hostname}`;
      }
    } catch { return `Invalid URL in styleJson: ${url}`; }
  }
  return null;
}

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
async function ensureFont(fontFamily: string): Promise<void> {
  if (!fontFamily || registeredFonts.has(fontFamily)) return;
  mkdirSync(FONT_CACHE_DIR, { recursive: true });
  const fontPath = join(FONT_CACHE_DIR, `${fontFamily.replace(/\s+/g, '_')}.ttf`);
  try {
    let ttfBuf: Buffer | null = existsSync(fontPath) ? readFileSync(fontPath) : null;
    if (!ttfBuf) {
      // Fetch CSS from Google Fonts requesting TTF (older UA)
      const cssUrl = `https://fonts.googleapis.com/css?family=${encodeURIComponent(fontFamily)}:300,400,700`;
      const cssRes = await fetch(cssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!cssRes.ok) throw new Error(`Google Fonts CSS ${cssRes.status}`);
      const css = await cssRes.text();
      const match = css.match(/src:\s*url\((https?:\/\/[^)]+\.(?:ttf|woff))\)/i);
      if (!match) throw new Error('No TTF URL in Google Fonts CSS');
      const fontRes = await fetch(match[1], { signal: AbortSignal.timeout(15_000) });
      if (!fontRes.ok) throw new Error(`Font download ${fontRes.status}`);
      ttfBuf = Buffer.from(await fontRes.arrayBuffer());
      writeFileSync(fontPath, ttfBuf);
    }
    registerFont(fontPath, { family: fontFamily });
    registeredFonts.add(fontFamily);
    console.log(`[fonts] Registered ${fontFamily} from Google Fonts`);
  } catch (err) {
    console.warn(`[fonts] ${fontFamily} unavailable, falling back to system font:`, err);
  }
}

/** Register design-system fonts bundled in ./fonts/ at Docker build time.
 *  This eliminates the Google Fonts download dependency — fonts are always
 *  available regardless of outbound network access.
 */
function registerBundledFonts(): void {
  const FONTS_DIR = join(__dirname, '..', 'fonts');
  const bundled = [
    { file: 'PlayfairDisplay-Regular.ttf', family: 'Playfair Display' },
    { file: 'DMSans-Regular.ttf',          family: 'DM Sans' },
  ];
  for (const { file, family } of bundled) {
    const fontPath = join(FONTS_DIR, file);
    if (existsSync(fontPath) && !registeredFonts.has(family)) {
      try {
        registerFont(fontPath, { family });
        registeredFonts.add(family);
        console.log(`[fonts] Bundled font registered: ${family} from ${file}`);
      } catch (err) {
        console.warn(`[fonts] Could not register bundled font ${file}:`, err);
      }
    }
  }
}

// Register bundled design fonts first (no network required)
registerBundledFonts();
// Register available system fonts as fallbacks
registerSystemFonts();

// ── Compositing constants (match COMPOSITING_JS header in v2.x) ─────────────
const _DR = 2400, _AB = 20.4,  _EM = .012, _CB = 204,  _CM = 96;
const _CS  = .06,  _CTB = 67.2, _CTS = .03, _COB = 52.8, _COS = .015;

// ── Compositing functions — Canvas 2D API; identical logic to v2.x ──────────
function _wa(hex: any, a: any){var h=(hex||'#000').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';}
function _ph(hex: any){var h=(hex||'#808080').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return{r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0};}
function _dr(ctx: any, rx: any, ry: any, w: any, h: any, i?: any){i=i||4;var rw=Math.round(w),rh=Math.round(h);if(rw<=0||rh<=0)return;var t=ctx.getTransform(),ax=Math.round(rx+t.e),ay=Math.round(ry+t.f),id=ctx.getImageData(ax,ay,rw,rh),d=id.data,B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];for(var py=0;py<rh;py++){var rb=py*rw,br=(py&3)*4;for(var px=0;px<rw;px++){var ii=(rb+px)*4,dv=Math.round(((B[br+(px&3)]/15)-0.5)*2*i);d[ii]=Math.max(0,Math.min(255,d[ii]+dv));d[ii+1]=Math.max(0,Math.min(255,d[ii+1]+dv));d[ii+2]=Math.max(0,Math.min(255,d[ii+2]+dv));}}ctx.putImageData(id,ax,ay);}
function applyFades(ctx: any, W: any, H: any, color: any, fs: any){if(fs==='none')return;var tH=Math.round(H*0.25),tg=ctx.createLinearGradient(0,0,0,tH);tg.addColorStop(0,_wa(color,1));tg.addColorStop(.4,_wa(color,.45));tg.addColorStop(.7,_wa(color,.12));tg.addColorStop(1,_wa(color,0));ctx.fillStyle=tg;ctx.fillRect(0,0,W,tH);_dr(ctx,0,0,W,tH);if(fs==='text'){var fH=Math.round(H*.125),gH=Math.round(H*.10),fT=H-fH-gH,fg=ctx.createLinearGradient(0,fT,0,fT+gH);fg.addColorStop(0,_wa(color,0));fg.addColorStop(.18,_wa(color,.04));fg.addColorStop(.34,_wa(color,.14));fg.addColorStop(.5,_wa(color,.34));fg.addColorStop(.65,_wa(color,.6));fg.addColorStop(.8,_wa(color,.84));fg.addColorStop(.92,_wa(color,.97));fg.addColorStop(1,color);ctx.fillStyle=fg;ctx.fillRect(0,fT,W,gH);ctx.fillStyle=color;ctx.fillRect(0,H-fH,W,fH);_dr(ctx,0,fT,W,gH+fH);}else{var bH=Math.round(H*.25),bY=H-bH,bg=ctx.createLinearGradient(0,H,0,bY);bg.addColorStop(0,_wa(color,1));bg.addColorStop(.4,_wa(color,.45));bg.addColorStop(.7,_wa(color,.12));bg.addColorStop(1,_wa(color,0));ctx.fillStyle=bg;ctx.fillRect(0,bY,W,bH);_dr(ctx,0,bY,W,bH);}}
function fmtCoords(lat: any, lon: any){return Math.abs(lat).toFixed(4)+'\u00b0 '+(lat>=0?'N':'S')+' / '+Math.abs(lon).toFixed(4)+'\u00b0 '+(lon>=0?'E':'W');}
function fmtCity(c: any){if(!c)return'';var lc=0,ac=0;for(var i=0;i<c.length;i++){var ch=c[i];if(/[A-Za-z\u00C0-\u024F]/.test(ch)){lc++;ac++;}else if(/\p{L}/u.test(ch)){ac++;}}return(ac===0||lc/ac>.8)?c.toUpperCase():c;}
function shrinkFont(base: any, min: any, len: any, sp: any){len=Math.max(len,1);var s=base;if(len>10)s=Math.max(min,base*(10/len));var wE=len*.62+(len-1)*sp,mW=_DR*.92;if(wE*s>mW)s=Math.max(min,mW/wE);return s;}
function textMetrics(w: any, h: any, layout: any){if(layout==='editorial'){var x=w*.06;return{cX:x,cY:h*.82,dX:x,dY:h*.855,coX:x,coY:h*.885,crX:x,crY:h*.92,al:'left',dW:120};}var cx=w*.5;return{cX:cx,cY:h*.885,dX:cx,dY:h*.905,coX:cx,coY:h*.925,crX:cx,crY:h*.945,al:'center',dW:w*.2};}
function drawSpaced(ctx: any, text: any, x: any, y: any, sp: any, fs: any, al: any){if(sp===0){ctx.fillText(text,x,y);return;}var s=sp*fs,tot=ctx.measureText(text).width+s*(text.length-1),sx=al==='center'?x-tot/2:al==='right'?x-tot:x,sa=ctx.textAlign;ctx.textAlign='left';var cx=sx;for(var i=0;i<text.length;i++){var ch=text[i];ctx.fillText(ch,cx,y);cx+=ctx.measureText(ch).width+s;}ctx.textAlign=sa;}
function drawPosterText(ctx: any, W: any, H: any, theme: any, lat: any, lon: any, city: any, country: any, ff: any, showText: any, credits: any, layout: any){var land=(theme&&theme.map&&theme.map.land)||'#808080',rgb=_ph(land),luma=(.2126*rgb.r+.7152*rgb.g+.0722*rgb.b)/255;var tc=(theme&&theme.ui&&theme.ui.text)||(luma<.5?'#FFFFFF':'#111111'),ac=luma<.52?'#f5faff':'#0e1822';var tFF=ff?'"'+ff+'","Playfair Display",serif':'"Playfair Display",serif';var bFF=ff?'"'+ff+'","DM Sans",sans-serif':'"DM Sans",sans-serif';var ds=Math.max(.45,Math.min(W,H)/_DR),afs=_AB*ds;if(showText){var m=textMetrics(W,H,layout||'centered'),cl=fmtCity(city||''),cfs=shrinkFont(_CB*ds,_CM*ds,(city||'').length,_CS),ctFS=_CTB*ds,coFS=_COB*ds;ctx.fillStyle=tc;ctx.textAlign=m.al;ctx.textBaseline='middle';ctx.font='700 '+cfs+'px '+tFF;drawSpaced(ctx,cl,m.cX,m.cY,_CS,cfs,m.al);ctx.strokeStyle=tc;ctx.lineWidth=3*ds;ctx.beginPath();if(m.al==='center'){ctx.moveTo(m.dX-m.dW/2,m.dY);ctx.lineTo(m.dX+m.dW/2,m.dY);}else{ctx.moveTo(m.dX,m.dY);ctx.lineTo(m.dX+m.dW,m.dY);}ctx.stroke();ctx.font='300 '+ctFS+'px '+tFF;drawSpaced(ctx,(country||'').toUpperCase(),m.coX,m.coY,_CTS,ctFS,m.al);ctx.globalAlpha=.75;ctx.font='400 '+coFS+'px '+bFF;drawSpaced(ctx,fmtCoords(lat,lon),m.crX,m.crY,_COS,coFS,m.al);ctx.globalAlpha=1;}ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='right';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('\u00a9 OpenStreetMap contributors',W*(1-_EM),H*(1-_EM));ctx.globalAlpha=1;if(credits){ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='left';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('created with mapvibestudio.com',W*_EM,H*(1-_EM));ctx.globalAlpha=1;}}

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
}

/**
 * Render a MapLibre GL style to PNG using the native renderer.
 * Replaces the Playwright/SwiftShader browser pipeline from v2.x.
 * Works at any zoom level; no browser or WebGL limitations.
 */
async function renderPngInternal(params: RenderParams): Promise<Buffer> {
  const { styleJson, center, zoom, bearing = 0, pitch = 0, overlay } = params;
  const [lng, lat] = center;

  // Clamp output dimensions
  let w = Math.max(100, Math.min(Math.floor(Number(params.width  ?? 2400)), MAX_RENDER_PX_WH));
  let h = Math.max(100, Math.min(Math.floor(Number(params.height ?? 2400)), MAX_RENDER_PX_WH));
  const MAX_PX = 80_000_000;
  const ps = Math.sqrt(MAX_PX / (w * h));
  if (ps < 1) { w = Math.floor(w * ps); h = Math.floor(h * ps); }

  // Device scale (pixelRatio) — keeps geographic area identical to v2.x browser render
  const DEVICE_SCALE = params.printMode ? 3 : 2;
  const vpW = Math.ceil(w / DEVICE_SCALE);
  const vpH = Math.ceil(h / DEVICE_SCALE);

  // Ensure design-system fonts are always loaded from Google Fonts
  await Promise.all([ensureFont('Playfair Display'), ensureFont('DM Sans')]);
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

    rawRgba = await new Promise<Buffer>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Native render timeout (55s)')), 55_000);
      map.render(
        { zoom, center: [lng, lat], width: vpW, height: vpH, bearing, pitch },
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

  // rawRgba is DEVICE_SCALE-upscaled: vpW*DEVICE_SCALE × vpH*DEVICE_SCALE = w × h
  // Composite onto node-canvas with identical logic to v2.x browser compositing
  const bgColor = (overlay?.theme as any)?.ui?.bg ?? '#f5f5f0';
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d') as any;

  // 1. Fill background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // 2. Draw rendered map (RGBA buffer → ImageData)
  const imageData = ctx.createImageData(w, h);
  imageData.data.set(rawRgba.slice(0, w * h * 4));
  ctx.putImageData(imageData, 0, 0);

  // 3. Fades + poster text
  if (overlay) {
    const fc = (overlay.theme as any)?.ui?.bg || bgColor;
    applyFades(ctx, w, h, fc, overlay.fadeStyle || 'default');
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

  const pngBuf = cv.toBuffer('image/png');
  console.log(`[render] Native render done in ${Math.round((Date.now()-renderStart)/1000)}s — ${w}x${h}px`);
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

const PRINTFUL_TERMINAL_STATUSES = new Set(['canceled', 'cancelled', 'archived', 'failed']);

interface PrintfulOrderMatch {
  id: string;
  status: string;
  isTerminal: boolean;
}

async function findExistingPrintfulOrder(externalId: string): Promise<PrintfulOrderMatch | null> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${PRINTFUL_KEY}`,
      'Content-Type': 'application/json',
    };
    if (PRINTFUL_STORE_ID) headers['X-PF-Store-Id'] = PRINTFUL_STORE_ID;
    const res = await fetch(
      `${PRINTFUL_API_V1}/orders?external_id=${encodeURIComponent(externalId)}`,
      { headers },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const orders: Array<{ id: number; external_id: string | null; status: string }> = data?.data ?? data?.result ?? [];
    const match = orders.find(o => o.external_id === externalId);
    if (!match) return null;
    const status = (match.status ?? '').toLowerCase();
    return { id: String(match.id), status, isTerminal: PRINTFUL_TERMINAL_STATUSES.has(status) };
  } catch {
    return null;
  }
}

/** Resolve a stable externalId for Printful order creation.
 *  If the candidate ID has an existing ACTIVE order → return null (skip creation).
 *  If the candidate ID has a TERMINAL (cancelled/archived) order → auto-append -rN suffix.
 *  Returns the externalId to use, or null if an active order already exists.
 */
async function resolveExternalId(baseId: string): Promise<string | null> {
  let candidate = baseId;
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await findExistingPrintfulOrder(candidate);
    if (!existing) return candidate;                          // no order → use this ID
    if (!existing.isTerminal) {
      console.log(`[fulfill] Active Printful order ${existing.id} (${existing.status}) already exists for ${candidate} — skipping`);
      return null;                                            // active order → skip
    }
    // Terminal order (cancelled/archived) → try next suffix
    console.log(`[fulfill] Terminal order ${existing.id} (${existing.status}) for ${candidate} — trying next suffix`);
    const suffix = `-r${attempt + 2}`;
    candidate = (baseId + suffix).slice(0, 32);
  }
  console.error(`[fulfill] Could not find a free externalId after 10 attempts for base ${baseId}`);
  return null;
}

// ── MapvibeConfigSnapshot type ───────────────────────────────────────────────
interface MapvibeConfigSnapshot {
  styleJson:      unknown;
  center:         [number, number];
  zoom:           number;
  bearing?:       number;
  pitch?:         number;
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
}

/**
 * Download config snapshot, render PNG at 300 DPI, upload to Vercel Blob.
 * 300 DPI hard-enforced — never lower.
 */
async function renderConfigToBlobUrl(configUrl: string): Promise<string | null> {
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

  // 2. Compute pixel dims at 300 DPI — HARD RULE: never under 300 DPI
  const DPI     = 300;
  const widthCm  = Number(cfg.widthCm)  || 40.64;
  const heightCm = Number(cfg.heightCm) || 50.80;
  const width    = Math.min(Math.round((widthCm  / CM_PER_INCH) * DPI), MAX_RENDER_PX_WH);
  const height   = Math.min(Math.round((heightCm / CM_PER_INCH) * DPI), MAX_RENDER_PX_WH);
  console.log(`[fulfill] Config render: ${widthCm}x${heightCm}cm → ${width}x${height}px @ ${DPI} DPI`);

  // 3. Patch style: inject tile/glyph sources, absolutize relative URLs
  let styleJson: Record<string, unknown>;
  try {
    styleJson = JSON.parse(JSON.stringify(cfg.styleJson)) as Record<string, unknown>;
    const sources = styleJson.sources as Record<string, Record<string, unknown>> | undefined;
    if (sources) {
      for (const src of Object.values(sources)) {
        if (typeof src?.url === 'string') {
          const needsPatch = src.url.includes('openfreemap.org') || src.url.startsWith('/');
          if (needsPatch) {
            src.url = `https://tiles.openfreemap.org/planet`;
          }
        }
      }
    }
    if (typeof styleJson.glyphs === 'string' && styleJson.glyphs.startsWith('/'))
      styleJson.glyphs = MAPTILER_API_KEY
        ? `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${MAPTILER_API_KEY}`
        : `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`;
    if (typeof styleJson.sprite === 'string' && styleJson.sprite.startsWith('/'))
      styleJson.sprite = VERCEL_APP_ORIGIN + styleJson.sprite;
  } catch {
    styleJson = cfg.styleJson as Record<string, unknown>;
  }

  // 4. Use the user's design zoom directly (no boost).
  // Print render must show the SAME geographic area as the user designed.
  // Zoom-boosting changes the geographic extent, causes tile timeouts at z17,
  // and produces blank renders. The higher pixel count (4800×6000) gives
  // print-quality output at the user's chosen zoom without changing the view.
  const userZoom   = typeof cfg.zoom === 'number' && isFinite(cfg.zoom) ? cfg.zoom : 0;
  const renderZoom = Math.min(MAX_ZOOM_RENDER, userZoom);

  // 5. Render via native pipeline
  let pngBuffer: Buffer;
  try {
    pngBuffer = await renderPngInternal({
      styleJson,
      center:         cfg.center,
      zoom:           renderZoom,
      bearing:        cfg.bearing        ?? 0,
      pitch:          cfg.pitch          ?? 0,
      width,
      height,
      printMode:      true,
      overlay: {
        displayCity:    cfg.displayCity    ?? '',
        displayCountry: cfg.displayCountry ?? '',
        fontFamily:     cfg.fontFamily     ?? '',
        showPosterText: cfg.showPosterText !== false,
        fadeStyle:      cfg.fadeStyle      ?? 'default',
        includeCredits: cfg.includeCredits !== false,
        textLayout:     cfg.textLayout     ?? 'centered',
        theme:          cfg.theme          ?? {},
      },
    });
  } catch (err) {
    console.error('[fulfill] Render error:', err);
    return null;
  }

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
    });
    console.log(`[fulfill] PNG uploaded: ${blob.url} (${width}x${height}px)`);
    return blob.url;
  } catch (err) {
    console.error('[fulfill] Blob upload failed:', err);
    return null;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────


app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', version: '3.0.0' }));

// POST /render — synchronous render, returns PNG
app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;
  if (activeRenders >= MAX_CONCURRENT) {
    res.status(503).json({ error: 'Render service busy — try again shortly', activeRenders });
    return;
  }

  const {
    styleJson, center, zoom, width=2400, height=2400, bearing=0, pitch=0, printMode=false,
    displayCity, displayCountry, fontFamily, showPosterText, fadeStyle, includeCredits, textLayout, theme,
  } = req.body;

  if (!styleJson||typeof styleJson!=='object'||Array.isArray(styleJson)) { res.status(400).json({error:'styleJson must be a non-null object'}); return; }
  if (!center||zoom==null) { res.status(400).json({error:'Missing required fields: center, zoom'}); return; }

  const urlError = validateStyleJsonUrls(styleJson);
  if (urlError) { res.status(400).json({ error: urlError }); return; }

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

  activeRenders++;
  const renderStart = Date.now();
  try {
    const png = await renderPngInternal({ styleJson, center, zoom, bearing, pitch, width, height, printMode, overlay });
    res.setHeader('Content-Type', 'image/png');
    if (!printMode) res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(png);
  } catch (err: any) {
    const elapsed = Math.round((Date.now()-renderStart)/1000);
    console.error(`[render] Error after ${elapsed}s:`, err.message || err);
    res.status(500).json({ error: err.message || 'Render failed', elapsed });
  } finally {
    activeRenders--;
  }
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
  confirm?:         boolean;  // per-request override; falls back to PRINTFUL_AUTO_CONFIRM env var
}

app.post('/fulfill', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const { externalId, recipient, variantId, catalogVariantId, label, quantity, pngUrl, configUrl, confirm: confirmOverride } = req.body as FulfillBody;

  if (!externalId || !recipient || !variantId || !catalogVariantId || !label || !quantity) {
    res.status(400).json({ error: 'Missing required fields: externalId, recipient, variantId, catalogVariantId, label, quantity' });
    return;
  }
  if (!pngUrl && !configUrl) {
    res.status(400).json({ error: 'Either pngUrl or configUrl must be provided' });
    return;
  }
  if (!PRINTFUL_KEY) {
    console.error('[fulfill] PRINTFUL_API_KEY not configured');
    res.status(500).json({ error: 'PRINTFUL_API_KEY not configured on Railway' });
    return;
  }

  res.status(202).json({ success: true, accepted: true, externalId });

  void (async () => {
    let finalPngUrl: string | null = pngUrl ?? null;

    if (!finalPngUrl && configUrl) {
      console.log(`[fulfill] Config path — rendering for ${externalId}`);
      activeRenders++;
      try {
        finalPngUrl = await renderConfigToBlobUrl(configUrl);
      } finally {
        activeRenders--;
      }
      if (!finalPngUrl) {
        console.error(`[fulfill] Config render FAILED for ${externalId}`);
        return;
      }
    }

    const resolvedId = await resolveExternalId(externalId);
    if (!resolvedId) return;  // active order exists — skip
    const effectiveExternalId = resolvedId;

    const autoConfirm = confirmOverride !== undefined ? confirmOverride : process.env.PRINTFUL_AUTO_CONFIRM === 'true';
  const v2Payload = {
      external_id: effectiveExternalId, shipping: 'STANDARD', recipient, confirm: autoConfirm,
      items: [{ source: 'catalog', catalog_variant_id: catalogVariantId, quantity,
                name: `MapVibe — ${label}`, files: [{ type: 'default', url: finalPngUrl }] }],
    };
    const pfHeaders: Record<string, string> = {
      Authorization: `Bearer ${PRINTFUL_KEY}`, 'Content-Type': 'application/json',
    };
    if (PRINTFUL_STORE_ID) pfHeaders['X-PF-Store-Id'] = PRINTFUL_STORE_ID;

    try {
      let pfRes = await fetch(`${PRINTFUL_API_V2}/orders`, { method: 'POST', headers: pfHeaders, body: JSON.stringify(v2Payload) });
      let pfData: any = await pfRes.json();
      let apiVersion = 'v2';

      if (!pfRes.ok) {
        console.warn(`[fulfill] v2 failed for ${externalId} — trying v1 fallback`);
        const v1Payload = {
          external_id: effectiveExternalId, shipping: 'STANDARD', recipient, confirm: autoConfirm,
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
    } catch (err: any) {
      console.error(`[fulfill] Uncaught error for ${externalId}:`, err);
    }
  })();
});

app.listen(PORT, () => console.log(`MapVibe Render Service v3.0.0 on port ${PORT}`));
