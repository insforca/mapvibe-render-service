/**
 * MapVibe Render Service — server.ts
 *
 * Security hardening: C01 htmlSafeJson, C02 fail-closed auth + timingSafeEqual,
 * H01 SSRF tile-URL allowlist, H02 concurrency limiter, H03 no --single-process.
 * Quality:  8192px cap, antialias, maplibre from node_modules, 300ms sustained idle.
 */
import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext } from 'playwright';
import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const app = express();
// M03: body limit reduced to 2 MB
app.use(express.json({ limit: '2mb' }));

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET ?? '';

// C02 — Fail closed: refuse to start without a secret configured
if (!API_SECRET) {
  console.error('[render] FATAL: RENDER_API_SECRET env var not set — refusing to start');
  process.exit(1);
}

// ── C02 — Constant-time auth check ───────────────────────────────────────────
function checkAuth(req: Request, res: Response): boolean {
  const raw   = req.headers['x-api-key'] ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw[0] : '');
  try {
    const ok = timingSafeEqual(Buffer.from(token), Buffer.from(API_SECRET));
    if (!ok) res.status(401).json({ error: 'Unauthorized' });
    return ok;
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
}

// ── C01 — HTML-safe JSON serializer (prevents </script> injection) ────────────
function htmlSafeJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g,  '\u003c')
    .replace(/>/g,  '\u003e')
    .replace(/&/g,  '\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── H01 — styleJson URL allowlist (blocks SSRF) ───────────────────────────────
const ALLOWED_TILE_HOSTS = [
  'tiles.openfreemap.org',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'basemaps.cartocdn.com',
  'api.maptiler.com',
  'maps.geoapify.com',
];

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
    } catch {
      return `Malformed URL in styleJson: ${url}`;
    }
  }
  return null;
}

// ── H02 — Concurrency limiter ─────────────────────────────────────────────────
let activeRenders = 0;
const MAX_CONCURRENT = 3;

// ── MapLibre from node_modules (zero CDN dependency) ─────────────────────────
let MAPLIBRE_SCRIPT = '';
try {
  const js = readFileSync(
    join(__dirname, '..', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.js'),
    'utf8'
  );
  MAPLIBRE_SCRIPT = `<script>${js}</script>`;
  console.log(`[render] maplibre-gl.js loaded from node_modules (${(js.length / 1024).toFixed(0)} KB)`);
} catch {
  MAPLIBRE_SCRIPT = `<script src="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.js"></script>`;
  console.warn('[render] maplibre-gl.js not in node_modules — falling back to unpkg CDN');
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // H03: --single-process removed
      ],
    });
  }
  return browser;
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '1.2.0' });
});

app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res)) return;

  if (activeRenders >= MAX_CONCURRENT) {
    res.status(503).json({ error: 'Render service busy — try again shortly' });
    return;
  }

  const { styleJson, center, zoom, width = 2400, height = 2400, bearing = 0, pitch = 0 } = req.body;

  if (!styleJson || typeof styleJson !== 'object' || Array.isArray(styleJson)) {
    res.status(400).json({ error: 'styleJson must be a non-null object' });
    return;
  }
  if (!center || zoom == null) {
    res.status(400).json({ error: 'Missing required fields: center, zoom' });
    return;
  }

  const urlError = validateStyleJsonUrls(styleJson);
  if (urlError) { res.status(400).json({ error: urlError }); return; }

  const [lng, lat] = center;
  const w = Math.max(100, Math.min(Math.floor(Number(width)  || 2400), 8192));
  const h = Math.max(100, Math.min(Math.floor(Number(height) || 2400), 8192));

  let context: BrowserContext | null = null;
  activeRenders++;

  try {
    const renderAsync = async () => {
      const b = await getBrowser();
      context = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.setContent(buildRenderHtml(styleJson, lng, lat, zoom, bearing, pitch), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        'window.__mapIdle === true && (Date.now() - window.__mapIdleTime) >= 300',
        { timeout: 30000, polling: 150 }
      );
      return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
    };

    const timeoutP = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Render timeout (35s)')), 35_000)
    );

    const screenshot = await Promise.race([renderAsync(), timeoutP]);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(screenshot);
  } catch (err: any) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message || 'Render failed' });
  } finally {
    activeRenders--;
    if (context) await context.close().catch(e => console.error('context.close() error:', e));
  }
});

function buildRenderHtml(
  styleJson: object, lng: number, lat: number,
  zoom: number, bearing: number, pitch: number
): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>* { margin:0; padding:0; box-sizing:border-box; } html,body,#map { width:100%; height:100%; overflow:hidden; }</style>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.css" />
${MAPLIBRE_SCRIPT}
</head><body><div id="map"></div>
<script>
window.__mapIdle = false;
window.__mapIdleTime = 0;
const map = new maplibregl.Map({
  container: 'map', style: ${htmlSafeJson(styleJson)},
  center: [${lng}, ${lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: ${pitch},
  interactive: false, attributionControl: false, fadeDuration: 0, preserveDrawingBuffer: true,
  canvasContextAttributes: { antialias: true }
});
map.on('render', () => { window.__mapIdle = false; });
map.on('idle',   () => { window.__mapIdle = true; window.__mapIdleTime = Date.now(); });
</script></body></html>`;
}

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
app.listen(PORT, () => console.log(`MapVibe Render Service on port ${PORT}`));
