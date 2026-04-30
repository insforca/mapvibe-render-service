/**
 * MapVibe Render Service — server.ts v2.3
 *
 * v2.3 changes:
 * - Extracted renderPngInternal() — shared browser render function used by /render and /fulfill
 * - Added POST /fulfill — receives fulfillment job from Vercel dispatcher,
 *   renders PNG (from configUrl or uses provided pngUrl), uploads to Vercel Blob,
 *   creates Printful order (v2 + v1 fallback + race-dedup handler), returns result.
 * - Railway now owns 100% of Printful logic; Vercel webhook is a pure dispatcher.
 *
 * New env vars required (add to Railway):
 *   PRINTFUL_API_KEY       — Printful OAuth token
 *   PRINTFUL_STORE_ID      — Printful store ID (default: 17897492)
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob write token (for PNG upload in fulfill path)
 *   MAPTILER_API_KEY       — MapTiler API key (for tile source patching in configUrl path)
 *   SITE_ORIGIN            — Site origin for absolutizing relative glyphs/sprites URLs
 *                            (default: https://mapvibestudio.com)
 */
import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext } from 'playwright';
import { timingSafeEqual, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolve4, resolve6 } from 'dns/promises';
import { put } from '@vercel/blob';

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

// ── Config-render constants (used by /fulfill configUrl path) ───────────────
const MAPTILER_API_KEY  = process.env.MAPTILER_API_KEY      ?? '';
const SITE_ORIGIN       = process.env.SITE_ORIGIN           ?? 'https://mapvibestudio.com';
const PREVIEW_CANVAS_PX = parseInt(process.env.PREVIEW_CANVAS_PX ?? '600', 10) || 600;
const CM_PER_INCH       = 2.54;
const MAX_RENDER_PX_WH  = 12288; // 24x36 at 300 DPI = 9000×10800 px — well within cap
const MAX_ZOOM_RENDER   = 17;

// HMAC-normalised timing-safe compare — fixes length-leak timing oracle (H3)
const COMPARE_KEY = Buffer.from('mapvibe-cte-v1');
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(Buffer.from(a)).digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(Buffer.from(b)).digest();
  return timingSafeEqual(ha, hb); // always 32 vs 32 — never throws
}

function checkAuth(req: Request, res: Response): boolean {
  const raw   = req.headers['x-api-key'] ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw[0] : '');
  const ok = constantTimeEqual(token, API_SECRET);
  if (!ok) res.status(401).json({ error: 'Unauthorized' });
  return ok;
}

function htmlSafeJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g,  '\u003c')
    .replace(/>/g,  '\u003e')
    .replace(/&/g,  '\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const ALLOWED_TILE_HOSTS = [
  'tiles.openfreemap.org','tile.openstreetmap.org',
  'a.tile.openstreetmap.org','b.tile.openstreetmap.org','c.tile.openstreetmap.org',
  'basemaps.cartocdn.com','api.maptiler.com','maps.geoapify.com',
  'mapvibestudio.com', // glyphs and sprites served from studio CDN
];

// CDN hosts allowed for script/stylesheet/font resource types only (C2/H4 fix)
const ALLOWED_ASSET_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Private/loopback IP ranges — blocks SSRF redirect chain targets
const PRIVATE_IP_RE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd[0-9a-f]{2}:)/i;

// DNS result cache — avoids 50–100 redundant lookups per render (same host repeated)
const _dnsCache = new Map<string, { isPrivate: boolean; expires: number }>();
const DNS_TTL_MS = 5 * 60 * 1000; // 5 min

async function isPrivateHost(hostname: string): Promise<boolean> {
  const now = Date.now();
  const cached = _dnsCache.get(hostname);
  if (cached && cached.expires > now) return cached.isPrivate;
  try {
    const [a4, a6] = await Promise.all([
      resolve4(hostname).catch(() => [] as string[]),
      resolve6(hostname).catch(() => [] as string[]),
    ]);
    const isPrivate = [...a4, ...a6].some(ip => PRIVATE_IP_RE.test(ip));
    _dnsCache.set(hostname, { isPrivate, expires: now + DNS_TTL_MS });
    return isPrivate;
  } catch {
    _dnsCache.set(hostname, { isPrivate: true, expires: now + DNS_TTL_MS });
    return true; // unresolvable → fail closed
  }
}

