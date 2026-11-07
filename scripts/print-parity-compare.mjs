/**
 * Local-only Clean print comparison. Talks to the render service on localhost.
 * Does not call production, /fulfill, or any vendor.
 *
 * Builds the editor Clean style the way mapvibe-studio's generateMapStyle does
 * (Terraink stops × 5.5^0.8, no landcover, secondary/tertiary/local hidden,
 * building opacity 0.84). Colors come from assets/themes.json.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const mbgl = require('@maplibre/maplibre-gl-native');
const {
  MAP_OVERZOOM_SCALE,
  boundsForViewport,
  preparePrintStyle,
  resolvePrintCamera,
  zoomForBounds,
  CLEAN_MINOR_HIGH_LINE_OPACITY,
  CLEAN_MINOR_HIGH_CASING_OPACITY,
} = require('../dist/print-parity.js');

const PORT = process.env.PARITY_PORT || '3456';
const SECRET = process.env.RENDER_API_SECRET || 'parity-local';
const OUT_DIR = process.env.PARITY_OUT || '/tmp/print-parity';
const ART_DIR = '/opt/cursor/artifacts';

const LISBON = [-9.1393, 38.7223];
const PREVIEW_CSS_W = 480;
const PREVIEW_CSS_H = 640;
const INTERNAL_W = PREVIEW_CSS_W * MAP_OVERZOOM_SCALE;
const INTERNAL_H = PREVIEW_CSS_H * MAP_OVERZOOM_SCALE;
const DISTANCE_M = 22000;
const EARTH_M = 40075016.68557849;
const SCALE = Math.pow(MAP_OVERZOOM_SCALE, 0.8);

const THEMES = ['vintage_noir', 'tk_terracotta', 'tk_noir'];

function editorZoom(lat, containerPx, distanceM) {
  return Math.log2(
    (EARTH_M * Math.cos((lat * Math.PI) / 180) * containerPx) / (2 * distanceM * 512),
  );
}

function widthExpr(stops) {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([z, w]) => [z, w * SCALE])];
}
function opacityExpr(stops) {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flat()];
}
const LINE_GEOM = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
function lineClass(classes) {
  return ['all', LINE_GEOM, ['match', ['get', 'class'], classes, true, false]];
}

const MINOR_HIGH = ['primary', 'primary_link', 'motorway_link', 'trunk', 'trunk_link'];
const MAJOR = ['motorway'];

function editorStyle(theme, { cleanOpacity }) {
  const land = theme.background;
  const roads = {
    major: theme.roadMajor,
    high: theme.roadMinorHigh,
    outline: theme.roadOutline,
  };
  const majorW = [[0, 0.36], [3, 0.52], [9, 1.1], [14, 2.05], [18, 3.3]];
  const highW = [[6, 0.46], [10, 0.8], [14, 1.48], [18, 2.7]];
  const highOv = [[0, 0.1], [4, 0.18], [8, 0.3], [11, 0.46]];
  const waterW = [[0, 0.2], [6, 0.34], [12, 0.8], [18, 2.4]];
  const railW = [[3, 0.4], [6, 0.7], [10, 1], [18, 1.5]];
  const src = 'openfreemap';
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round' };
  return {
    version: 8,
    sources: { [src]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', maxzoom: 14 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': land } },
      { id: 'park', type: 'fill', source: src, 'source-layer': 'park', paint: { 'fill-color': theme.parks } },
      { id: 'water', type: 'fill', source: src, 'source-layer': 'water', paint: { 'fill-color': theme.water } },
      {
        id: 'waterway', type: 'line', source: src, 'source-layer': 'waterway',
        filter: lineClass(['river', 'canal', 'stream', 'ditch']),
        paint: { 'line-color': theme.waterway, 'line-width': widthExpr(waterW) },
        layout: lineLayout,
      },
      {
        id: 'aeroway', type: 'fill', source: src, 'source-layer': 'aeroway',
        filter: ['match', ['geometry-type'], ['MultiPolygon', 'Polygon'], true, false],
        paint: { 'fill-color': theme.aeroway, 'fill-opacity': 0.85 },
      },
      {
        id: 'building', type: 'fill', source: src, 'source-layer': 'building', minzoom: 8,
        paint: { 'fill-color': theme.buildings, 'fill-opacity': 0.84 },
      },
      {
        id: 'rail', type: 'line', source: src, 'source-layer': 'transportation',
        filter: lineClass(['rail', 'transit']),
        paint: {
          'line-color': theme.rail,
          'line-width': widthExpr(railW),
          'line-opacity': opacityExpr([[0, 0.56], [12, 0.62], [18, 0.72]]),
          'line-dasharray': [2, 1.6],
        },
        layout: lineLayout,
      },
      {
        id: 'road-minor-overview-high', type: 'line', source: src, 'source-layer': 'transportation',
        minzoom: 0, maxzoom: 11.8, filter: lineClass(MINOR_HIGH),
        paint: {
          'line-color': roads.high,
          'line-width': widthExpr(highOv),
          'line-opacity': opacityExpr([[0, 0.66], [8, 0.76], [12, 0]]),
        },
        layout: lineLayout,
      },
      {
        id: 'road-major-casing', type: 'line', source: src, 'source-layer': 'transportation',
        filter: lineClass(MAJOR),
        paint: { 'line-color': roads.outline, 'line-width': widthExpr(majorW.map(([z, w]) => [z, w * 1.38])), 'line-opacity': 0.95 },
        layout: lineLayout,
      },
      {
        id: 'road-minor-high-casing', type: 'line', source: src, 'source-layer': 'transportation',
        minzoom: 6, filter: lineClass(MINOR_HIGH),
        paint: {
          'line-color': roads.outline,
          'line-width': widthExpr(highW.map(([z, w]) => [z, w * 1.45])),
          'line-opacity': cleanOpacity
            ? [...CLEAN_MINOR_HIGH_CASING_OPACITY]
            : opacityExpr([[6, 0.72], [12, 0.85], [18, 0.92]]),
        },
        layout: lineLayout,
      },
      {
        id: 'road-major', type: 'line', source: src, 'source-layer': 'transportation',
        filter: lineClass(MAJOR),
        paint: { 'line-color': roads.major, 'line-width': widthExpr(majorW) },
        layout: lineLayout,
      },
      {
        id: 'road-minor-high', type: 'line', source: src, 'source-layer': 'transportation',
        minzoom: 6, filter: lineClass(MINOR_HIGH),
        paint: {
          'line-color': roads.high,
          'line-width': widthExpr(highW),
          'line-opacity': cleanOpacity
            ? [...CLEAN_MINOR_HIGH_LINE_OPACITY]
            : opacityExpr([[6, 0.84], [10, 0.92], [18, 1]]),
        },
        layout: lineLayout,
      },
    ],
  };
}

function scaleWidths(style, factor) {
  const copy = JSON.parse(JSON.stringify(style));
  for (const layer of copy.layers) {
    const w = layer.paint?.['line-width'];
    if (w == null) continue;
    if (typeof w === 'number') layer.paint['line-width'] = w * factor;
    else if (Array.isArray(w) && w[0] === 'interpolate') {
      const out = w.slice();
      for (let i = 4; i < out.length; i += 2) out[i] = out[i] * factor;
      layer.paint['line-width'] = out;
    }
  }
  return copy;
}

function stillExtent(css, ratio) {
  return Math.trunc(Math.fround(Math.fround(css) * Math.fround(ratio)));
}

const tileCache = new Map();
function renderStill({ style, zoom, center, cssW, cssH, ratio }) {
  return new Promise((resolve, reject) => {
    const map = new mbgl.Map({
      request(req, callback) {
        const hit = tileCache.get(req.url);
        if (hit) { callback(null, { data: hit }); return; }
        fetch(req.url, { signal: AbortSignal.timeout(20_000) })
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${req.url}`); return r.arrayBuffer(); })
          .then((buf) => {
            const data = Buffer.from(buf);
            tileCache.set(req.url, data);
            callback(null, { data });
          })
          .catch((err) => callback(err));
      },
      ratio,
    });
    map.load(style);
    const timer = setTimeout(() => reject(new Error('still timeout')), 180_000);
    map.render({ zoom, center, width: cssW, height: cssH }, (err, buf) => {
      clearTimeout(timer);
      try { map.release(); } catch { /* already released */ }
      if (err) reject(err);
      else resolve(buf);
    });
  });
}

