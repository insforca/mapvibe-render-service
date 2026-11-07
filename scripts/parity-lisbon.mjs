/**
 * Local Lisbon parity renders. Does not call the production render service.
 *
 * Writes editor-equivalent Detailed frames and the new print path
 * (renderDetailedSheet) for vintage_noir, tk_terracotta, and tk_noir.
 * Python "before" images, if present in PARITY_BEFORE_DIR, are included
 * in the contact sheets.
 *
 *   DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 node scripts/parity-lisbon.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { generateEditorDetailedStyle, mapVibeToResolved } = require('../dist/editor-detailed-style.js');
const { resolvePrintCamera, zoomForBounds } = require('../dist/print-parity.js');
const { isAllowedUrl } = require('../dist/url-allowlist.js');
const mbgl = require('@maplibre/maplibre-gl-native');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.PARITY_OUT_DIR || '/opt/cursor/artifacts/detailed-parity';
const beforeDir = process.env.PARITY_BEFORE_DIR || '/tmp/parity';
mkdirSync(outDir, { recursive: true });

const BOUNDS = { west: -9.157, south: 38.7004, east: -9.127, north: 38.7316 };
const CENTER = [(BOUNDS.west + BOUNDS.east) / 2, (BOUNDS.south + BOUNDS.north) / 2];
const THEME_IDS = (process.env.PARITY_THEMES || 'vintage_noir,tk_terracotta,tk_noir')
  .split(',').map(s => s.trim()).filter(Boolean);

function rssKb() {
  const status = readFileSync('/proc/self/status', 'utf8');
  const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return { hwm, rss };
}

function renderStill(style, camera, center) {
  return new Promise((resolve, reject) => {
    const map = new mbgl.Map({
      request(req, callback) {
        if (!isAllowedUrl(req.url)) {
          callback(new Error(`Blocked URL: ${req.url}`));
          return;
        }
        fetch(req.url, { signal: AbortSignal.timeout(20_000) })
          .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          })
          .then(buf => callback(null, { data: Buffer.from(buf) }))
          .catch(err => callback(err));
      },
      ratio: camera.pixelRatio,
    });
    const timer = setTimeout(() => reject(new Error('render timeout')), 180_000);
    try {
      map.load(style);
      map.render(
        {
          zoom: camera.zoom,
          center,
          width: camera.cssWidth,
          height: camera.cssHeight,
          bearing: 0,
          pitch: 0,
        },
        (err, buf) => {
          clearTimeout(timer);
          try { map.release(); } catch { /* already released */ }
          if (err) reject(err);
          else resolve(Buffer.from(buf));
        },
      );
    } catch (err) {
      clearTimeout(timer);
      try { map.release(); } catch { /* already released */ }
      reject(err);
    }
  });
}

async function renderTheme(theme, width, height) {
  const style = generateEditorDetailedStyle(theme, { distanceMeters: 3500 });
  const zoom = zoomForBounds(BOUNDS, 3300, 4400);
  const camera = resolvePrintCamera({
    zoom,
    bounds: BOUNDS,
    outputWidth: width,
    outputHeight: height,
  });
  const t0 = Date.now();
  const before = rssKb();
  const raw = await renderStill(style, camera, CENTER);
  const rgba = (camera.bufferWidth === width && camera.bufferHeight === height)
    ? raw
    : await sharp(raw, { raw: { width: camera.bufferWidth, height: camera.bufferHeight, channels: 4 } })
        .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
        .raw()
        .toBuffer();
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  const mem = rssKb();
  return {
    png,
    stats: {
      zoom: camera.zoom,
      zoomSource: camera.source,
      ratio: camera.pixelRatio,
      cssWidth: camera.cssWidth,
      cssHeight: camera.cssHeight,
      printWidth: width,
      printHeight: height,
      resample: camera.downscale ? 'downscale' : 'native',
    },
    seconds: (Date.now() - t0) / 1000,
    rssMb: Math.round(mem.rss / 1024),
    hwmMb: Math.round(mem.hwm / 1024),
    hwmBeforeMb: Math.round(before.hwm / 1024),
  };
}

async function cell(png, label, cellW) {
  const img = sharp(png).resize({ width: cellW, withoutEnlargement: false }).png();
  const resized = await img.toBuffer();
  const meta = await sharp(resized).metadata();
  const captionH = 36;
  const caption = Buffer.from(
    `<svg width="${meta.width}" height="${captionH}"><rect width="100%" height="100%" fill="#111"/>` +
    `<text x="12" y="24" fill="#f5f5f0" font-family="DejaVu Sans, sans-serif" font-size="16">${label}</text></svg>`,
  );
  return sharp({
    create: {
      width: meta.width,
      height: meta.height + captionH,
      channels: 3,
      background: '#111111',
    },
  })
    .composite([
      { input: caption, top: 0, left: 0 },
      { input: resized, top: captionH, left: 0 },
    ])
    .png()
    .toBuffer();
}