function extractUrls(obj: unknown, urls: string[] = []): string[] {
  if (typeof obj === 'string') { urls.push(obj); return urls; }
  if (Array.isArray(obj)) { obj.forEach(v => extractUrls(v, urls)); return urls; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) extractUrls(v, urls);
  }
  return urls;
}

function validateStyleJsonUrls(styleJson: object): string | null {
  for (const url of extractUrls(styleJson)) {
    if (!url.startsWith('http')) continue;
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'https:') return `Non-HTTPS URL rejected: ${url}`;
      const allowed = ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
      if (!allowed) return `Tile host not in allowlist: ${hostname}`;
    } catch { return `Malformed URL in styleJson: ${url}`; }
  }
  return null;
}

// v2.2: raised 1 → 2 to prevent cascade 503s when two users render simultaneously.
let activeRenders = 0;
const MAX_CONCURRENT = 2;

let MAPLIBRE_SCRIPT = '';
try {
  const js = readFileSync(join(__dirname, '..', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.js'), 'utf8');
  MAPLIBRE_SCRIPT = `<script>${js}</script>`;
  console.log(`[render] maplibre-gl.js loaded (${(js.length/1024).toFixed(0)} KB)`);
} catch {
  MAPLIBRE_SCRIPT = `<script src="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.js"></script>`;
  console.warn('[render] maplibre-gl.js not in node_modules — fallback to CDN');
}

let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist'],
    });
  }
  return browser;
}

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', version: '2.3.0', activeRenders }));

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

// ── Minified canvas compositing helpers (unchanged from v2.2) ──────────────
function _wa(hex,a){var h=(hex||'#000').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';}
function _ph(hex){var h=(hex||'#808080').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return{r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0};}
function _dr(ctx,rx,ry,w,h,i){i=i||4;var rw=Math.round(w),rh=Math.round(h);if(rw<=0||rh<=0)return;var t=ctx.getTransform(),ax=Math.round(rx+t.e),ay=Math.round(ry+t.f),id=ctx.getImageData(ax,ay,rw,rh),d=id.data,B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];for(var py=0;py<rh;py++){var rb=py*rw,br=(py&3)*4;for(var px=0;px<rw;px++){var ii=(rb+px)*4,dv=Math.round(((B[br+(px&3)]/15)-0.5)*2*i);d[ii]=Math.max(0,Math.min(255,d[ii]+dv));d[ii+1]=Math.max(0,Math.min(255,d[ii+1]+dv));d[ii+2]=Math.max(0,Math.min(255,d[ii+2]+dv));}}ctx.putImageData(id,ax,ay);}
function applyFades(ctx,W,H,color,fs){if(fs==='none')return;var tH=Math.round(H*0.25),tg=ctx.createLinearGradient(0,0,0,tH);tg.addColorStop(0,_wa(color,1));tg.addColorStop(.4,_wa(color,.45));tg.addColorStop(.7,_wa(color,.12));tg.addColorStop(1,_wa(color,0));ctx.fillStyle=tg;ctx.fillRect(0,0,W,tH);_dr(ctx,0,0,W,tH);if(fs==='text'){var fH=Math.round(H*.125),gH=Math.round(H*.10),fT=H-fH-gH,fg=ctx.createLinearGradient(0,fT,0,fT+gH);fg.addColorStop(0,_wa(color,0));fg.addColorStop(.18,_wa(color,.04));fg.addColorStop(.34,_wa(color,.14));fg.addColorStop(.5,_wa(color,.34));fg.addColorStop(.65,_wa(color,.6));fg.addColorStop(.8,_wa(color,.84));fg.addColorStop(.92,_wa(color,.97));fg.addColorStop(1,color);ctx.fillStyle=fg;ctx.fillRect(0,fT,W,gH);ctx.fillStyle=color;ctx.fillRect(0,H-fH,W,fH);_dr(ctx,0,fT,W,gH+fH);}else{var bH=Math.round(H*.25),bY=H-bH,bg=ctx.createLinearGradient(0,H,0,bY);bg.addColorStop(0,_wa(color,1));bg.addColorStop(.4,_wa(color,.45));bg.addColorStop(.7,_wa(color,.12));bg.addColorStop(1,_wa(color,0));ctx.fillStyle=bg;ctx.fillRect(0,bY,W,bH);_dr(ctx,0,bY,W,bH);}}