async function pngFromStill(buf, cssW, cssH, ratio, outW, outH) {
  const bw = stillExtent(cssW, ratio);
  const bh = stillExtent(cssH, ratio);
  if (buf.length !== bw * bh * 4) {
    throw new Error(`buffer ${buf.length} != ${bw}x${bh}`);
  }
  let pipeline = sharp(buf, { raw: { width: bw, height: bh, channels: 4 } });
  if (bw !== outW || bh !== outH) {
    pipeline = pipeline.resize(outW, outH, { kernel: 'lanczos3', fit: 'fill' });
  }
  return pipeline.flatten({ background: '#ffffff' }).png().toBuffer();
}

async function renderLocal(spec) {
  const buf = await renderStill(spec);
  return pngFromStill(buf, spec.cssW, spec.cssH, spec.ratio, spec.outW, spec.outH);
}

async function renderService(body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`service ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function labelStrip(width, height, lines) {
  const tspans = lines.map((line, i) =>
    `<tspan x="16" dy="${i === 0 ? 0 : 22}">${line}</tspan>`).join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#111"/>
    <text y="28" fill="#f5f5f0" font-family="DejaVu Sans, sans-serif" font-size="18">${tspans}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function stackCaption(png, captionLines) {
  const meta = await sharp(png).metadata();
  const barH = 28 + captionLines.length * 22;
  const bar = await labelStrip(meta.width, barH, captionLines);
  return sharp({
    create: { width: meta.width, height: meta.height + barH, channels: 3, background: '#111' },
  }).composite([
    { input: bar, top: 0, left: 0 },
    { input: png, top: barH, left: 0 },
  ]).png().toBuffer();
}

async function sideBySide(items) {
  const metas = await Promise.all(items.map((p) => sharp(p).metadata()));
  const h = Math.max(...metas.map((m) => m.height));
  const w = metas.reduce((s, m) => s + m.width, 0);
  let left = 0;
  const composite = [];
  for (let i = 0; i < items.length; i++) {
    composite.push({ input: items[i], top: 0, left });
    left += metas[i].width;
  }
  return sharp({
    create: { width: w, height: h, channels: 3, background: '#111' },
  }).composite(composite).png().toBuffer();
}

async function meanAbs(aPng, bPng) {
  const a = await sharp(aPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    throw new Error(`size mismatch ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
  }
  let sad = 0;
  const n = a.data.length;
  for (let i = 0; i < n; i++) sad += Math.abs(a.data[i] - b.data[i]);
  return sad / n;
}

