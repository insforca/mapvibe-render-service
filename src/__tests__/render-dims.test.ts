import { describe, it, expect } from 'vitest';
import { computeRenderDims, CM_PER_INCH } from '../render-dims.js';

// Production caps (mirror server.ts constants)
const OPTS = { targetDpi: 400, minSinglePassDpi: 300, maxEdgePx: 14_400, maxPx: 150_000_000 };

const mp = (d: { width: number; height: number }) => d.width * d.height;

describe('computeRenderDims — DPI selection policy', () => {
  it('sizes that fit 400 DPI render at 400, unchanged (18×24in poster)', () => {
    const d = computeRenderDims(45.72, 60.96, true, OPTS);
    expect(d).toMatchObject({ width: 7200, height: 9600, actualDpi: 400, numTiles: 1, mode: 'single-pass' });
  });

  it('50×70 stays single-pass @ 400 DPI', () => {
    const d = computeRenderDims(50, 70, true, OPTS);
    expect(d.mode).toBe('single-pass');
    expect(d.actualDpi).toBe(400);
    expect(d.numTiles).toBe(1);
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(OPTS.maxEdgePx);
  });

  it('Grand 24×36in stays single-pass @ 400 DPI (9600×14400, 138 MP)', () => {
    const d = computeRenderDims(60.96, 91.44, true, OPTS);
    expect(d).toMatchObject({ width: 9600, height: 14400, actualDpi: 400, numTiles: 1, mode: 'single-pass' });
  });

  it('70×100 renders SINGLE-PASS at its ceiling ≥ 300 DPI — never tiled', () => {
    const d = computeRenderDims(70, 100, true, OPTS);
    expect(d.mode).toBe('single-pass');
    expect(d.numTiles).toBe(1);
    expect(d.actualDpi).toBeGreaterThanOrEqual(300);
    expect(d.actualDpi).toBeLessThanOrEqual(400);
    // fits both per-pass caps
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(OPTS.maxEdgePx);
    expect(mp(d)).toBeLessThanOrEqual(OPTS.maxPx);
    // aspect preserved to within a pixel of rounding
    expect(d.width / d.height).toBeCloseTo(70 / 100, 3);
  });

  it('70×100 single-pass holds even WITHOUT bounds', () => {
    const d = computeRenderDims(70, 100, false, OPTS);
    expect(d.mode).toBe('single-pass');
    expect(d.numTiles).toBe(1);
    expect(d.actualDpi).toBeGreaterThanOrEqual(300);
  });

  it('100×150 (ceiling < 300 DPI) tiles when bounds exist, each tile within per-pass caps', () => {
    const d = computeRenderDims(100, 150, true, OPTS);
    expect(d.mode).toBe('tiled');
    expect(d.numTiles).toBeGreaterThan(1);
    expect(d.actualDpi).toBeGreaterThanOrEqual(300);
    expect(d.width).toBeLessThanOrEqual(OPTS.maxEdgePx);
    // per-tile area within cap
    expect(d.width * Math.ceil(d.height / d.numTiles)).toBeLessThanOrEqual(OPTS.maxPx);
  });

  it('100×150 without bounds falls back to capped single pass (flagged sub-300)', () => {
    const d = computeRenderDims(100, 150, false, OPTS);
    expect(d.mode).toBe('single-pass-fallback');
    expect(d.numTiles).toBe(1);
    expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(OPTS.maxEdgePx);
    expect(mp(d)).toBeLessThanOrEqual(OPTS.maxPx);
    expect(d.actualDpi).toBeLessThan(300);
  });

  it('square oversize respects the AREA cap, not just the edge cap', () => {
    // 100×100 cm: 14400×14400 would be 207 MP > 150 MP — area cap must bind.
    const d = computeRenderDims(100, 100, true, OPTS);
    expect(mp(d)).toBeLessThanOrEqual(OPTS.maxPx);
    expect(d.mode).toBe('single-pass'); // area-fit DPI ≈ 311 ≥ 300
    expect(d.actualDpi).toBeGreaterThanOrEqual(300);
  });

  it('effective DPI is exact: actualDpi = width / width-in-inches', () => {
    const d = computeRenderDims(70, 100, true, OPTS);
    expect(d.actualDpi).toBe(Math.round(d.width / (70 / CM_PER_INCH)));
  });
});