function fmtCoords(lat,lon){return Math.abs(lat).toFixed(4)+'\u00b0 '+(lat>=0?'N':'S')+' / '+Math.abs(lon).toFixed(4)+'\u00b0 '+(lon>=0?'E':'W');}
function fmtCity(c){if(!c)return'';var lc=0,ac=0;for(var i=0;i<c.length;i++){var ch=c[i];if(/[A-Za-z\u00C0-\u024F]/.test(ch)){lc++;ac++;}else if(/\p{L}/u.test(ch)){ac++;}}return(ac===0||lc/ac>.8)?c.toUpperCase():c;}
function shrinkFont(base,min,len,sp){len=Math.max(len,1);var s=base;if(len>10)s=Math.max(min,base*(10/len));var wE=len*.62+(len-1)*sp,mW=_DR*.92;if(wE*s>mW)s=Math.max(min,mW/wE);return s;}
function textMetrics(w,h,layout){if(layout==='editorial'){var x=w*.06;return{cX:x,cY:h*.82,dX:x,dY:h*.855,coX:x,coY:h*.885,crX:x,crY:h*.92,al:'left',dW:120};}var cx=w*.5;return{cX:cx,cY:h*.885,dX:cx,dY:h*.905,coX:cx,coY:h*.925,crX:cx,crY:h*.945,al:'center',dW:w*.2};}
function drawSpaced(ctx,text,x,y,sp,fs,al){if(sp===0){ctx.fillText(text,x,y);return;}var s=sp*fs,tot=ctx.measureText(text).width+s*(text.length-1),sx=al==='center'?x-tot/2:al==='right'?x-tot:x,sa=ctx.textAlign;ctx.textAlign='left';var cx=sx;for(var i=0;i<text.length;i++){var ch=text[i];ctx.fillText(ch,cx,y);cx+=ctx.measureText(ch).width+s;}ctx.textAlign=sa;}
function drawPosterText(ctx,W,H,theme,lat,lon,city,country,ff,showText,credits,layout){var land=(theme&&theme.map&&theme.map.land)||'#808080',rgb=_ph(land),luma=(.2126*rgb.r+.7152*rgb.g+.0722*rgb.b)/255;var tc=(theme&&theme.ui&&theme.ui.text)||(luma<.5?'#FFFFFF':'#111111'),ac=luma<.52?'#f5faff':'#0e1822';var tFF=ff?'"'+ff+'","Space Grotesk",sans-serif':'"Space Grotesk",sans-serif';var bFF=ff?'"'+ff+'","IBM Plex Mono",monospace':'"IBM Plex Mono",monospace';var ds=Math.max(.45,Math.min(W,H)/_DR),afs=_AB*ds;if(showText){var m=textMetrics(W,H,layout||'centered'),cl=fmtCity(city||''),cfs=shrinkFont(_CB*ds,_CM*ds,(city||'').length,_CS),ctFS=_CTB*ds,coFS=_COB*ds;ctx.fillStyle=tc;ctx.textAlign=m.al;ctx.textBaseline='middle';ctx.font='700 '+cfs+'px '+tFF;drawSpaced(ctx,cl,m.cX,m.cY,_CS,cfs,m.al);ctx.strokeStyle=tc;ctx.lineWidth=3*ds;ctx.beginPath();if(m.al==='center'){ctx.moveTo(m.dX-m.dW/2,m.dY);ctx.lineTo(m.dX+m.dW/2,m.dY);}else{ctx.moveTo(m.dX,m.dY);ctx.lineTo(m.dX+m.dW,m.dY);}ctx.stroke();ctx.font='300 '+ctFS+'px '+tFF;drawSpaced(ctx,(country||'').toUpperCase(),m.coX,m.coY,_CTS,ctFS,m.al);ctx.globalAlpha=.75;ctx.font='400 '+coFS+'px '+bFF;drawSpaced(ctx,fmtCoords(lat,lon),m.crX,m.crY,_COS,coFS,m.al);ctx.globalAlpha=1;}ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='right';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('\u00a9 OpenStreetMap contributors',W*(1-_EM),H*(1-_EM));ctx.globalAlpha=1;if(credits){ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='left';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('created with mapvibestudio.com',W*_EM,H*(1-_EM));ctx.globalAlpha=1;}}

