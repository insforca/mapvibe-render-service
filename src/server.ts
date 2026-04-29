/**
 * MapVibe Render Service — server.ts v2.0
 *
 * v2.0 additions: server-side text compositing.
 * Accepts displayCity, displayCountry, fontFamily, theme, showPosterText,
 * fadeStyle, includeCredits in POST body. After map.idle, composites
 * gradient fades + poster text onto the map canvas using Canvas2D inside
 * Playwright's Chromium context. page.screenshot() captures the fully
 * composited poster — no client-side drawPosterText call needed.
 */
import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext } from 'playwright';
import { timingSafeEqual, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolve4, resolve6 } from 'dns/promises';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET ?? '';

if (!API_SECRET) {
  console.error('[render] FATAL: RENDER_API_SECRET env var not set — refusing to start');
  process.exit(1);
}

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

async function isPrivateHost(hostname: string): Promise<boolean> {
  try {
    const [a4, a6] = await Promise.all([
      resolve4(hostname).catch(() => [] as string[]),
      resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [...a4, ...a6].some(ip => PRIVATE_IP_RE.test(ip));
  } catch {
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

let activeRenders = 0;
const MAX_CONCURRENT = 1;

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
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });
  }
  return browser;
}

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', version: '2.0.0' }));

interface OverlayParams {
  displayCity?: string; displayCountry?: string; fontFamily?: string;
  showPosterText?: boolean; fadeStyle?: string; includeCredits?: boolean;
  textLayout?: string;
  theme?: { ui?: { bg?: string; text?: string }; map?: { land?: string } };
}

