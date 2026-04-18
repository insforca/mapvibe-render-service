import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext } from 'playwright';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
  }
  return browser;
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// POST /render
// Body: { styleJson, center: [lng, lat], zoom, width?, height?, bearing?, pitch? }
app.post('/render', async (req: Request, res: Response): Promise<void> => {
  if (API_SECRET) {
    const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (token !== API_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const { styleJson, center, zoom, width = 2400, height = 2400, bearing = 0, pitch = 0 } = req.body;

  if (!styleJson || !center || zoom == null) {
    res.status(400).json({ error: 'Missing required fields: styleJson, center, zoom' });
    return;
  }

  const [lng, lat] = center;
  const w = Math.min(Number(width), 4000);
  const h = Math.min(Number(height), 4000);

  let context: BrowserContext | null = null;

  try {
    const b = await getBrowser();
    context = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const html = buildRenderHtml(styleJson, lng, lat, zoom, bearing, pitch);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Pass as string so TypeScript does not evaluate window in Node.js context
    await page.waitForFunction('window.__mapIdle === true', { timeout: 30000, polling: 500 });
    await page.waitForTimeout(500);
    const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(screenshot);
  } catch (err: any) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message || 'Render failed' });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

function buildRenderHtml(styleJson: object, lng: number, lat: number, zoom: number, bearing: number, pitch: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>* { margin:0; padding:0; box-sizing:border-box; } html,body,#map { width:100%; height:100%; overflow:hidden; }</style>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.css" />
<script src="https://unpkg.com/maplibre-gl@4.3.2/dist/maplibre-gl.js"></script>
</head><body><div id="map"></div>
<script>
window.__mapIdle = false;
const map = new maplibregl.Map({
  container: 'map', style: ${JSON.stringify(styleJson)},
  center: [${lng}, ${lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: ${pitch},
  interactive: false, attributionControl: false, fadeDuration: 0, preserveDrawingBuffer: true
});
map.on('idle', () => { window.__mapIdle = true; });
</script></body></html>`;
}

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
app.listen(PORT, () => console.log(`MapVibe Render Service on port ${PORT}`));
