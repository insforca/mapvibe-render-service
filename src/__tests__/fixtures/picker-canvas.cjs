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

const { PICKER_FONTS, pickerFamily } = loadTs(path.resolve('src/picker-fonts.ts'));
const ctx = createCanvas(1200, 200).getContext('2d');
const latinSample = 'Hamburgefonts0123456789';
const fingerprints = PICKER_FONTS.flatMap(font => font.faces.map(face => {
 const sample = latinSample + (face.staticFile.endsWith('.otf') ? '\u6771\u4eac\u65e5\u672c\u8a9e\u304b\u306a\u30ab\u30ca' : '');
 ctx.font = face.weight + ' 100px "' + face.family + '"';
 const advances = [...sample].map(ch => ctx.measureText(ch).width);
 ctx.clearRect(0, 0, 1200, 200);
 ctx.fillText(face.staticFile.endsWith('.otf') ? '\u6771\u4eac\u65e5\u672c\u8a9e\u304b\u306a\u30ab\u30ca' : latinSample, 0, 120);
 const pixels = ctx.getImageData(0, 0, 1200, 200).data;
 let density = 0;
 for (let i = 3; i < pixels.length; i += 4) density += pixels[i] / 255;
 return { sample, density, file: face.staticFile, family: face.family, weight: face.weight, advances };
}));
const draws = {};
for (const font of [...PICKER_FONTS.map(f => f.value), 'bEbAs NeUe', 'Unknown Font']) {
 const calls = [];
 const capture = new Proxy(ctx, {
  get(target,key) { if(key === 'fillText') return text => calls.push({text, font:target.font});
   const v=Reflect.get(target,key,target); return typeof v === 'function' ? v.bind(target) : v; },
  set(target,key,value) {target[key]=value;return true;}
 });
 drawPosterText(capture,900,1200,{},40.7128,-74.006,'NEW YORK','UNITED STATES',font,true,true,'centered','space-plex');
 draws[font]=calls;
}
console.log(JSON.stringify({fingerprints,draws}));
