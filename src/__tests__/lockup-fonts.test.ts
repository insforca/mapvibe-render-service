import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCKUP_FONT, LOCKUP_METRICS, layoutPosterText, resolveLockupFont } from '../poster-text.js';
import sheet from './fixtures/space-plex-sheet.json';

const pinned = {
  'SpaceGrotesk-Bold.ttf': '7209bbb75fc0f5c546a5f5773b0db74ffc6abf04c2148c1105cace5765a96bdb',
  'IBMPlexMono-Light.ttf': '780bcf65509d72a35ec114b57bcbe220dc6b77d8ea2e9b25e294be3c570c5025',
  'IBMPlexMono-Regular.ttf': '6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46',
  'spacegrotesk-OFL.txt': '564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72',
  'ibmplexmono-OFL.txt': '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da',
};

describe('versioned poster lockup', () => {
  it('requires new-design producers to persist the default; unversioned designs stay legacy', () => {
    expect(DEFAULT_LOCKUP_FONT).toBe('space-plex');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveLockupFont()).toBe('roboto');
    expect(resolveLockupFont('roboto')).toBe('roboto');
    expect(resolveLockupFont('space-plex')).toBe('space-plex');
    expect(warn).not.toHaveBeenCalled();
    for (const value of ['unknown', '', null, 42, {}]) expect(resolveLockupFont(value)).toBe('roboto');
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it('pins the fonts and licences byte-for-byte', () => {
    for (const [file, hash] of Object.entries(pinned)) {
      const bytes = readFileSync(resolve('assets/fonts', file));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(hash);
      expect(bytes.equals(readFileSync(resolve('scripts/font-sheet/fonts', file))), file).toBe(true);
    }
  });

  it('derives new baselines from hhea/head and preserves historical Roboto baselines', () => {
    const files = {
      roboto: ['Roboto-Bold.ttf', 'Roboto-Light.ttf', 'Roboto-Regular.ttf'],
      'space-plex': ['SpaceGrotesk-Bold.ttf', 'IBMPlexMono-Light.ttf', 'IBMPlexMono-Regular.ttf'],
    };
    for (const id of ['roboto', 'space-plex'] as const) {
      for (const [i, role] of (['city', 'country', 'coords'] as const).entries()) {
        const bytes = readFileSync(resolve('assets/fonts', files[id][i]));
        const tables: Record<string, number> = {};
        for (let i = 0; i < bytes.readUInt16BE(4); i++) {
          const offset = 12 + i * 16;
          tables[bytes.toString('ascii', offset, offset + 4)] = bytes.readUInt32BE(offset + 8);
        }
        const ascent = bytes.readInt16BE(tables.hhea + 4);
        const descent = -bytes.readInt16BE(tables.hhea + 6);
        const upem = bytes.readUInt16BE(tables.head + 18);
        const metrics = LOCKUP_METRICS[id][role];
        if (id === 'space-plex') {
          expect(metrics.normalLineEm).toBe((ascent + descent) / upem);
          expect(metrics.halfLeadingEm).toBe((metrics.lineHeight - (ascent + descent) / upem) / 2);
        } else {
          expect([ascent, descent, upem]).toEqual([2146, 555, 2048]);
          expect(metrics.baselineEm).toBe(1900 / 2048 + (1.15 - 2400 / 2048) / 2);
        }
        const layout = layoutPosterText({ width: 900, height: 1200, city: 'NEW YORK', country: 'UNITED STATES',
          coords: '40.7128 N', lockupFont: id, glyph: () => ({ width: 100, ascent: 10, descent: 0 }) });
        expect(layout[role].y - layout[role].boxTop).toBeCloseTo(metrics.baselineEm * layout[role].size, 8);
      }
    }
  });

  it('uses real canvas faces, preserves legacy drawing and matches browser sheet advances', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mapvibe-lockup-'));
    try {
      const env = { ...process.env };
      if (process.platform === 'win32') {
        // Match the Linux service backend; the Windows default can silently ignore private fonts.
        const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
        const config = join(temp, 'fonts.conf');
        writeFileSync(config, `<?xml version="1.0"?><fontconfig><dir>${xml(resolve('assets/fonts').replaceAll('\\', '/'))}</dir><cachedir>${xml(temp.replaceAll('\\', '/'))}</cachedir></fontconfig>`);
        env.PANGOCAIRO_BACKEND = 'fc';
        env.FONTCONFIG_FILE = config;
      }
      const result = JSON.parse(execFileSync(process.execPath, [resolve('src/__tests__/fixtures/lockup-canvas.cjs')],
        { env, encoding: 'utf8', timeout: 30000 }));
      expect(result.referenceHashes).toHaveLength(8);
      expect(result.legacyHashes).toEqual(result.referenceHashes);
      expect(result.v2.fadeSamples).toHaveLength(12);
      for (const sample of result.v2.fadeSamples) {
        expect(sample.alpha, JSON.stringify(sample)).toBeGreaterThanOrEqual(.83);
        expect(sample.alpha).toBeLessThanOrEqual(.87);
        expect(sample.inkTop).toBeCloseTo(sample.expectedInkTop, 8);
        expect(sample.clearance + 1e-8).toBeGreaterThanOrEqual(sample.ascent);
        expect(sample.above).toBe(0);
        expect(sample.bottom).toBeGreaterThan(.98);
      }
      expect(result.v2.serverParity).toEqual(Array(48).fill(true));
      expect(result.v2.parity).toEqual(Array(16).fill(true));
      for (const layout of result.v2.stress) {
        expect(layout.coords.text).toBe('-33.8688? S / 151.2093? E');
        expect(layout.coords.width + layout.coords.spacing * layout.coords.size).toBeLessThanOrEqual(84.001);
      }
      for (const { layout } of result.v2.layouts) {
        expect((134 - layout.stripTop) / 134).toBeLessThanOrEqual(.15);
        expect(layout.coords.width + layout.coords.spacing * layout.coords.size).toBeLessThanOrEqual(84.001);
        expect(layout.textFadeTop).toBeLessThan(layout.city.y - layout.city.ascent);
      }
      for (const role of ['city', 'country', 'coords']) {
        const ink = result.v2.ink[role];
        const reference: Record<string, number> = { city: .849483, country: .530948, coords: .354931 };
        expect(Math.abs(ink.meanAlpha - reference[role])).toBeLessThan(.04);
        expect(ink.meanAlpha).toBeLessThanOrEqual(role === 'coords' ? .7 : 1);
        expect(ink.glyphPixels).toBeGreaterThan(100);
        const call = result.v2.calls[role][0];
        expect(call.alpha).toBeCloseTo(role === 'coords' ? .7 : 1, 2);
        expect(call.color).toBe('#ffffff');
        expect(call.font).toContain(role === 'city' ? 'Space Grotesk' : role === 'country' ? 'IBM Plex Mono Light' : 'IBM Plex Mono');
      }
      expect(result.draws.absent).toEqual(result.draws.roboto);
      expect(result.draws.absent[0].font).toContain('Roboto');
      // A customer's picker font wins over the lockup default, with the legacy fallbacks.
      const picked = result.draws['picker-over-space-plex'];
      expect(picked[0].font).toContain('"MapVibe Picker Lato 700",Roboto');
      expect(picked.some((d: any) => /Space Grotesk|Plex/.test(d.font))).toBe(false);
      // Whitespace is not a picker font: the lockup default applies.
      expect(result.draws['blank-picker']).toEqual(result.draws['space-plex']);
      const draws = result.draws['space-plex'];
      expect(draws[0].font).toBe('700 62.46px "Space Grotesk"');
      expect(draws.find((d: any) => d.text === 'UNITED STATES').font).toBe('300 22.95px "IBM Plex Mono Light"');
      expect(draws.find((d: any) => d.text.includes('40.7128')).font).toBe('400 14.58px "IBM Plex Mono"');
      for (const credit of draws.filter((d: any) => d.text.includes('contributors') || d.text.includes('created with'))) {
        expect(credit.font).toBe('400 7.5px "IBM Plex Mono"');
      }
      // Exact file advance fingerprints reject fallback. Mono advances alone cannot
      // distinguish Light/Regular: also require materially different raster density.
      result.fingerprints.forEach((width: number, i: number) => {
        expect(Math.abs(width - sheet.fingerprints[i].expected)).toBeLessThan(0.2);
      });
      expect(result.density[1]).toBeGreaterThan(result.density[0] * 1.15);
      const [city, country] = result.widths;
      expect(Math.abs(country.whole - sheet.browser.country.advance)).toBeLessThan(0.5);
      expect(Math.abs(city.words - sheet.browser.city.advance)).toBeLessThan(0.5);
      // Pango applies cross-space kerning; browser canvas does not. Quantify it,
      // rather than introducing a 1px correction that would break DOM parity.
      expect(city.pairs[0]).toBeCloseTo(-0.375, 2);
      expect(city.pairs[1]).toBeCloseTo(-0.625, 2);
      expect(city.words - city.whole).toBeCloseTo(1, 2);
      const domAdvance = sheet.browser.city.cssInline - 8 * 0.45 * sheet.browser.city.size;
      expect(Math.abs(city.whole - domAdvance)).toBeLessThan(0.5);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 35000);
});
