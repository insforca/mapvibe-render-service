// Run in a fresh process: Windows Pango needs Fontconfig env before DLL loading.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createCanvas, registerFont } = require('canvas');
function loadTs(file) {
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = module.paths;
  mod.require = spec => spec.startsWith('.')
    ? loadTs(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')))
    : require(spec);
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, file);
  return mod.exports;
}
const { BUNDLED_FONTS } = loadTs(path.resolve('src/bundled-fonts.ts'));
const { drawPosterText, compositePosterOverlay, measureInkCoverage, layoutPosterText, applyFades } = loadTs(path.resolve('src/poster-text.ts'));
for (const { family, weight, staticFile } of BUNDLED_FONTS) {
  registerFont(path.resolve('assets/fonts', staticFile), { family, weight });
}
const canvas = createCanvas(400, 150), ctx = canvas.getContext('2d');
const sheet = require('./space-plex-sheet.json');
const fonts = ['700 62.46px "Space Grotesk"', '300 22.95px "IBM Plex Mono Light"'];
const widths = fonts.map((font, i) => {
  ctx.font = font;
  const text = i ? 'UNITED STATES' : 'NEW YORK';
  return {
    whole: ctx.measureText(text).width,
    // Browser canvas shapes words separately; Pango kerns across spaces.
    words: text.split(/( )/).reduce((n, word) => n + ctx.measureText(word).width, 0),
    pairs: ['W ', ' Y'].map(pair => ctx.measureText(pair).width
      - [...pair].reduce((n, ch) => n + ctx.measureText(ch).width, 0)),
  };
});
const fingerprints = sheet.fingerprints.map((f, i) => {
  const face = BUNDLED_FONTS[i];
  ctx.font = `${face.weight} ${f.size}px "${face.family}"`;
  return ctx.measureText(f.sample).width;
});
const density = [300, 400].map(weight => {
  ctx.clearRect(0, 0, 400, 150);
  ctx.font = `${weight} 80px "IBM Plex Mono${weight === 300 ? ' Light' : ''}"`;
  ctx.fillText('HAMBURG', 0, 100);
  const pixels = ctx.getImageData(0, 0, 400, 150).data;
  let alpha = 0;
  for (let i = 3; i < pixels.length; i += 4) alpha += pixels[i];
  return alpha;
});
const draws = {};
for (const id of [undefined, 'roboto', 'space-plex', 'picker-over-space-plex', 'blank-picker']) {
  const picker = id === 'picker-over-space-plex';
  const blank = id === 'blank-picker';
  const calls = [];
  const capture = new Proxy(ctx, {
    get(target, key) {
      if (key === 'fillText') return text => calls.push({ text, font: target.font });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  drawPosterText(capture, 900, 1200, {}, 40.7128, -74.006, 'NEW YORK',
    'UNITED STATES', picker ? 'Lato' : blank ? '   ' : '', true, true, 'centered', (picker || blank) ? 'space-plex' : id);
  draws[id ?? 'absent'] = calls;
}


const legacyHashes = [];
for (const id of [undefined, 'space-plex']) for (const textLayout of ['centered', 'editorial']) for (const showText of [false, true]) {
  const c = createCanvas(900, 1200), x = c.getContext('2d');
  x.fillStyle = '#172434'; x.fillRect(0, 0, 900, 1200);
  drawPosterText(x, 900, 1200, { map: { land: '#172434' }, ui: { text: '#ffffff' } },
    40.7128, -74.006, 'NEW YORK', 'UNITED STATES', '', showText, true, textLayout, id);
  legacyHashes.push(require('node:crypto').createHash('sha256').update(c.toBuffer('raw')).digest('hex'));
}

const v2 = { layouts: [], ink: {}, calls: {}, parity: [] };
// Full print geometry with a one-column backing keeps native memory low.
// Real font outlines and the real canvas gradient are used at every size.
v2.fadeSamples = [];
for (const [width, height] of [[240, 320], [5400, 7200], [240, 339], [9933, 14043]]) {
  for (const first of ['city', 'country', 'coords']) {
    const c = createCanvas(1, height), x = c.getContext('2d');
    let layout;
    drawPosterText(x, width, height, {}, -33.8688, 151.2093, 'NEW YORK', 'UNITED STATES', '',
      true, false, 'centered', 'space-plex', { lockupLayout: 'v2',
        showCity: first === 'city', showCountry: first !== 'coords', showCoords: true }, l => { layout = l; });
    x.clearRect(0, 0, 1, height);
    applyFades(x, width, height, '#ffffff', 'fullbleed', 'centered', layout.textFadeTop, layout.textInkTop);
    const sample = y => x.getImageData(0, Math.floor(y), 1, 1).data[3] / 255;
    v2.fadeSamples.push({ width, height, first, alpha: sample(layout.textInkTop),
      above: sample(layout.textFadeTop - 1), bottom: sample(height - 1),
      clearance: layout.textInkTop - layout.textFadeTop, ascent: layout[first].ascent,
      inkTop: layout.textInkTop, expectedInkTop: layout[first].y - layout[first].ascent });
  }
}
v2.stress = BUNDLED_FONTS.map(face => layoutPosterText({ width: 100, height: 134,
  city: 'NEW YORK', country: 'UNITED STATES', coords: '-33.8688? S / 151.2093? E', lockupLayout: 'v2',
  glyph(role, text, size) {
    ctx.font = face.weight + ' ' + size + 'px "' + face.family + '"';
    return { width: [...text].reduce((sum, ch) => sum + ctx.measureText(ch).width, 0), ascent: size * .7, descent: 0 };
  } }));
for (const fontFamily of ['', 'Roboto', 'Lato', 'Noto Sans JP']) {
  for (const id of ['space-plex', 'roboto']) {
    const c = createCanvas(100, 134), x = c.getContext('2d');
    drawPosterText(x, 100, 134, {}, -33.8688, 151.2093, 'SAINT PETERSBURG', 'AUSTRALIA', fontFamily,
      true, false, 'centered', id, { lockupLayout: 'v2' }, layout => v2.layouts.push({ fontFamily, id, layout }));
  }
}
for (const role of ['city', 'country', 'coords']) {
  const c = createCanvas(900, 1200), x = c.getContext('2d'), calls = [];
  const proxy = new Proxy(x, {
    get(target, key) {
      if (key === 'fillText') return (text, ...args) => {
        if (text.includes('contributors')) return;
        calls.push({ font: target.font, alpha: target.globalAlpha, color: target.fillStyle });
        target.fillText(text, ...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  drawPosterText(proxy, 900, 1200, { map: { land: '#172434' }, ui: { text: '#ffffff' } },
    -33.8688, 151.2093, 'NEW YORK', 'UNITED STATES', '', true, false, 'centered', 'space-plex',
    { lockupLayout: 'v2', showCity: role === 'city', showCountry: role === 'country', showCoords: role === 'coords' });
  v2.ink[role] = measureInkCoverage(x.getImageData(0, 0, 900, 1200).data);
  v2.calls[role] = calls.filter(c => c.font.startsWith(role === 'city' ? '700' : role === 'country' ? '300' : '400'));
}
for (let mask = 0; mask < 16; mask++) {
  const overlay = { lockupLayout: 'v2', lockupFont: 'space-plex', displayCity: 'NEW YORK', displayCountry: 'UNITED STATES',
    showCity: !!(mask & 4), showCountry: !!(mask & 2), showCoords: !!(mask & 1), showPosterText: !!(mask & 8),
    theme: { map: { land: '#172434', overlayBg: '#172434', fade: '#abcdef' }, ui: { text: '#ffffff' } } };
  const render = (legacyColor, legacyStyle) => {
    const c = createCanvas(240, 320), x = c.getContext('2d');
    x.fillStyle = '#66839b'; x.fillRect(0, 0, 240, 320);
    compositePosterOverlay(x, 240, 320, overlay, 40.7128, -74.006, legacyColor, legacyStyle);
    return c.toBuffer('raw');
  };
  v2.parity.push(render('#172434', 'default').equals(render('#abcdef', 'fullbleed')));
}

(async () => {
  // Execute both actual server render functions. Only the map framebuffer is fake;
  // canvas, fonts, Sharp stitching and the production PNG encoder are real/offline.
  const source = fs.readFileSync('src/server.ts', 'utf8');
  const singleStart = source.indexOf('async function renderPngInternal(');
  const singleEnd = source.indexOf('// ', source.indexOf('return pngBuf;', singleStart));
  const tiledStart = source.indexOf('function mercLatToY(');
  const tiledEnd = source.indexOf('// ', source.indexOf('return pngBuf;', tiledStart));
  const sandbox = {
    Buffer, Uint8ClampedArray, Date, setTimeout, clearTimeout, process: { env: {} },
    console: { log() {}, warn() {} }, createCanvas, compositePosterOverlay,
    encodePrintPng: loadTs(path.resolve('src/print-png.ts')).encodePrintPng,
    sharp: require('sharp'), ensureFont: async () => {}, preparePrintStyle: s => s,
    MAX_RENDER_PX_WH: 14400, MAX_PX: 14400 ** 2, MAX_ZOOM_RENDER: 20,
    resolvePrintCamera: p => ({ zoom: 12, cssWidth: p.outputWidth, cssHeight: p.outputHeight,
      bufferWidth: p.outputWidth, bufferHeight: p.outputHeight, pixelRatio: 1, source: 'fixture' }),
    mbgl: { Map: class {
      load() {} release() {}
      render(p, cb) {
        const data = Buffer.alloc(p.width * p.height * 4);
        for (let i = 0; i < data.length; i += 4) { data[i] = 102; data[i+1] = 131; data[i+2] = 155; data[i+3] = 255; }
        cb(null, data);
      }
    } },
  };
  const code = source.slice(singleStart, singleEnd) + source.slice(tiledStart, tiledEnd)
    + '\nglobalThis.api = { renderPngInternal, renderTiledPng };';
  require('node:vm').runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, sandbox);
  v2.serverParity = [];
  for (const fontFamily of ['', 'Lato', 'Roboto']) for (let mask = 0; mask < 16; mask++) {
    const params = { width: 240, height: 320, center: [-74.006, 40.7128], zoom: 12,
      bounds: { west: -75, east: -73, north: 42, south: 40 }, styleJson: {}, printMode: true,
      overlay: { lockupLayout: 'v2', lockupFont: 'space-plex', fontFamily, displayCity: 'NEW YORK', displayCountry: 'UNITED STATES',
        showCity: !!(mask & 4), showCountry: !!(mask & 2), showCoords: !!(mask & 1), showPosterText: !!(mask & 8),
        theme: { map: { overlayBg: '#172434', fade: '#abcdef' }, ui: { text: '#ffffff' } } } };
    const single = await sandbox.api.renderPngInternal(params);
    const tiled = await sandbox.api.renderTiledPng(params, 240, 320, 2);
    v2.serverParity.push(single.equals(tiled));
  }
  console.log(JSON.stringify({ widths, fingerprints, density, draws, legacyHashes, v2 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
