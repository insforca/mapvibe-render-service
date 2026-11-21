// Local visual inspection aid; all output remains in the ignored directory.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url), {createCanvas,loadImage}=require('canvas');
const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'out');
const metrics=JSON.parse(await readFile(path.join(out,'metrics.json'),'utf8'));
const c=createCanvas(2700,4*260),ctx=c.getContext('2d');
for(const [r,o] of metrics.options.entries())for(const [col,suffix] of ['chrome','print','chrome-diff'].entries()){
  const img=await loadImage(path.join(out,`${o.id}-${suffix}.png`));
  ctx.drawImage(img,0,960,900,240,col*900,r*260,900,240);
}
await writeFile(path.join(out,'review.png'),c.toBuffer('image/png'));