function buildRenderHtml(
  styleJson: object, lng: number, lat: number, zoom: number, bearing: number, pitch: number,
  overlay?: OverlayParams,
): string {
  const overlayJson = overlay ? JSON.stringify(overlay) : 'null';
  const bgColor = (overlay?.theme as any)?.ui?.bg ?? '#f5f5f0';
  const fontTag = overlay?.fontFamily
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(overlay.fontFamily)}:wght@300;400;700&display=swap" rel="stylesheet">`
    : '';
  const COMPOSITING_JS = `var _DR=2400,_AB=.0085,_EM=.012,_CB=.085,_CM=.04,_CS=.06,_CTB=.028,_CTS=.03,_COB=.022,_COS=.015;${_wa.toString()}${_ph.toString()}${_dr.toString()}${applyFades.toString()}${fmtCoords.toString()}${fmtCity.toString()}${shrinkFont.toString()}${textMetrics.toString()}${drawSpaced.toString()}${drawPosterText.toString()}`;
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8" />\n<style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:100%;height:100%;overflow:hidden;}#map{width:100%;height:100%;}#composite{display:none;position:absolute;top:0;left:0;width:100%;height:100%;}</style>\n${fontTag}\n<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.css"/>\n${MAPLIBRE_SCRIPT}\n</head><body>\n<div id="map"></div><canvas id="composite"></canvas>\n<script>\n${COMPOSITING_JS}\nwindow.__mapIdle=false;window.__mapIdleTime=0;window.__compositeReady=false;window.__tileCount=0;\nvar __ov=${overlayJson};\nconst map=new maplibregl.Map({container:'map',style:${htmlSafeJson(styleJson)},center:[${lng},${lat}],zoom:${zoom},bearing:${bearing},pitch:${pitch},interactive:false,attributionControl:false,fadeDuration:0,preserveDrawingBuffer:true,canvasContextAttributes:{antialias:true}});\nmap.on('render',()=>{window.__mapIdle=false;});\nmap.on('idle',()=>{window.__mapIdle=true;window.__mapIdleTime=Date.now();});\nmap.on('data',(e)=>{if(e.dataType==='tile')window.__tileCount++;});\nwindow.__runComposite=async function(){\n  if(document.fonts&&document.fonts.ready)await document.fonts.ready;\n  var mc=map.getCanvas(),w=mc.width,h=mc.height;\n  var cv=document.getElementById('composite');cv.width=w;cv.height=h;\n  var ctx=cv.getContext('2d',{colorSpace:'srgb'});\n  ctx.fillStyle=${JSON.stringify(bgColor)};ctx.fillRect(0,0,w,h);\n  ctx.drawImage(mc,0,0);\n  if(__ov){var fc=(__ov.theme&&__ov.theme.ui&&__ov.theme.ui.bg)||${JSON.stringify(bgColor)};applyFades(ctx,w,h,fc,__ov.fadeStyle||'default');drawPosterText(ctx,w,h,__ov.theme||{},${lat},${lng},__ov.displayCity||'',__ov.displayCountry||'',__ov.fontFamily||'',__ov.showPosterText!==false,__ov.includeCredits!==false,__ov.textLayout||'centered');}\n  document.getElementById('map').style.display='none';cv.style.display='block';\n  window.__compositeReady=true;\n};\n</script></body></html>`;
}

// ── Core browser render — shared by /render and /fulfill ───────────────────
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

async function renderPngInternal(params: RenderParams): Promise<Buffer> {
  const {
    styleJson, center, zoom,
    bearing = 0, pitch = 0,
    printMode = false, overlay,
  } = params;

  const [lng, lat] = center;
  let w = Math.max(100, Math.min(Math.floor(Number(params.width  ?? 2400)), 12288));
  let h = Math.max(100, Math.min(Math.floor(Number(params.height ?? 2400)), 12288));
  const DEVICE_SCALE = printMode ? 3 : 2;
  const MAX_PX       = 80_000_000;
  const ps           = Math.sqrt(MAX_PX / (w * h));
  if (ps < 1) { w = Math.floor(w * ps); h = Math.floor(h * ps); }
  const vpW     = Math.ceil(w / DEVICE_SCALE);
  const vpH     = Math.ceil(h / DEVICE_SCALE);
  const IDLE_MS = DEVICE_SCALE > 1 ? 150 : 100;

  const FULL_IDLE_MS      = 55_000;
  const PARTIAL_AFTER_MS  = 30_000;

  let context: BrowserContext | null = null;
  const renderStart = Date.now();

  try {
    const renderAsync = async () => {
      const b = await getBrowser();
      context = await b.newContext({ viewport: { width: vpW, height: vpH }, deviceScaleFactor: DEVICE_SCALE });
      const page = await context.newPage();

      await page.route('**/*', async (route) => {
        const preq  = route.request();
        const url   = preq.url();
        const rtype = preq.resourceType();
        if (!url.startsWith('http')) { await route.continue(); return; }
        try {
          const { protocol, hostname } = new URL(url);
          if (['script', 'stylesheet', 'font'].includes(rtype)) {
            if (ALLOWED_ASSET_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
              await route.continue(); return;
            }
            console.warn(`[render] Blocked ${rtype} from unlisted asset host: ${hostname}`);
            await route.abort('blockedbyclient'); return;
          }
          if (protocol !== 'https:') { await route.abort('blockedbyclient'); return; }
          if (!ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
            console.warn(`[render] Blocked request to unlisted host: ${hostname}`);
            await route.abort('blockedbyclient'); return;
          }
          if (await isPrivateHost(hostname)) {
            console.warn(`[render] Blocked request to private IP for host: ${hostname}`);
            await route.abort('blockedbyclient'); return;
          }
          await route.continue();
        } catch (e) {
          console.warn('[render] Route intercept error — aborting:', e);
          await route.abort('blockedbyclient');
        }
      });

      await page.setContent(buildRenderHtml(styleJson, lng, lat, zoom, bearing, pitch, overlay), { waitUntil: 'domcontentloaded' });

      let isPartialRender = false;
      try {
        await page.waitForFunction(
          `window.__mapIdle===true&&(Date.now()-window.__mapIdleTime)>=${IDLE_MS}`,
          { timeout: FULL_IDLE_MS, polling: 150 },
        );
      } catch (idleErr: unknown) {
        const tilesLoaded = await page.evaluate<number>('window.__tileCount || 0');
        const elapsed = Date.now() - renderStart;
        if (tilesLoaded > 0 && elapsed >= PARTIAL_AFTER_MS) {
          console.warn(`[render] Partial render fallback: full idle not reached after ${Math.round(elapsed/1000)}s, tileCount=${tilesLoaded} — proceeding`);
          isPartialRender = true;
          await page.waitForTimeout(500);
        } else {
          throw new Error(`Map tiles not loaded after ${Math.round(elapsed/1000)}s (tileCount=${tilesLoaded})`);
        }
      }

      await page.evaluate('window.__runComposite()');
      await page.waitForFunction('window.__compositeReady===true', { timeout: 15000, polling: 100 });
      const screenshot = await page.screenshot({ type: 'png', scale: 'device' });
      console.log(`[render] Done in ${Math.round((Date.now()-renderStart)/1000)}s — ${w}x${h}px${isPartialRender?' (partial)':''}`);
      return screenshot;
    };

    const timeoutP = new Promise<never>((_,rej) => setTimeout(() => rej(new Error('Render timeout (58s)')), 58_000));
    return await Promise.race([renderAsync(), timeoutP]);
  } finally {
    await (context as BrowserContext | null)?.close().catch((e: unknown) => console.error('context.close():', e));
  }
}

// ── Printful helpers ────────────────────────────────────────────────────────
interface PrintfulRecipient {
  name:          string;
  address1:      string;
  address2?:     string;
  city:          string;
  state_code:    string;
  country_code:  string;
  zip:           string;
  phone?:        string;
}

async function findExistingPrintfulOrder(externalId: string): Promise<string | null> {
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
    const data = await res.json();
    const orders: Array<{ id: number }> = data?.data ?? data?.result ?? [];
    return orders.length > 0 ? String(orders[0].id) : null;
  } catch {
    return null;
  }
}

// ── MapvibeConfigSnapshot type (mirrors Vercel) ─────────────────────────────
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
 * Download config snapshot from Vercel Blob, render PNG at 300 DPI, upload result back to Blob.
 * Returns the Blob URL of the uploaded PNG, or null on any failure.
 * 300 DPI is hard-enforced — no PNG export is ever produced at lower resolution.
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
  const DPI      = 300;
  const widthCm  = Number(cfg.widthCm)  || 40.64;
  const heightCm = Number(cfg.heightCm) || 50.80;
  const width    = Math.min(Math.round((widthCm  / CM_PER_INCH) * DPI), MAX_RENDER_PX_WH);
  const height   = Math.min(Math.round((heightCm / CM_PER_INCH) * DPI), MAX_RENDER_PX_WH);
  console.log(`[fulfill] Config render: ${widthCm}x${heightCm}cm → ${width}x${height}px @ ${DPI} DPI`);

  // 3. Patch style: inject MapTiler, absolutize relative URLs
  let styleJson: Record<string, unknown>;
  try {
    styleJson = JSON.parse(JSON.stringify(cfg.styleJson)) as Record<string, unknown>;
    const sources = styleJson.sources as Record<string, Record<string, unknown>> | undefined;
    if (sources) {
      for (const src of Object.values(sources)) {
        if (typeof src?.url === 'string') {
          const needsPatch = src.url.includes('openfreemap.org') || src.url.startsWith('/');
          if (needsPatch) {
            src.url = MAPTILER_API_KEY
              ? `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_API_KEY}`
              : `https://tiles.openfreemap.org/planet`;
          }
        }
      }
    }
    if (typeof styleJson.glyphs === 'string' && styleJson.glyphs.startsWith('/'))
      styleJson.glyphs = SITE_ORIGIN + styleJson.glyphs;
    if (typeof styleJson.sprite === 'string' && styleJson.sprite.startsWith('/'))
      styleJson.sprite = SITE_ORIGIN + styleJson.sprite;
  } catch {
    styleJson = cfg.styleJson as Record<string, unknown>;
  }

  // 4. Compute adjusted zoom
  const userZoom   = typeof cfg.zoom === 'number' && isFinite(cfg.zoom) ? cfg.zoom : 0;
  const dominantPx = Math.max(width, height, PREVIEW_CANVAS_PX);
  const renderZoom = Math.min(MAX_ZOOM_RENDER, userZoom + Math.log2(dominantPx / PREVIEW_CANVAS_PX));

  // 5. Render via internal browser pipeline
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
      printMode:      true, // high-DPI path always uses printMode
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
      access: 'public',
      contentType: 'image/png',
    });
    console.log(`[fulfill] Config-rendered PNG uploaded: ${blob.url} (${width}x${height}px)`);
    return blob.url;
  } catch (err) {
    console.error('[fulfill] Blob upload failed:', err);
    return null;
  }
}

