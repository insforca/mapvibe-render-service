import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(here,'../..'), out=path.join(here,'out');
const m=JSON.parse(await readFile(path.join(out,'metrics.json'),'utf8'));
assert.equal(m.options.length,4);
const sources=await readFile(path.join(here,'fonts/SOURCES.md'),'utf8');
for(const line of sources.split('\n').filter(l=>l.startsWith('| ')&&!l.startsWith('| File'))){
  const [,file,,,hash]=line.split('|').map(s=>s.trim());
  const bytes=await readFile(path.join(root,file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,file);
}
for(const o of m.options){
  for(const f of o.fonts){
    assert.ok(Math.abs(f.loadFingerprint.actual-f.loadFingerprint.expected)<.2,`${f.file}: fallback`);
    for(const coverage of Object.values(f.coverage))assert.ok(coverage.original&&coverage.uppercase);
  }
  for(const browser of Object.keys(o.pairs)){
    const p=o.pairs[browser];
    assert.ok(Number.isFinite(p.mae)&&p.mae>=0&&p.mae<=255);
    assert.ok(p.changedPixelPercent>=0&&p.changedPixelPercent<=100);
    assert.ok(p.browser.fonts.every(f=>f.status==='loaded'));
    // Native CSS snaps the 1.866px divider to 1px, unlike Cairo's fractional
    // stroke; this plus subpixel line-box rounding shifts flow by ~0.94px.
    assert.ok(Math.abs(p.browser.stripTop-o.print.layout.stripTop)<1.1,'Unexpected DOM block flow difference');
    for(const suffix of ['print',browser,`${browser}-diff`]){
      const png=await readFile(path.join(out,`${o.id}-${suffix}.png`));
      assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16),m.dimensions.width);
      assert.equal(png.readUInt32BE(20),m.dimensions.height);
    }
  }
  if(o.pairs.edge){
    // Compare decoded metrics rather than PNG encoders' metadata.
    assert.equal(o.pairs.chrome.mae,o.pairs.edge.mae);
    assert.equal(o.pairs.chrome.changedPixelPercent,o.pairs.edge.changedPixelPercent);
  }
}
const html=await readFile(path.join(out,'sheet.html'),'utf8');
const imageSources=[...html.matchAll(/<img src="([^"]+)"/g)].map(m=>m[1]);
assert.equal(imageSources.length,Object.keys(m.browserVersions).filter(k=>m.browserVersions[k]!=='not installed').length*12);
assert.ok(imageSources.every(s=>s.startsWith('data:image/png;base64,')));
assert.ok(!/<(?:script|link)\b|@import|url\(/i.test(html),'sheet must be standalone');
console.log('Verified source hashes, 12 font-role fingerprints, accent cmaps, native font loads, DOM flow, image sizes, Chrome/Edge scores and self-contained sheet.');
