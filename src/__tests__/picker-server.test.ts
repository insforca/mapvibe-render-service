import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join, basename } from 'node:path';
import ts from 'typescript';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolvePickerFont } from '../picker-fonts.js';
import { BUNDLED_FONTS } from '../bundled-fonts.js';

// Execute the real startup/font and tiled functions in a fresh isolated module,
// replacing GL, disk cache, encoder and stitching. No server, routes or sockets.
async function freshServer(missingPicker = false, invalidPicker = false) {
  const source = readFileSync('src/server.ts', 'utf8');
  const fontStart = source.indexOf('const FONT_CACHE_DIR');
  const start = fontStart >= 0 ? fontStart : source.indexOf('const registeredFonts');
  const end = source.indexOf('registerSystemFonts();', start) + 'registerSystemFonts();'.length;
  const tiledStart = source.indexOf('async function renderTiledPng(');
  const tiledEnd = source.indexOf('// ', source.indexOf('return pngBuf;', tiledStart));
  const registrations: any[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = vi.fn(async (url: string) => url.includes('googleapis')
    ? { ok: true, text: async () => [300, 400, 700].map(w => `@font-face { font-weight:${w}; src: url(https://fonts.gstatic.com/${w}.ttf) format('truetype'); }`).join('\n') }
    : { ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 0, 0, 1]).buffer });
  const ctx = { createImageData: () => ({ data: new Uint8ClampedArray(16) }), putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(16) }) };
  const draw = vi.fn(() => {
    expect(registrations.filter(f => f.path.includes('Montserrat'))).toHaveLength(3);
  });
  const tile = vi.fn(async () => Buffer.alloc(16));
  const sandbox: any = {
    BUNDLED_FONTS, resolvePickerFont, join, basename, __dirname: join(process.cwd(), 'src'), console: { log() {}, warn: vi.fn() },
    existsSync: (p: string) => !(missingPicker && p.includes('Montserrat')) && !p.includes('mapvibe-fonts') && !p.startsWith('/usr'),
    mkdirSync() {}, writeFileSync() {}, readFileSync, unlinkSync() {},
    registerFont: (path: string, options: any) => {
      if (invalidPicker && path.includes('Montserrat')) throw new Error('Invalid font');
      registrations.push({ path, ...options });
    },
    fetch, AbortSignal, Buffer, Uint8ClampedArray, Date,
    mercLatToY: (n: number) => n, mercYToLat: (n: number) => n,
    renderPngInternal: tile, sharp: () => ({ composite: () => ({ raw: () => ({ toBuffer: async () => Buffer.alloc(16) }) }) }),
    createCanvas: () => ({ getContext: () => ctx }), applyFades() {}, drawPosterText: draw,
    encodePrintPng: async () => Buffer.alloc(0),
  };
  const code = source.slice(start, end) + '\n' + source.slice(tiledStart, tiledEnd)
    + '\nglobalThis.api = { ensureFont, renderTiledPng };';
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { ...sandbox.api, registrations, fetch, draw, tile, warn };
}

afterEach(() => vi.restoreAllMocks());

describe('offline picker fonts in the real server paths', () => {
  it('fails startup on missing or invalid bundled picker assets', async () => {
    await expect(freshServer(true)).rejects.toThrow('Missing bundled face');
    await expect(freshServer(false, true)).rejects.toThrow('Could not register');
  });
  it('never fetches picker or unknown fonts, and warns for an unknown family', async () => {
    const s = await freshServer();
    await s.ensureFont('Montserrat');
    await s.ensureFont('Not A Picker');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalled();
  });
  it('registers separate real 300, 400 and 700 faces rather than the first CSS URL', async () => {
    const s = await freshServer();
    await s.ensureFont('Montserrat');
    const faces = s.registrations.filter((f: any) => f.path.includes('Montserrat'));
    expect(faces.map((f: any) => f.weight).sort()).toEqual(['300', '400', '700']);
    expect(new Set(faces.map((f: any) => f.path)).size).toBe(3);
  });
  it('has the picker faces before a fresh tiled render draws its post-stitch overlay', async () => {
    const s = await freshServer();
    await s.renderTiledPng({ bounds: { west: 0, east: 1, north: 1, south: 0 }, center: [0.5, 0.5],
      printMode: true, overlay: { fontFamily: 'Montserrat' } }, 2, 2, 2);
    expect(s.tile).toHaveBeenCalledTimes(2);
    expect(s.tile.mock.calls.every((args: any[]) => args[0].overlay === undefined)).toBe(true);
    expect(s.draw).toHaveBeenCalledTimes(1);
    expect(s.registrations.filter((f: any) => f.path.includes('Montserrat'))).toHaveLength(3);
    expect(s.fetch).not.toHaveBeenCalled();
  });
});