// ── POST /render (unchanged behaviour — wraps renderPngInternal) ─────────────
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
    const screenshot = await renderPngInternal({
      styleJson, center, zoom, bearing, pitch, width, height, printMode, overlay,
    });
    res.setHeader('Content-Type', 'image/png');
    if (!printMode) res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(screenshot);
  } catch (err: any) {
    const elapsed = Math.round((Date.now()-renderStart)/1000);
    console.error(`[render] Error after ${elapsed}s:`, err.message || err);
    res.status(500).json({ error: err.message || 'Render failed', elapsed });
  } finally {
    activeRenders--;
  }
});

// ── POST /fulfill — Printful fulfillment (Railway-owned) ────────────────────
/**
 * Receives a fulfillment job from the Vercel webhook dispatcher.
 * Handles: PNG resolution (config render OR direct pngUrl), Printful dedup,
 * order creation (v2 + v1 fallback), and race-condition dedup resolution.
 *
 * Body:
 *   externalId      string  — shopify-{orderId}-{sku} idempotency key
 *   recipient       object  — Printful-format shipping address
 *   variantId       number  — Printful variant ID (v1 fallback)
 *   catalogVariantId number — Printful catalog variant ID (v2)
 *   label           string  — Human-readable product label for order name
 *   quantity        number  — Item quantity
 *   pngUrl?         string  — Pre-resolved PNG URL (skip render if provided)
 *   configUrl?      string  — Config snapshot Blob URL (render + upload if pngUrl absent)
 */
