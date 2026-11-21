import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import opentype from 'opentype.js';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'out');
await mkdir(out, { recursive: true });
// The Windows canvas build defaults to a Win32 Pango backend that can silently
// ignore FR_PRIVATE fonts. Use the bundled Fontconfig/FreeType backend instead,
// as on the Linux print service, with an isolated set of local font directories.
if (process.platform === 'win32') {
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const config = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${['assets/fonts','fonts','scripts/font-sheet/fonts'].map(p=>`<dir>${xml(path.join(root,p).replaceAll('\\','/'))}</dir>`).join('')}<cachedir>${xml(path.join(out,'font-cache').replaceAll('\\','/'))}</cachedir><alias><family>DM Sans 9pt</family><prefer><family>DM Sans</family></prefer></alias></fontconfig>`;
  await writeFile(path.join(out, 'fonts.conf'), config);
  process.env.PANGOCAIRO_BACKEND = 'fc';
  process.env.FONTCONFIG_FILE = path.join(out, 'fonts.conf');
  // Windows DLL CRT getenv() needs these inherited at process creation.
  if (process.env.FONT_SHEET_FC_BOOTSTRAPPED !== '1') {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, FONT_SHEET_FC_BOOTSTRAPPED: '1' } });
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  }
}
const { createCanvas, registerFont, loadImage } = require('canvas');
// Transpile only the two pure local modules, never import server.ts.
for (const name of ['print-parity', 'poster-text']) {
  const source = await readFile(path.join(root, `src/${name}.ts`), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  await writeFile(path.join(out, `${name}.mjs`), js.replaceAll('./print-parity.js', './print-parity.mjs'));
}
const { drawPosterText, layoutPosterText } = await import(pathToFileURL(path.join(out, 'poster-text.mjs')));
const W = 900, H = 1200;
const city = 'NEW YORK', country = 'UNITED STATES', coords = '40.7128° N / 74.0060° W';
const samples = ['São Paulo', 'Zürich', 'Kraków', 'Reykjavík'];
const local = f => path.join(root, f);
const downloaded = f => path.join(here, 'fonts', f);
const options = [
  { id: 'roboto', name: 'Roboto', licence: 'Apache 2.0 (checked-in files)', faces: [local('assets/fonts/Roboto-Bold.ttf'), local('assets/fonts/Roboto-Light.ttf'), local('assets/fonts/Roboto-Regular.ttf')] },
  { id: 'space-plex', name: 'Space Grotesk + IBM Plex Mono', licence: 'SIL OFL 1.1', faces: ['SpaceGrotesk-Bold.ttf', 'IBMPlexMono-Light.ttf', 'IBMPlexMono-Regular.ttf'].map(downloaded) },
  { id: 'montserrat', name: 'Montserrat', licence: 'SIL OFL 1.1', faces: ['Montserrat-Bold.ttf', 'Montserrat-Light.ttf', 'Montserrat-Regular.ttf'].map(downloaded) },
  // DM Sans Regular is intentionally used at both 300 and 400: it is the existing body file.
  { id: 'playfair-dm', name: 'Playfair Display + DM Sans', licence: 'SIL OFL 1.1', faces: [local('fonts/PlayfairDisplay-Bold.ttf'), local('fonts/DMSans-Regular.ttf'), local('fonts/DMSans-Regular.ttf')] },
];
const roles = ['city', 'country', 'coords'], weights = [700, 300, 400];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fontInfo = async file => {
  const bytes = await readFile(file);
  const f = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const name = key => f.names.windows?.[key]?.en || f.names.macintosh?.[key]?.en || f.names[key]?.en || null;
  return { file: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes), family: name('fontFamily'), licence: name('license'), licenceURL: name('licenseURL'), variableAxes: f.tables.fvar?.axes || [], unitsPerEm: f.unitsPerEm, ascender: f.ascender, descender: f.descender,
    coverage: Object.fromEntries(samples.map(s => [s, { original: [...s].every(c => f.charToGlyphIndex(c) !== 0), uppercase: [...s.toUpperCase()].every(c => f.charToGlyphIndex(c) !== 0), missing: [...new Set(s + s.toUpperCase())].filter(c => f.charToGlyphIndex(c) === 0) }])) };
};
// One deterministic raster fixture is reused byte-for-byte on both sides.
const fixture = createCanvas(W, H), fc = fixture.getContext('2d');
fc.fillStyle = '#f5f1e8'; fc.fillRect(0, 0, W, H);
fc.fillStyle = '#c8dfe3'; fc.beginPath(); fc.moveTo(0, 570); fc.bezierCurveTo(360, 350, 370, 750, 900, 300); fc.lineTo(900, 440); fc.bezierCurveTo(400, 880, 340, 510, 0, 740); fc.fill();
fc.save(); fc.beginPath(); fc.rect(0, 0, W, 890); fc.clip();
fc.strokeStyle = '#fffdfa'; fc.lineWidth = 11;
for (let x = -600; x < 1500; x += 80) { fc.beginPath(); fc.moveTo(x, 0); fc.lineTo(x + 480, 890); fc.stroke(); }
for (let y = -300; y < 1300; y += 65) { fc.beginPath(); fc.moveTo(0, y); fc.lineTo(W, y - 350); fc.stroke(); }
fc.fillStyle = '#d6dfc6'; fc.fillRect(570, 170, 115, 190); fc.restore();
const fixtureBytes = fixture.toBuffer('image/png');
await writeFile(path.join(out, 'fixture.png'), fixtureBytes);
const fixtureURI = `data:image/png;base64,${fixtureBytes.toString('base64')}`;
const browsers = [{ id: 'chrome', executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', required: true }, { id: 'edge', executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' }];
const launched = [];
const results = { dimensions: { width: W, height: H }, fixture: 'Generated schematic; no geographic data or tiles', method: 'Raw RGB: changed if any channel differs; MAE is mean absolute RGB error on 0–255. Full poster and text strip ROI reported separately. Diff is 4x RGB absolute difference. Browser is native DOM text, deviceScaleFactor=1.', browserVersions: {}, options: [] };
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const pngURI = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
function diff(a, b, top) {
  const d = createCanvas(W, H), ctx = d.getContext('2d'), id = ctx.createImageData(W, H);
  let changed = 0, sum = 0, roiChanged = 0, roiSum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let isChanged = false, delta = 0;
    for (let c = 0; c < 3; c++) { const x = Math.abs(a[i+c] - b[i+c]); delta += x; isChanged ||= x !== 0; id.data[i+c] = Math.min(255, x*4); }
    id.data[i+3] = 255;
    changed += +isChanged; sum += delta;
    if (Math.floor(i / 4 / W) >= top) { roiChanged += +isChanged; roiSum += delta; }
  }
  ctx.putImageData(id, 0, 0);
  return { png: d.toBuffer('image/png'), changedPixelPercent: changed / (W*H)*100, mae: sum / (W*H*3), textStrip: { top, changedPixelPercent: roiChanged / (W*(H-top))*100, mae: roiSum / (W*(H-top)*3) } };
}
{
  for (const b of browsers) {
    try { await access(b.executablePath); } catch (e) { if (b.required) throw e; results.browserVersions[b.id] = 'not installed'; continue; }
    launched.push(b);
  }
  for (const [index, option] of options.entries()) {
    const family = `FontSheet${index}`;
    const infos = await Promise.all(option.faces.map(fontInfo));
    const aliases = roles.map((r,i) => `${family}_${roles[option.faces.indexOf(option.faces[i])]}`);
    for (const file of new Set(option.faces)) {
      const i = option.faces.indexOf(file);
      registerFont(file, { family: aliases[i], weight: String(weights[i]), style: 'normal' });
    }
    // Detect silent fallback using a font-file hmtx fingerprint (no kerning).
    const probe = createCanvas(1,1).getContext('2d');
    for (let i=0;i<3;i++) {
      const bytes=await readFile(option.faces[i]);
      const font=opentype.parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      const sample='HHHHHH000000';
      const axes=font.tables.fvar?.axes || [];
      const variation=Object.fromEntries(axes.map(a=>[a.tag,a.tag==='opsz'?Math.min(a.maxValue,Math.max(a.minValue,100)):a.defaultValue]));
      const expected=[...sample].reduce((n,c)=>{
        const glyph=font.charToGlyph(c);
        return n+(axes.length?font.variation.getTransform(glyph,variation):glyph).advanceWidth;
      },0)*100/font.unitsPerEm;
      probe.font=`${weights[i]} 100px "${aliases[i]}"`;
      const actual=probe.measureText(sample).width;
      if(Math.abs(expected-actual)>.2) throw new Error(`Font fingerprint failed for ${option.id}/${roles[i]}: ${actual} vs ${expected}; possible fallback or unsupported variation`);
      infos[i].loadFingerprint={sample,size:100,variation,expected,actual};
    }
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
    ctx.drawImage(fixture, 0, 0);
    // Capture precisely the glyph measurements consumed by the service's layout.
    const measured = {};
    const layout = layoutPosterText({ width: W, height: H, city, country, coords, glyph(role, text, size) {
      ctx.font = `${weights[roles.indexOf(role)]} ${size}px "${aliases[roles.indexOf(role)]}"`;
      const m = ctx.measureText(text);
      measured[role] = m.width;
      return { width: m.width, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
    } });
    // Keep the service's measurement/drawing code intact. Route its single
    // family shorthand to one exact registered face per weight. A shared alias
    // lets Pango collapse Light/Regular or cross-family faces on this platform.
    const drawingContext = new Proxy(ctx, {
      get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
      set(target, key, value) {
        if (key === 'font') {
          const match = /^(700|300|400) ([\d.]+)px /.exec(value);
          if (!match) throw new Error(`Unexpected service font: ${value}`);
          value = `${match[1]} ${match[2]}px "${aliases[weights.indexOf(Number(match[1]))]}"`;
        }
        Reflect.set(target, key, value, target); return true;
      },
    });
    drawPosterText(drawingContext, W, H, { map: { land: '#f5f1e8' }, ui: { text: '#111111' } }, 40.7128, -74.006, city, country, family, true, false, 'classic');
    const print = canvas.toBuffer('image/png');
    await writeFile(path.join(out, `${option.id}-print.png`), print);
    const row = { id: option.id, name: option.name, licence: option.licence, fonts: infos, totalUniqueFontBytes: [...new Set(option.faces)].reduce((n, f) => n + infos[option.faces.indexOf(f)].bytes, 0), print: { widths: Object.fromEntries(roles.map(r => [r, { advance: measured[r], drawn: layout[r].width, cssInline: layout[r].width + layout[r].spacing * layout[r].size }])), layout }, pairs: {} };
    const facesCSS = option.faces.map((f, i) => `@font-face{font-family:${family};src:url("${pathToFileURL(f).href}") format("truetype");font-weight:${weights[i]};font-style:normal;font-display:block}`).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><style>${facesCSS}
      *{box-sizing:border-box}html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}#poster{position:relative;width:${W}px;height:${H}px;background:url('${fixtureURI}');color:#111}#strip{position:absolute;bottom:0;width:100%;padding:${6*W/482.390625}px ${18*W/482.390625}px ${14*W/482.390625}px;text-align:center}p{padding:0;line-height:1.15;font-family:${family};font-synthesis:none}#city{font-weight:700;letter-spacing:.45em;margin:0 0 ${3*W/482.390625}px}#divider{border-top:${W/482.390625}px solid #111;width:20%;margin:0 auto ${4*W/482.390625}px}#country{font-weight:300;margin:0 0 ${3*W/482.390625}px}#coords{font-weight:400;margin:1em 0;opacity:.7}#credit{position:absolute;inset:0;pointer-events:none}</style><div id="poster"><div id="strip"><p id="city"><span>${city}</span></p><div id="divider"></div><p id="country"><span>${country}</span></p><p id="coords"><span>${coords}</span></p></div><canvas id="credit" width="${W}" height="${H}"></canvas></div>`;
    const file = path.join(out, `${option.id}-browser.html`);
    await writeFile(file, html);
    // Keep only one browser process alive, including during failures.
    for (const { id, executablePath } of launched) {
      const browser = await chromium.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files', '--force-color-profile=srgb'] });
      try {
      results.browserVersions[id] = browser.version();
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      // Only local resources are permitted, including fonts. Fail any unexpected network request.
      const network = [];
      await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      const browserMetrics = await page.evaluate(async ({ family, W, H, city, country, coords }) => {
        await Promise.all([700,300,400].map(w => document.fonts.load(`${w} 40px ${family}`)));
        await document.fonts.ready;
        if (document.fonts.status !== 'loaded' || [...document.fonts].some(f => f.status !== 'loaded')) throw new Error('Font load failed');
        const ctx = document.createElement('canvas').getContext('2d');
        const widths = {}, data = [['city',city,700,.0694,.45],['country',country,300,.0255,0],['coords',coords,400,.0162,0]];
        const pad = 18*W/482.390625;
        for (const [role,text,weight,fraction,spacing] of data) {
          let size = fraction*W;
          if(role === 'city') {
            const min = 110*W/3600, n = text.length;
            if(n>10) size=Math.max(min,size*10/n);
            const est=n*.62+(n-1)*spacing;
            if(est*size>3600*.92) size=Math.max(min,3600*.92/est);
          }
          ctx.font = `${weight} ${size}px ${family}`;
          const inline=ctx.measureText(text).width+spacing*size*text.length;
          if(inline>W-2*pad) size *= (W-2*pad)/inline;
          document.getElementById(role).style.fontSize=`${size}px`;
          ctx.font=`${weight} ${size}px ${family}`;
          const span=document.querySelector(`#${role} span`), rect=span.getBoundingClientRect();
          widths[role]={advance:ctx.measureText(text).width,cssInline:rect.width,drawn:rect.width-spacing*size,size,spanTop:rect.top,lineBoxTop:document.getElementById(role).getBoundingClientRect().top};
        }
        const credit=document.getElementById('credit').getContext('2d');
        credit.font=`300 ${30*W/3600}px ${family}`; credit.fillStyle='#0e1822';credit.globalAlpha=.9;credit.textAlign='right';credit.textBaseline='bottom';
        credit.fillText('© OpenStreetMap contributors',W*.98,H-6*W/482.390625);
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        // Vertical positions must be sampled after ALL role sizes are assigned.
        for(const [role] of data){
          widths[role].spanTop=document.querySelector(`#${role} span`).getBoundingClientRect().top;
          widths[role].lineBoxTop=document.getElementById(role).getBoundingClientRect().top;
        }
        return {widths,stripTop:document.getElementById('strip').getBoundingClientRect().top,dividerBorderPx:parseFloat(getComputedStyle(document.getElementById('divider')).borderTopWidth),fonts:[...document.fonts].map(f=>({family:f.family,weight:f.weight,status:f.status}))};
      }, { family, W, H, city, country, coords });
      if (network.length) throw new Error(`Unexpected network access: ${network.join(', ')}`);
      const png = await page.screenshot({ type: 'png' });
      await writeFile(path.join(out, `${option.id}-${id}.png`), png);
      const image = await loadImage(png), bc = createCanvas(W,H), bctx = bc.getContext('2d'); bctx.drawImage(image,0,0);
      const comparison = diff(ctx.getImageData(0,0,W,H).data,bctx.getImageData(0,0,W,H).data,Math.floor(Math.min(layout.stripTop,browserMetrics.stripTop)));
      await writeFile(path.join(out, `${option.id}-${id}-diff.png`),comparison.png);
      row.pairs[id] = { ...comparison, png: undefined, browser:browserMetrics, widthDelta: Object.fromEntries(roles.map(r=>[r,browserMetrics.widths[r].advance-measured[r]])) };
      option[id] = pngURI(png); option[`${id}Diff`] = pngURI(comparison.png);
      await page.close();
      } finally { await browser.close(); }
    }
    option.print = pngURI(print);
    results.options.push(row);
    console.log(`${option.name}: Chrome ${row.pairs.chrome.changedPixelPercent.toFixed(4)}% changed, MAE ${row.pairs.chrome.mae.toFixed(6)}`);
  }
}
await writeFile(path.join(out,'metrics.json'),JSON.stringify(results,null,2)+'\n');
const table = browser => `<table><thead><tr><th>${browser === 'chrome' ? 'Chrome' : 'Edge'}</th><th>Print (node-canvas)</th><th>Diff (4×)</th></tr></thead><tbody>${options.map((o,i)=>{const r=results.options[i],p=r.pairs[browser];return `<tr><th colspan="3">${esc(o.name)} — ${o.licence}</th></tr><tr>${[o[browser],o.print,o[`${browser}Diff`]].map(src=>`<td><img src="${src}" width="900" height="1200"></td>`).join('')}</tr><tr><td colspan="3">${p.changedPixelPercent.toFixed(4)}% pixels changed; MAE ${p.mae.toFixed(6)}/255. Text strip: ${p.textStrip.changedPixelPercent.toFixed(3)}%, MAE ${p.textStrip.mae.toFixed(4)}. City advance ${p.browser.widths.city.advance.toFixed(3)} browser / ${r.print.widths.city.advance.toFixed(3)} print px; country ${p.browser.widths.country.advance.toFixed(3)} / ${r.print.widths.country.advance.toFixed(3)} px. Unique files ${(r.totalUniqueFontBytes/1024).toFixed(1)} KiB. Accent coverage: ${r.fonts.every(f=>Object.values(f.coverage).every(c=>c.original&&c.uppercase))?'all four samples and uppercase covered':'see metrics.json'}.</td></tr>`}).join('')}</tbody></table>`;
await writeFile(path.join(out,'sheet.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Poster font comparison</title><style>body{margin:24px;background:#e9e9e9;color:#222;font:15px system-ui}table{width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:40px}td,th{padding:10px;text-align:left;vertical-align:top}img{display:block;width:100%;height:auto}h1{font-size:26px}p{max-width:1000px}th{background:#ddd}td{background:#fafafa}details{margin-top:30px}</style><h1>Self-hosted poster font comparison</h1><p>900 × 1200 px, same TTF bytes in browser and print. Native browser DOM uses the desktop rules mirrored by poster-text.ts. Print calls the unmodified service drawing function. Schematic background generated locally. No map tiles or service calls. Images are embedded; open offline. Browser versions: ${esc(JSON.stringify(results.browserVersions))}.</p><p>Raw changed-pixel percentage counts any RGB difference; MAE is mean absolute RGB error (0–255). Full-page scores are diluted by the identical background, so text-strip scores are also shown. Difference images amplify differences 4×. Pixel identity is not guaranteed by sharing a font file: baseline metrics, kerning and rasterization also matter.</p><p>Production caveats: poster-text.ts hard-codes Roboto baseline metrics and accepts one family for all roles. A script-only context adapter routes its weight shorthand to individually registered title and body aliases, avoiding merged Pango faces. The existing DM Sans Regular file is variable (weight and optical-size axes), reused for both body roles; browser and native instance selection can differ. The service always draws its OpenStreetMap credit; it is mirrored here for parity, though this fixture uses no OSM data. See README.md for exact production changes needed.</p>${table('chrome')}${launched.some(b=>b.id==='edge')?`<details><summary>Microsoft Edge comparison (same four options)</summary>${table('edge')}</details>`:''}<details><summary>Font licences</summary>${(await Promise.all(['spacegrotesk','ibmplexmono','montserrat','playfairdisplay','dmsans'].map(async f=>`<h3>${f} — SIL OFL 1.1</h3><pre style="white-space:pre-wrap">${esc(await readFile(downloaded(`${f}-OFL.txt`),'utf8'))}</pre>`))).join('')}<h3>Roboto — Apache 2.0</h3><pre style="white-space:pre-wrap">${esc(await readFile(local('assets/fonts/Roboto-LICENSE'),'utf8'))}</pre></details></html>`);
console.log(`Wrote ${path.join(out,'sheet.html')}`);
