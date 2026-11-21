import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PICKER_FONTS, pickerFamily, resolvePickerFont } from '../picker-fonts.js';
import manifest from '../../assets/fonts/picker/manifest.json';

// Unkerned advance fingerprints derived independently from each original SFNT (TTF or CFF OTF).
function fontTables(b: Buffer) {
  const t: Record<string, number> = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const p = 12 + 16 * i;
    t[b.toString('ascii', p, p + 4)] = b.readUInt32BE(p + 8);
  }
  return t;
}
function advances(b: Buffer, sample: string) {
  const t = fontTables(b);
  const n = b.readUInt16BE(t.cmap + 2);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const p = t.cmap + 4 + 8 * i;
    const sub = t.cmap + b.readUInt32BE(p + 4);
    if (b.readUInt16BE(p) === 3 && b.readUInt16BE(p + 2) === 1 && b.readUInt16BE(sub) === 4) c = sub;
  }
  expect(c).toBeGreaterThan(0);
  const count = b.readUInt16BE(c + 6) / 2;
  const end = c + 14, start = end + count * 2 + 2, delta = start + count * 2, ranges = delta + count * 2;
  return [...sample].map(ch => {
    const code = ch.charCodeAt(0);
    let gid = 0;
    for (let i = 0; i < count; i++) {
      if (code < b.readUInt16BE(start + i * 2) || code > b.readUInt16BE(end + i * 2)) continue;
      const d = b.readInt16BE(delta + i * 2), r = b.readUInt16BE(ranges + i * 2);
      gid = r ? b.readUInt16BE(ranges + i * 2 + r + 2 * (code - b.readUInt16BE(start + i * 2))) : code;
      if (!r || gid) gid = (gid + d) & 0xffff;
      break;
    }
    expect(gid).toBeGreaterThan(0);
    const metrics = b.readUInt16BE(t.hhea + 34);
    return b.readUInt16BE(t.hmtx + 4 * Math.min(gid, metrics - 1)) / b.readUInt16BE(t.head + 18) * 100;
  });
}

describe('pinned offline picker faces', () => {
  it('pins source bytes and licences and contains only real static weights', () => {
    expect(manifest.filter(f => /\.(ttf|otf)$/.test(f.file))).toHaveLength(24);
    expect(manifest.filter(f => f.file.endsWith('.otf'))).toHaveLength(3);
    for (const f of manifest) {
      const b = readFileSync(resolve('assets/fonts/picker', f.file));
      expect(b.length, f.file).toBe(f.bytes);
      expect(createHash('sha256').update(b).digest('hex'), f.file).toBe(f.sha256);
      expect(f.url).toMatch(/(?:google\/fonts|notofonts\/noto-cjk)\/[a-f0-9]{40}\//);
      if (!/\.(ttf|otf)$/.test(f.file)) continue;
      const t = fontTables(b);
      expect(t.fvar, f.file).toBeUndefined();
      if (f.file.endsWith('.otf')) {
        expect(b.toString('ascii', 0, 4)).toBe('OTTO');
        expect(t['CFF '], f.file).toBeGreaterThan(0);
        expect(t.glyf, f.file).toBeUndefined();
      }
      const face = PICKER_FONTS.flatMap(f => f.faces).find(face => face.staticFile === 'picker/' + f.file)!;
      expect(b.readUInt16BE(t['OS/2'] + 4), f.file).toBe(Number(face.weight));
    }
  });
  it('matches picker values case-insensitively and warns for unknown values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const font of PICKER_FONTS) expect(resolvePickerFont(' ' + font.value.toUpperCase() + ' ')).toBe(font);
    expect(resolvePickerFont('Unknown Font')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('selects every real face by its advance fingerprint and uses the right family for every role', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mapvibe-picker-'));
    try {
      const env = { ...process.env };
      if (process.platform === 'win32') {
        const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
        const config = join(temp, 'fonts.conf');
        writeFileSync(config, `<?xml version="1.0"?><fontconfig><dir>${xml(resolve('assets/fonts').replaceAll('\\', '/'))}</dir><cachedir>${xml(temp.replaceAll('\\', '/'))}</cachedir></fontconfig>`);
        env.PANGOCAIRO_BACKEND = 'fc'; env.FONTCONFIG_FILE = config;
      }
      const result = JSON.parse(execFileSync(process.execPath, [resolve('src/__tests__/fixtures/picker-canvas.cjs')], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(result.fingerprints).toHaveLength(24);
      for (const f of result.fingerprints) {
        const expected = advances(readFileSync(resolve('assets/fonts', f.file)), f.sample);
        f.advances.forEach((w: number, i: number) => expect(Math.abs(w - expected[i]), `${f.family} glyph ${i}`).toBeLessThan(0.02));
      }
      const notoDensity = result.fingerprints.filter((f: any) => f.file.endsWith('.otf'));
      expect(notoDensity.find((f: any) => f.weight === '700').density).toBeGreaterThan(
        notoDensity.find((f: any) => f.weight === '300').density * 1.4);
      for (const font of PICKER_FONTS) {
        const fingerprints = result.fingerprints.filter((f: any) => font.faces.some(face => face.staticFile === f.file));
        for (let i = 0; i < fingerprints.length; i++) {
          for (let j = i + 1; j < fingerprints.length; j++) {
            // The sample must reject each other weight, not only system fallback.
            expect(fingerprints[i].advances.some((w: number, k: number) => Math.abs(w - fingerprints[j].advances[k]) > 0.05), font.value).toBe(true);
          }
        }
        const calls = result.draws[font.value];
        expect(calls[0].font).toContain('700 ');
        expect(calls[0].font).toContain(pickerFamily(font, 700));
        expect(calls.find((c: any) => c.text === 'UNITED STATES').font).toContain(pickerFamily(font, 300));
        expect(calls.find((c: any) => c.text.includes('40.7128')).font).toContain(pickerFamily(font, 400));
        for (const c of calls.filter((c: any) => /contributors|created with/.test(c.text))) {
          expect(c.font).toContain('300 '); expect(c.font).toContain(pickerFamily(font, 300));
        }
      }
      expect(result.draws['bEbAs NeUe']).toEqual(result.draws['Bebas neue']);
      expect(result.draws['Unknown Font'][0].font).toContain('Roboto');
      expect(JSON.stringify(result.draws['Unknown Font'])).not.toMatch(/MapVibe Picker|Unknown Font/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 35000);
});