// Compositing helpers — vanilla JS injected into Playwright browser context.
// Mirrors client-side: withAlpha/parseHex (color utils), ditherRegion/applyFades
// (layers.ts), formatCoordinates (posterBounds.ts), formatCityLabel/shrinkFont/
// getTextLayoutMetrics/drawTextWithSpacing/drawPosterText (typography.ts + textLayout.ts)
const COMPOSITING_JS = `
function _wa(hex,a){var h=(hex||'#000').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';}\nfunction _ph(hex){var h=(hex||'#808080').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return{r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0};}\nfunction _dr(ctx,rx,ry,w,h,i){i=i||4;var rw=Math.round(w),rh=Math.round(h);if(rw<=0||rh<=0)return;var t=ctx.getTransform(),ax=Math.round(rx+t.e),ay=Math.round(ry+t.f),id=ctx.getImageData(ax,ay,rw,rh),d=id.data,B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];for(var py=0;py<rh;py++){var rb=py*rw,br=(py&3)*4;for(var px=0;px<rw;px++){var ii=(rb+px)*4,dv=Math.round(((B[br+(px&3)]/15)-0.5)*2*i);d[ii]=Math.max(0,Math.min(255,d[ii]+dv));d[ii+1]=Math.max(0,Math.min(255,d[ii+1]+dv));d[ii+2]=Math.max(0,Math.min(255,d[ii+2]+dv));}}ctx.putImageData(id,ax,ay);}\nfunction applyFades(ctx,W,H,color,fs){if(fs==='none')return;var tH=Math.round(H*0.25),tg=ctx.createLinearGradient(0,0,0,tH);tg.addColorStop(0,_wa(color,1));tg.addColorStop(.4,_wa(color,.45));tg.addColorStop(.7,_wa(color,.12));tg.addColorStop(1,_wa(color,0));ctx.fillStyle=tg;ctx.fillRect(0,0,W,tH);_dr(ctx,0,0,W,tH);if(fs==='text'){var fH=Math.round(H*.125),gH=Math.round(H*.10),fT=H-fH-gH,fg=ctx.createLinearGradient(0,fT,0,fT+gH);fg.addColorStop(0,_wa(color,0));fg.addColorStop(.18,_wa(color,.04));fg.addColorStop(.34,_wa(color,.14));fg.addColorStop(.5,_wa(color,.34));fg.addColorStop(.65,_wa(color,.6));fg.addColorStop(.8,_wa(color,.84));fg.addColorStop(.92,_wa(color,.97));fg.addColorStop(1,color);ctx.fillStyle=fg;ctx.fillRect(0,fT,W,gH);ctx.fillStyle=color;ctx.fillRect(0,H-fH,W,fH);_dr(ctx,0,fT,W,gH+fH);}else{var bH=Math.round(H*.25),bY=H-bH,bg=ctx.createLinearGradient(0,H,0,bY);bg.addColorStop(0,_wa(color,1));bg.addColorStop(.4,_wa(color,.45));bg.addColorStop(.7,_wa(color,.12));bg.addColorStop(1,_wa(color,0));ctx.fillStyle=bg;ctx.fillRect(0,bY,W,bH);_dr(ctx,0,bY,W,bH);}}\nvar _DR=3600,_EM=.02,_CB=250,_CM=110,_CTB=92,_COB=58,_AB=30,_CS=.35,_CTS=.45,_COS=.25;\nfunction fmtCoords(lat,lon){return Math.abs(lat).toFixed(4)+'\\u00b0 '+(lat>=0?'N':'S')+' / '+Math.abs(lon).toFixed(4)+'\\u00b0 '+(lon>=0?'E':'W');}\nfunction fmtCity(c){if(!c)return'';var lc=0,ac=0;for(var i=0;i<c.length;i++){var ch=c[i];if(/[A-Za-z\\u00C0-\\u024F]/.test(ch)){lc++;ac++;}else if(/\\p{L}/u.test(ch)){ac++;}}return(ac===0||lc/ac>.8)?c.toUpperCase():c;}\nfunction shrinkFont(base,min,len,sp){len=Math.max(len,1);var s=base;if(len>10)s=Math.max(min,base*(10/len));var wE=len*.62+(len-1)*sp,mW=_DR*.92;if(wE*s>mW)s=Math.max(min,mW/wE);return s;}\nfunction textMetrics(w,h,layout){if(layout==='editorial'){var x=w*.06;return{cX:x,cY:h*.82,dX:x,dY:h*.855,coX:x,coY:h*.885,crX:x,crY:h*.92,al:'left',dW:120};}var cx=w*.5;return{cX:cx,cY:h*.885,dX:cx,dY:h*.905,coX:cx,coY:h*.925,crX:cx,crY:h*.945,al:'center',dW:w*.2};}\nfunction drawSpaced(ctx,text,x,y,sp,fs,al){if(sp===0){ctx.fillText(text,x,y);return;}var s=sp*fs,tot=ctx.measureText(text).width+s*(text.length-1),sx=al==='center'?x-tot/2:al==='right'?x-tot:x,sa=ctx.textAlign;ctx.textAlign='left';var cx=sx;for(var i=0;i<text.length;i++){var ch=text[i];ctx.fillText(ch,cx,y);cx+=ctx.measureText(ch).width+s;}ctx.textAlign=sa;}\nfunction drawPosterText(ctx,W,H,theme,lat,lon,city,country,ff,showText,credits,layout){var land=(theme&&theme.map&&theme.map.land)||'#808080',rgb=_ph(land),luma=(.2126*rgb.r+.7152*rgb.g+.0722*rgb.b)/255;var tc=(theme&&theme.ui&&theme.ui.text)||(luma<.5?'#FFFFFF':'#111111'),ac=luma<.52?'#f5faff':'#0e1822';var tFF=ff?'"'+ff+'","Space Grotesk",sans-serif':'"Space Grotesk",sans-serif';var bFF=ff?'"'+ff+'","IBM Plex Mono",monospace':'"IBM Plex Mono",monospace';var ds=Math.max(.45,Math.min(W,H)/_DR),afs=_AB*ds;if(showText){var m=textMetrics(W,H,layout||'centered'),cl=fmtCity(city||''),cfs=shrinkFont(_CB*ds,_CM*ds,(city||'').length,_CS),ctFS=_CTB*ds,coFS=_COB*ds;ctx.fillStyle=tc;ctx.textAlign=m.al;ctx.textBaseline='middle';ctx.font='700 '+cfs+'px '+tFF;drawSpaced(ctx,cl,m.cX,m.cY,_CS,cfs,m.al);ctx.strokeStyle=tc;ctx.lineWidth=3*ds;ctx.beginPath();if(m.al==='center'){ctx.moveTo(m.dX-m.dW/2,m.dY);ctx.lineTo(m.dX+m.dW/2,m.dY);}else{ctx.moveTo(m.dX,m.dY);ctx.lineTo(m.dX+m.dW,m.dY);}ctx.stroke();ctx.font='300 '+ctFS+'px '+tFF;drawSpaced(ctx,(country||'').toUpperCase(),m.coX,m.coY,_CTS,ctFS,m.al);ctx.globalAlpha=.75;ctx.font='400 '+coFS+'px '+bFF;drawSpaced(ctx,fmtCoords(lat,lon),m.crX,m.crY,_COS,coFS,m.al);ctx.globalAlpha=1;}ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='right';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('\\u00a9 OpenStreetMap contributors',W*(1-_EM),H*(1-_EM));ctx.globalAlpha=1;if(credits){ctx.fillStyle=ac;ctx.globalAlpha=.9;ctx.textAlign='left';ctx.textBaseline='bottom';ctx.font='300 '+afs+'px '+bFF;ctx.fillText('created with mapvibestudio.com',W*_EM,H*(1-_EM));ctx.globalAlpha=1;}}\n`;

