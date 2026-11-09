import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  isIccProfile,
  loadPackagedSrgbIcc,
  packagedSrgbIccPath,
} from '../srgb-icc.js';
import { encodePrintPng } from '../print-png.js';

const PACKAGED_RELATIVE = join(__dirname, '../../assets/color/sRGB2014.icc');

function pngChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const sig = png.subarray(0, 8).toString('hex');
  expect(sig).toBe('89504e470d0a1a0a');
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + len);
    chunks.push({ type, data });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function inflatedIcc(png: Buffer): Buffer {
  const iccp = pngChunks(png).find((chunk) => chunk.type === 'iCCP');
  expect(iccp, 'PNG iCCP chunk').toBeTruthy();
  const nul = iccp!.data.indexOf(0);
  expect(nul).toBeGreaterThan(0);
  expect(iccp!.data[nul + 1]).toBe(0); // compression method 0 = zlib
  return inflateSync(iccp!.data.subarray(nul + 2));
}

describe('packaged sRGB ICC profile', () => {
  it('is a real ICC file, not the color.org HTML landing page', () => {
    const buf = readFileSync(PACKAGED_RELATIVE);
    expect(buf.subarray(0, 15).toString('ascii')).not.toMatch(/<!DOCTYPE|<html/i);
    expect(buf.subarray(36, 40).toString('ascii')).toBe('acsp');
    expect(buf.readUInt32BE(0)).toBe(buf.length);
    expect(buf.length).toBeGreaterThan(128);
    expect(isIccProfile(buf)).toBe(true);
  });

  it('accepts an ICC header and rejects HTML or a truncated buffer', () => {
    const header = Buffer.alloc(128);
    header.writeUInt32BE(128, 0);
    header.write('acsp', 36, 'ascii');
    expect(isIccProfile(header)).toBe(true);

    const html = Buffer.alloc(15452);
    html.write('<!DOCTYPE html>\n<html lang="en" data-bs-theme="light">');
    expect(isIccProfile(html)).toBe(false);

    const truncated = Buffer.alloc(40);
    truncated.write('acsp', 36, 'ascii');
    expect(isIccProfile(truncated)).toBe(false);
  });

  it('loads the packaged profile without a network call', () => {
    const calls: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('network fetch must not run'));
    }) as typeof fetch;
    try {
      const loaded = loadPackagedSrgbIcc();
      expect(calls).toEqual([]);
      expect(loaded.path).toBe(packagedSrgbIccPath());
      expect(loaded.path).toBe(PACKAGED_RELATIVE);
      expect(loaded.bytes).toBe(readFileSync(loaded.path).length);
      expect(isIccProfile(readFileSync(loaded.path))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('server startup uses the packaged loader and does not download color.org', () => {
    const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    expect(source.includes('loadPackagedSrgbIcc(')).toBe(true);
    expect(source.includes('color.org')).toBe(false);
    expect(source.includes("fetch('https://www.color.org")).toBe(false);
    const encodes = source.match(/encodePrintPng\(/g) ?? [];
    expect(encodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('encodePrintPng', () => {
  it('embeds the packaged ICC and writes density into an 8-bit RGB PNG', async () => {
    const profile = readFileSync(PACKAGED_RELATIVE);
    const width = 2;
    const height = 2;
    const raw = Buffer.alloc(width * height * 4);
    // Opaque red, opaque green, fully transparent (must flatten to white), half-alpha blue.
    raw.set([255, 0, 0, 255], 0);
    raw.set([0, 255, 0, 255], 4);
    raw.set([0, 0, 255, 0], 8);
    raw.set([0, 0, 255, 128], 12);

    const density = 300;
    const png = await encodePrintPng(raw, width, height, density);

    const chunks = pngChunks(png);
    const types = chunks.map((chunk) => chunk.type);
    expect(types).toContain('iCCP');
    expect(types).toContain('pHYs');

    const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')!;
    expect(ihdr.data.readUInt32BE(0)).toBe(width);
    expect(ihdr.data.readUInt32BE(4)).toBe(height);
    expect(ihdr.data[8]).toBe(8); // bit depth
    expect(ihdr.data[9]).toBe(2); // colour type RGB, no alpha

    const phys = chunks.find((chunk) => chunk.type === 'pHYs')!;
    const ppm = Math.round(density / 0.0254);
    expect(phys.data.readUInt32BE(0)).toBe(ppm);
    expect(phys.data.readUInt32BE(4)).toBe(ppm);
    expect(phys.data[8]).toBe(1);

    const embedded = inflatedIcc(png);
    expect(embedded.subarray(36, 40).toString('ascii')).toBe('acsp');
    expect(embedded.equals(profile)).toBe(true);

    const meta = await sharp(png).metadata();
    expect(meta.density).toBe(density);
    expect(meta.space).toBe('srgb');
    expect(meta.channels).toBe(3);
    expect(meta.icc).toBeTruthy();
    expect(Buffer.from(meta.icc!).equals(profile)).toBe(true);

    const pixels = await sharp(png).raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([255, 0, 0]);
    // sRGB2014 matches these pixels. Sharp's conversion rounds a few saturated
    // samples by one code value (pure green can come back as 1,255,0).
    const green = [...pixels.subarray(3, 6)];
    expect(green[0]).toBeLessThanOrEqual(1);
    expect(green[1]).toBe(255);
    expect(green[2]).toBe(0);
    expect([...pixels.subarray(6, 9)]).toEqual([255, 255, 255]);
  });
});