interface FulfillBody {
  externalId:       string;
  recipient:        PrintfulRecipient;
  variantId:        number;
  catalogVariantId: number;
  label:            string;
  quantity:         number;
  pngUrl?:          string;
  configUrl?:       string;
}

app.post('/fulfill', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  const {
    externalId, recipient, variantId, catalogVariantId, label, quantity,
    pngUrl, configUrl,
  } = req.body as FulfillBody;

  // Input validation
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

  // 1. Resolve final PNG URL
  let finalPngUrl: string | null = pngUrl ?? null;

  if (!finalPngUrl && configUrl) {
    console.log(`[fulfill] Config path — rendering config snapshot for ${externalId}`);
    activeRenders++;
    try {
      finalPngUrl = await renderConfigToBlobUrl(configUrl);
    } finally {
      activeRenders--;
    }
    if (!finalPngUrl) {
      console.error(`[fulfill] Config render FAILED for ${externalId}`);
      res.status(500).json({ error: 'Config render failed — check Railway logs', externalId });
      return;
    }
  }

  // 2. Dedup check — survives Railway restarts; Printful stores truth
  const existingId = await findExistingPrintfulOrder(externalId);
  if (existingId) {
    console.log(`[fulfill] Duplicate: Printful order ${existingId} already exists for ${externalId} — skipping`);
    res.status(200).json({ success: true, orderId: Number(existingId), externalId, duplicate: true });
    return;
  }

  // 3. Create Printful order — v2 first, v1 fallback
  const v2Payload = {
    external_id: externalId,
    shipping: 'STANDARD',
    recipient,
    confirm: true,
    items: [{
      source: 'catalog',
      catalog_variant_id: catalogVariantId,
      quantity,
      name: `MapVibe — ${label}`,
      files: [{ type: 'default', url: finalPngUrl }],
    }],
  };

  const pfHeaders: Record<string, string> = {
    Authorization: `Bearer ${PRINTFUL_KEY}`,
    'Content-Type': 'application/json',
  };
  if (PRINTFUL_STORE_ID) pfHeaders['X-PF-Store-Id'] = PRINTFUL_STORE_ID;

  try {
    let pfRes = await fetch(`${PRINTFUL_API_V2}/orders`, {
      method: 'POST',
      headers: pfHeaders,
      body: JSON.stringify(v2Payload),
    });
    let pfData = await pfRes.json();
    let apiVersion = 'v2';

    // Fallback to v1 if v2 fails
    if (!pfRes.ok) {
      console.warn(`[fulfill] v2 failed for ${externalId} — trying v1 fallback`);
      const v1Payload = {
        external_id: externalId,
        shipping: 'STANDARD',
        recipient,
        confirm: true,
        items: [{
          variant_id: variantId,
          quantity,
          name: `MapVibe — ${label}`,
          files: [{ type: 'default', url: finalPngUrl }],
        }],
      };
      pfRes = await fetch(`${PRINTFUL_API_V1}/orders`, {
        method: 'POST',
        headers: pfHeaders,
        body: JSON.stringify(v1Payload),
      });
      pfData = await pfRes.json();
      apiVersion = 'v1-fallback';
    }

    if (pfRes.ok) {
      const orderId = pfData.result?.id ?? pfData.data?.id;
      console.log(`[fulfill] Printful order created (${apiVersion}): ${orderId} for ${externalId}`);
      res.status(200).json({ success: true, orderId, externalId, apiVersion });
      return;
    }

    // Race condition: two deliveries both passed dedup before either created an order
    const errMsg: string = (pfData.result ?? pfData.error?.message ?? pfData.code ?? '') + '';
    const isDuplicate = errMsg.toLowerCase().includes('external_id')
      || errMsg.toLowerCase().includes('already exists')
      || errMsg.toLowerCase().includes('duplicate');

    if (isDuplicate) {
      const existingAfterRace = await findExistingPrintfulOrder(externalId);
      if (existingAfterRace) {
        console.log(`[fulfill] Race dedup resolved: Printful order ${existingAfterRace} for ${externalId}`);
        res.status(200).json({ success: true, orderId: Number(existingAfterRace), externalId, duplicate: true });
        return;
      }
      console.error(`[fulfill] Race dedup failed for ${externalId}:`, pfData);
      res.status(500).json({ success: false, error: 'Duplicate detected but could not resolve existing order', externalId });
      return;
    }

    const errDetail = pfData.result || pfData.error?.message || 'Printful error';
    console.error(`[fulfill] Printful error for ${externalId}:`, pfData);
    res.status(502).json({ success: false, error: errDetail, externalId, apiVersion });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : 'Network error';
    console.error(`[fulfill] Uncaught error for ${externalId}:`, err);
    res.status(500).json({ success: false, error: msg, externalId });
  }
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
app.listen(PORT, () => console.log(`MapVibe Render Service v2.3.0 on port ${PORT}`));