function strokeRun(raw, width, height) {
  // Horizontal line: thickness is the vertical run through the centre column.
  const x = Math.floor(width / 2);
  let best = 0;
  let run = 0;
  for (let y = 0; y < height; y++) {
    const i = (y * width + x) * 4;
    const dark = raw[i] < 180 && raw[i + 1] < 180 && raw[i + 2] < 180;
    if (dark) run += 1;
    else { best = Math.max(best, run); run = 0; }
  }
  return Math.max(best, run);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(ART_DIR, { recursive: true });
  const themes = JSON.parse(readFileSync(new URL('../assets/themes.json', import.meta.url)));
  const byId = Object.fromEntries(themes.map((t) => [t.id, t.map]));

  const zoom = editorZoom(LISBON[1], INTERNAL_W, DISTANCE_M);
  const bounds = boundsForViewport(LISBON, zoom, INTERNAL_W, INTERNAL_H);
  const previewOut = { w: 900, h: 1200 };
  const posterOut = { w: 18 * 300, h: 24 * 300 };
  console.log(JSON.stringify({
    zoom, internal: [INTERNAL_W, INTERNAL_H], bounds,
    previewShiftedZoom: zoomForBounds(bounds, previewOut.w, previewOut.h),
    posterShiftedZoom: zoomForBounds(bounds, posterOut.w, posterOut.h),
  }, null, 2));

  // Gap 6 — fullbleed must paint the bottom ease-in, not a hard edge.
  const fadePng = await renderService({
    styleJson: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }] },
    center: LISBON, zoom: 2, width: 480, height: 640,
    showPosterText: false, displayCity: 'Lisbon', fadeStyle: 'fullbleed',
    includeCredits: false,
    theme: { ui: { bg: '#112233', text: '#112233' }, map: { land: '#ffffff', overlayBg: '#112233' } },
  });
  const fadeRaw = await sharp(fadePng).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * fadeRaw.info.width + x) * fadeRaw.info.channels;
    return [fadeRaw.data[i], fadeRaw.data[i + 1], fadeRaw.data[i + 2]];
  };
  const top = px(240, 40);
  const bottom = px(240, 620);
  console.log('fade sample top', top, 'bottom', bottom);
  if (bottom[2] < 40 || top[0] < 240) {
    throw new Error(`fullbleed fade did not draw: top=${top} bottom=${bottom}`);
  }
  await sharp(fadePng).toFile(`${ART_DIR}/print-parity-fullbleed-fade.png`);

  // Stroke weight, no tiles: stored width 4px (already the editor's boosted px).
  const lineStyle = {
    version: 8,
    sources: { g: { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-10, LISBON[1]], [-8, LISBON[1]]] }, properties: {} } } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
      { id: 'ln', type: 'line', source: 'g', paint: { 'line-color': '#000000', 'line-width': 4 } },
    ],
  };
  const lineBounds = boundsForViewport(LISBON, 12, 400, 200);
  const lineCam = resolvePrintCamera({ zoom: 12, bounds: lineBounds, outputWidth: 800, outputHeight: 400 });
  const lineEditor = await renderLocal({
    style: lineStyle, zoom: lineCam.zoom, center: LISBON,
    cssW: lineCam.cssWidth, cssH: lineCam.cssHeight, ratio: lineCam.pixelRatio,
    outW: 800, outH: 400,
  });
  const lineBeforeZoom = zoomForBounds(lineBounds, 800, 400);
  const lineBefore = await renderLocal({
    style: scaleWidths(lineStyle, 2.5), zoom: lineBeforeZoom, center: LISBON,
    cssW: 800, cssH: 400, ratio: 1, outW: 800, outH: 400,
  });
  const lineAfter = await renderService({
    styleJson: lineStyle, center: LISBON, zoom: 12, bounds: lineBounds,
    width: 800, height: 400, showPosterText: false, minorRoads: false,
  });
  async function measure(png) {
    const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return strokeRun(raw.data, raw.info.width, raw.info.height);
  }
  const strokes = {
    editor: await measure(lineEditor),
    before: await measure(lineBefore),
    after: await measure(lineAfter),
  };
  console.log('stroke px', strokes, 'camera', lineCam);
  await sideBySide([
    await stackCaption(lineEditor, ['Editor camera', `stroke ${strokes.editor}px`]),
    await stackCaption(lineBefore, ['Print before ×2.5', `stroke ${strokes.before}px`]),
    await stackCaption(lineAfter, ['Print after (service)', `stroke ${strokes.after}px`]),
  ]).then((png) => sharp(png).toFile(`${ART_DIR}/print-parity-stroke.png`));

  const previewRows = [];
  for (const id of THEMES) {
    const theme = byId[id];
    const seen = editorStyle(theme, { cleanOpacity: true });
    const saved = editorStyle(theme, { cleanOpacity: false });
    const cam = resolvePrintCamera({
      zoom, bounds, outputWidth: previewOut.w, outputHeight: previewOut.h,
    });
    console.log(id, 'preview camera', cam);
    const editorPng = await renderLocal({
      style: seen, zoom: cam.zoom, center: LISBON,
      cssW: cam.cssWidth, cssH: cam.cssHeight, ratio: cam.pixelRatio,
      outW: previewOut.w, outH: previewOut.h,
    });
    const shifted = zoomForBounds(bounds, previewOut.w, previewOut.h);
    const beforePng = await renderLocal({
      style: scaleWidths(seen, 2.5), zoom: shifted, center: LISBON,
      cssW: previewOut.w, cssH: previewOut.h, ratio: 1,
      outW: previewOut.w, outH: previewOut.h,
    });
    const afterPng = await renderService({
      styleJson: saved, center: LISBON, zoom, bounds,
      width: previewOut.w, height: previewOut.h,
      showPosterText: false, minorRoads: false,
    });
    const diff = await meanAbs(editorPng, afterPng);
    console.log(id, 'editor vs service mean abs', diff.toFixed(3));
    if (diff > 8) throw new Error(`${id} service diverged from editor (mean abs ${diff})`);
    const row = await sideBySide([
      await stackCaption(editorPng, [id, 'Editor', `zoom ${zoom.toFixed(2)}`]),
      await stackCaption(beforePng, [id, 'Print before', `zoom ${shifted.toFixed(2)} ×2.5`]),
      await stackCaption(afterPng, [id, 'Print after', `zoom ${cam.zoom.toFixed(2)} ratio ${cam.pixelRatio.toFixed(2)}`]),
    ]);
    await sharp(row).toFile(`${OUT_DIR}/${id}-preview.png`);
    previewRows.push(row);
  }
  const previewSheet = await (async () => {
    const metas = await Promise.all(previewRows.map((p) => sharp(p).metadata()));
    const w = Math.max(...metas.map((m) => m.width));
    const h = metas.reduce((s, m) => s + m.height, 0);
    let top = 0;
    const composite = [];
    for (let i = 0; i < previewRows.length; i++) {
      composite.push({ input: previewRows[i], top, left: 0 });
      top += metas[i].height;
    }
    return sharp({ create: { width: w, height: h, channels: 3, background: '#111' } })
      .composite(composite).png().toBuffer();
  })();
  await sharp(previewSheet).toFile(`${ART_DIR}/print-parity-lisbon-preview.png`);

  // 18×24 in at 300 DPI, vintage noir only. Service is the "after" file.
  const theme = byId.vintage_noir;
  const seen = editorStyle(theme, { cleanOpacity: true });
  const saved = editorStyle(theme, { cleanOpacity: false });
  const posterCam = resolvePrintCamera({
    zoom, bounds, outputWidth: posterOut.w, outputHeight: posterOut.h,
  });
  console.log('poster camera', posterCam);
  const posterEditor = await renderLocal({
    style: seen, zoom: posterCam.zoom, center: LISBON,
    cssW: posterCam.cssWidth, cssH: posterCam.cssHeight, ratio: posterCam.pixelRatio,
    outW: posterOut.w, outH: posterOut.h,
  });
  const posterShift = zoomForBounds(bounds, posterOut.w, posterOut.h);
  const posterBefore = await renderLocal({
    style: scaleWidths(seen, 2.5), zoom: posterShift, center: LISBON,
    cssW: posterOut.w, cssH: posterOut.h, ratio: 1,
    outW: posterOut.w, outH: posterOut.h,
  });
  const posterAfter = await renderService({
    styleJson: saved, center: LISBON, zoom, bounds,
    width: posterOut.w, height: posterOut.h,
    showPosterText: false, minorRoads: false,
  });
  const posterDiff = await meanAbs(posterEditor, posterAfter);
  console.log('poster editor vs service mean abs', posterDiff.toFixed(3));
  if (posterDiff > 8) throw new Error(`poster diverged (mean abs ${posterDiff})`);

  async function fitHeight(png, height) {
    return sharp(png).resize({ height, fit: 'inside' }).png().toBuffer();
  }
  const posterContact = await sideBySide([
    await stackCaption(await fitHeight(posterEditor, 1100), ['vintage_noir 18×24in 300 DPI', 'Editor']),
    await stackCaption(await fitHeight(posterBefore, 1100), ['Print before', `zoom ${posterShift.toFixed(2)} ×2.5`]),
    await stackCaption(await fitHeight(posterAfter, 1100), ['Print after', `zoom ${zoom.toFixed(2)}`]),
  ]);
  await sharp(posterContact).toFile(`${ART_DIR}/print-parity-lisbon-18x24.png`);

  const crop = async (png) => sharp(png)
    .extract({ left: Math.floor(posterOut.w / 2) - 350, top: Math.floor(posterOut.h / 2) - 250, width: 700, height: 500 })
    .png().toBuffer();
  const cropSheet = await sideBySide([
    await stackCaption(await crop(posterEditor), ['Center 1:1', 'Editor']),
    await stackCaption(await crop(posterBefore), ['Center 1:1', 'Print before']),
    await stackCaption(await crop(posterAfter), ['Center 1:1', 'Print after']),
  ]);
  await sharp(cropSheet).toFile(`${ART_DIR}/print-parity-lisbon-18x24-center.png`);

  // Sanity: preparePrintStyle on the saved style matches the seen opacity.
  const prepared = preparePrintStyle(saved, { minorRoads: false });
  const high = prepared.layers.find((l) => l.id === 'road-minor-high');
  if (JSON.stringify(high.paint['line-opacity']) !== JSON.stringify([...CLEAN_MINOR_HIGH_LINE_OPACITY])) {
    throw new Error('preparePrintStyle did not install the clean curve');
  }
  console.log('done', { strokes, posterDiff });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
