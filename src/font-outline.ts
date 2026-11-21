import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read SFNT metrics directly: cap ink must not depend on raster hinting or DPI.
const cache = new Map<string, ReturnType<typeof readFace>>();
function readFace(file: string) {
  const b = readFileSync(join(__dirname, '../assets/fonts', file));
  const t: Record<string, number> = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const p = 12 + i * 16;
    t[b.toString('ascii', p, p + 4)] = b.readUInt32BE(p + 8);
  }
  const upem = b.readUInt16BE(t.head + 18);
  const baselineEm = .575 + (b.readInt16BE(t.hhea + 4) + b.readInt16BE(t.hhea + 6)) / (2 * upem);
  const cmap = t.cmap;
  let sub = 0;
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const p = cmap + 4 + i * 8, candidate = cmap + b.readUInt32BE(p + 4);
    const format = b.readUInt16BE(candidate);
    if (format === 12) { sub = candidate; break; }
    if (format === 4) sub = candidate;
  }
  function glyph(code: number): number {
    if (b.readUInt16BE(sub) === 12) {
      for (let i = 0; i < b.readUInt32BE(sub + 12); i++) {
        const p = sub + 16 + i * 12, start = b.readUInt32BE(p), end = b.readUInt32BE(p + 4);
        if (code >= start && code <= end) return b.readUInt32BE(p + 8) + code - start;
      }
    } else {
      const n = b.readUInt16BE(sub + 6) / 2, ends = sub + 14, starts = ends + 2 * n + 2;
      for (let i = 0; i < n; i++) {
        if (code < b.readUInt16BE(starts + 2 * i) || code > b.readUInt16BE(ends + 2 * i)) continue;
        const delta = b.readInt16BE(starts + 2 * n + 2 * i), rp = starts + 4 * n + 2 * i;
        const range = b.readUInt16BE(rp);
        if (!range) return (code + delta) & 65535;
        const id = b.readUInt16BE(rp + range + 2 * (code - b.readUInt16BE(starts + 2 * i)));
        return id ? (id + delta) & 65535 : 0;
      }
    }
    return 0;
  }
  return { baselineEm, ink(text: string) {
    if (!t.glyf) return undefined; // CFF picker: caller uses a large unhinted canvas probe.
    let ascent = 0, descent = 0;
    const long = b.readInt16BE(t.head + 50) === 1;
    const offset = (id: number) => long ? b.readUInt32BE(t.loca + id * 4) : b.readUInt16BE(t.loca + id * 2) * 2;
    for (const ch of text) {
      if (/\s/u.test(ch)) continue;
      const id = glyph(ch.codePointAt(0)!);
      const at = offset(id);
      if (at === offset(id + 1)) continue;
      ascent = Math.max(ascent, b.readInt16BE(t.glyf + at + 8) / upem);
      descent = Math.max(descent, -b.readInt16BE(t.glyf + at + 4) / upem);
    }
    return { ascent, descent };
  } };
}
export function fontOutline(file: string) {
  let face = cache.get(file);
  if (!face) { face = readFace(file); cache.set(file, face); }
  return face;
}
