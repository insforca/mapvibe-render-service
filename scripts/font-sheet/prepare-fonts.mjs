// Optional maintainer step. build.mjs itself is entirely offline.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
await mkdir(path.join(here, 'fonts'), { recursive: true });
const repos = ['floriankarsten/space-grotesk', 'JulietaUla/Montserrat', 'google/fonts'];
const revisions = {};
for (const repo of repos) {
  const response = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`);
  if (!response.ok) throw new Error(`${repo}: ${response.status}`);
  revisions[repo] = (await response.json())[0].sha;
}
const files = [
  ['SpaceGrotesk-Bold.ttf', repos[0], 'fonts/ttf/static/SpaceGrotesk-Bold.ttf'],
  ...['Light', 'Regular'].map(w => [`IBMPlexMono-${w}.ttf`, repos[2], `ofl/ibmplexmono/IBMPlexMono-${w}.ttf`]),
  ...['Light', 'Regular', 'Bold'].map(w => [`Montserrat-${w}.ttf`, repos[1], `fonts/ttf/Montserrat-${w}.ttf`]),
  ...['spacegrotesk', 'ibmplexmono', 'montserrat', 'playfairdisplay', 'dmsans'].map(f => [`${f}-OFL.txt`, repos[2], `ofl/${f}/OFL.txt`]),
];
const records = [];
for (const [name, repo, sourcePath] of files) {
  const url = `https://raw.githubusercontent.com/${repo}/${revisions[repo]}/${sourcePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(here, 'fonts', name), bytes);
  records.push({ file: `scripts/font-sheet/fonts/${name}`, url, bytes });
}
for (const file of ['assets/fonts/Roboto-Light.ttf', 'assets/fonts/Roboto-Regular.ttf', 'assets/fonts/Roboto-Bold.ttf', 'assets/fonts/Roboto-LICENSE', 'fonts/PlayfairDisplay-Regular.ttf', 'fonts/PlayfairDisplay-Bold.ttf', 'fonts/DMSans-Regular.ttf']) {
  records.push({ file, url: `../../${file} (existing checkout; used unmodified)`, bytes: await readFile(path.join(root, file)) });
}
await writeFile(path.join(here, 'fonts/SOURCES.md'), '# Font sources\n\nDownloaded files are pinned to upstream commits. Existing checkout files are used unmodified; their original download provenance is not recorded in this checkout. The Playfair Display and DM Sans OFL texts are from Google Fonts; font name-table licence metadata is also included in metrics.json. Roboto in this checkout carries Apache 2.0, not OFL. No conversion or subsetting was performed.\n\n| File | Source | Bytes | SHA-256 |\n|---|---|---:|---|\n' + records.map(({ file, url, bytes }) => `| ${file} | ${url} | ${bytes.length} | ${createHash('sha256').update(bytes).digest('hex')} |`).join('\n') + '\n');
console.log('Prepared fonts and SOURCES.md');