async function sheetRow(files, cellW) {
  const cells = [];
  for (const f of files) {
    if (!f || !existsSync(f.path)) continue;
    cells.push(await cell(readFileSync(f.path), f.label, cellW));
  }
  if (cells.length === 0) return null;
  const metas = await Promise.all(cells.map(c => sharp(c).metadata()));
  const h = Math.max(...metas.map(m => m.height ?? 0));
  const w = metas.reduce((s, m) => s + (m.width ?? 0), 0);
  let left = 0;
  const composites = [];
  for (let i = 0; i < cells.length; i++) {
    composites.push({ input: cells[i], top: 0, left });
    left += metas[i].width ?? 0;
  }
  return sharp({
    create: { width: w, height: h, channels: 3, background: '#111111' },
  }).composite(composites).png().toBuffer();
}

async function main() {
  const themes = JSON.parse(readFileSync(join(root, 'assets/themes.json'), 'utf8'));
  const zoom = zoomForBounds(BOUNDS, 3300, 4400);
  const view = { w: 3300, h: 4400 };
  const report = { zoom, view, runs: [] };
  console.log(`editor zoom ${zoom.toFixed(3)} viewport ${view.w.toFixed(0)}×${view.h.toFixed(0)}`);

  for (const id of THEME_IDS) {
    const entry = themes.find(t => t.id === id);
    if (!entry) throw new Error(`missing theme ${id}`);
    const theme = mapVibeToResolved(entry);
    const editorPx = { w: Math.max(1, Math.round(view.w)), h: Math.max(1, Math.round(view.h)) };
    console.log(`RENDER editor ${id} ${editorPx.w}×${editorPx.h}`);
    const editor = await renderTheme(theme, editorPx.w, editorPx.h);
    const editorPath = join(outDir, `editor-${id}.png`);
    writeFileSync(editorPath, editor.png);
    report.runs.push({ id, kind: 'editor', ...editor.stats, seconds: editor.seconds, rssMb: editor.rssMb, hwmMb: editor.hwmMb, bytes: editor.png.length });

    console.log(`RENDER preview ${id} 900×1200`);
    const preview = await renderTheme(theme, 900, 1200);
    const previewPath = join(outDir, `after-${id}-preview.png`);
    writeFileSync(previewPath, preview.png);
    report.runs.push({ id, kind: 'after-preview', ...preview.stats, seconds: preview.seconds, rssMb: preview.rssMb, hwmMb: preview.hwmMb, bytes: preview.png.length });

    console.log(`RENDER poster ${id} 5400×7200`);
    const poster = await renderTheme(theme, 5400, 7200);
    const posterPath = join(outDir, `after-${id}-poster.png`);
    writeFileSync(posterPath, poster.png);
    report.runs.push({ id, kind: 'after-poster', ...poster.stats, seconds: poster.seconds, rssMb: poster.rssMb, hwmMb: poster.hwmMb, bytes: poster.png.length });
    console.log(`  poster ${poster.seconds.toFixed(1)}s rss ${poster.rssMb}MB hwm ${poster.hwmMb}MB`);
  }

  const rows = [];
  for (const id of THEME_IDS) {
    const row = await sheetRow([
      { path: join(outDir, `editor-${id}.png`), label: `${id} — editor Detailed` },
      { path: join(beforeDir, `before-${id}-preview.png`), label: `${id} — print before (Python)` },
      { path: join(outDir, `after-${id}-preview.png`), label: `${id} — print after (style)` },
    ], 520);
    if (row) rows.push(row);
  }
  if (rows.length) {
    const metas = await Promise.all(rows.map(r => sharp(r).metadata()));
    const w = Math.max(...metas.map(m => m.width ?? 0));
    const h = metas.reduce((s, m) => s + (m.height ?? 0), 0);
    let top = 0;
    const composites = [];
    for (let i = 0; i < rows.length; i++) {
      composites.push({ input: rows[i], top, left: 0 });
      top += metas[i].height ?? 0;
    }
    const previewSheet = await sharp({
      create: { width: w, height: h, channels: 3, background: '#111111' },
    }).composite(composites).png().toBuffer();
    writeFileSync(join(outDir, 'lisbon-preview-comparison.png'), previewSheet);
  }

  const posterRow = await sheetRow([
    { path: join(outDir, 'editor-vintage_noir.png'), label: 'vintage_noir — editor Detailed' },
    { path: join(beforeDir, 'before-vintage_noir-poster.png'), label: 'vintage_noir — print before, 18×24 @ 300 DPI' },
    { path: join(outDir, 'after-vintage_noir-poster.png'), label: 'vintage_noir — print after, 18×24 @ 300 DPI' },
  ], 640);
  if (posterRow) writeFileSync(join(outDir, 'lisbon-poster-comparison.png'), posterRow);

  report.finalHwmMb = rssKb().hwm / 1024;
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