function buildRenderHtml(
  styleJson: object, lng: number, lat: number,
  zoom: number, bearing: number, pitch: number,
  overlay?: OverlayParams,
): string {
  const fontTag = overlay?.fontFamily
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(overlay.fontFamily)}:ital,wght@0,300;0,400;0,700&display=swap" rel="stylesheet">`
    : '';
  const overlayJson = overlay ? htmlSafeJson(overlay) : 'null';
  const bgColor     = overlay?.theme?.ui?.bg ?? '#ffffff';

  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8" />\n<style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:100%;height:100%;overflow:hidden;}#map{width:100%;height:100%;}#composite{display:none;position:absolute;top:0;left:0;width:100%;height:100%;}</style>\n${fontTag}\n<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.css"/>\n${MAPLIBRE_SCRIPT}\n</head><body>\n<div id="map"></div><canvas id="composite"></canvas>\n<script>\n${COMPOSITING_JS}\nwindow.__mapIdle=false;window.__mapIdleTime=0;window.__compositeReady=false;\nvar __ov=${overlayJson};\nconst map=new maplibregl.Map({container:'map',style:${htmlSafeJson(styleJson)},center:[${lng},${lat}],zoom:${zoom},bearing:${bearing},pitch:${pitch},interactive:false,attributionControl:false,fadeDuration:0,preserveDrawingBuffer:true,canvasContextAttributes:{antialias:true}});\nmap.on('render',()=>{window.__mapIdle=false;});\nmap.on('idle',()=>{window.__mapIdle=true;window.__mapIdleTime=Date.now();});\nwindow.__runComposite=async function(){\n  if(document.fonts&&document.fonts.ready)await document.fonts.ready;\n  var mc=map.getCanvas(),w=mc.width,h=mc.height;\n  var cv=document.getElementById('composite');cv.width=w;cv.height=h;\n  var ctx=cv.getContext('2d',{colorSpace:'srgb'});\n  ctx.fillStyle=${JSON.stringify(bgColor)};ctx.fillRect(0,0,w,h);\n  ctx.drawImage(mc,0,0);\n  if(__ov){var fc=(__ov.theme&&__ov.theme.ui&&__ov.theme.ui.bg)||${JSON.stringify(bgColor)};applyFades(ctx,w,h,fc,__ov.fadeStyle||'default');drawPosterText(ctx,w,h,__ov.theme||{},${lat},${lng},__ov.displayCity||'',__ov.displayCountry||'',__ov.fontFamily||'',__ov.showPosterText!==false,__ov.includeCredits!==false,__ov.textLayout||'centered');}\n  document.getElementById('map').style.display='none';cv.style.display='block';\n  window.__compositeReady=true;\n};\n</script></body></html>`;
}

app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;
  if (activeRenders >= MAX_CONCURRENT) { res.status(503).json({ error: 'Render service busy — try again shortly' }); return; }

  const {
    styleJson, center, zoom, width=2400, height=2400, bearing=0, pitch=0, printMode=false,
    displayCity, displayCountry, fontFamily, showPosterText, fadeStyle, includeCredits, textLayout, theme,
  } = req.body;

  if (!styleJson||typeof styleJson!=='object'||Array.isArray(styleJson)) { res.status(400).json({error:'styleJson must be a non-null object'}); return; }
  if (!center||zoom==null) { res.status(400).json({error:'Missing required fields: center, zoom'}); return; }

  const urlError = validateStyleJsonUrls(styleJson);
  if (urlError) { res.status(400).json({ error: urlError }); return; }

  const [lng, lat] = center;
  let w = Math.max(100, Math.min(Math.floor(Number(width)||2400), 12288));
  let h = Math.max(100, Math.min(Math.floor(Number(height)||2400), 12288));
  const DEVICE_SCALE = printMode ? 3 : 2;
  const MAX_PX       = 80_000_000;
  const ps           = Math.sqrt(MAX_PX / (w * h));
  if (ps < 1) { w = Math.floor(w * ps); h = Math.floor(h * ps); }
  const vpW     = Math.ceil(w / DEVICE_SCALE);
  const vpH     = Math.ceil(h / DEVICE_SCALE);
  const IDLE_MS = DEVICE_SCALE > 1 ? 500 : 300;

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

  let context: BrowserContext | null = null;
  activeRenders++;
  try {
    const renderAsync = async () => {
      const b = await getBrowser();
      context = await b.newContext({ viewport: { width: vpW, height: vpH }, deviceScaleFactor: DEVICE_SCALE });
      const page = await context.newPage();

      // C2/H4 fix: intercept every Chromium network request — validates redirects too
      await page.route('**/*', async (route) => {
        const preq  = route.request();
        const url   = preq.url();
        const rtype = preq.resourceType();
        if (!url.startsWith('http')) { await route.continue(); return; }
        try {
          const { protocol, hostname } = new URL(url);
          // CDN asset loads use a separate allowlist
          if (['script', 'stylesheet', 'font'].includes(rtype)) {
            if (ALLOWED_ASSET_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
              await route.continue(); return;
            }
            console.warn(`[render] Blocked ${rtype} from unlisted asset host: ${hostname}`);
            await route.abort('blockedbyclient'); return;
          }
          // All other requests: HTTPS + tile allowlist + not private IP
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
      await page.waitForFunction(`window.__mapIdle===true&&(Date.now()-window.__mapIdleTime)>=${IDLE_MS}`, { timeout: 30000, polling: 150 });
      await page.evaluate('window.__runComposite()');
      await page.waitForFunction('window.__compositeReady===true', { timeout: 15000, polling: 100 });
      return page.screenshot({ type: 'png', scale: 'device' });
    };
    const timeoutP = new Promise<never>((_,rej)=>setTimeout(()=>rej(new Error('Render timeout (50s)')),50_000));
    const screenshot = await Promise.race([renderAsync(), timeoutP]);
    res.setHeader('Content-Type', 'image/png');
    if (!printMode) res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(screenshot);
  } catch (err: any) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message || 'Render failed' });
  } finally {
    activeRenders--;
    await (context as BrowserContext | null)?.close().catch((e: unknown) => console.error('context.close():', e));
  }
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
app.listen(PORT, () => console.log(`MapVibe Render Service v2.0.0 on port ${PORT}`));
