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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, file);
  return mod.exports;
}
const { BUNDLED_FONTS } = loadTs(path.resolve('src/bundled-fonts.ts'));
const { drawPosterText } = loadTs(path.resolve('src/poster-text.ts'));
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
console.log(JSON.stringify({ widths, fingerprints, density, draws }));
