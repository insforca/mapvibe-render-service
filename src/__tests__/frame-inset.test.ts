import { describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import { compositePosterOverlay } from '../poster-text.js';
import { FRAMED_SAFE_INSET_MM, loadCatalogue, renderTargetForRow } from '../catalogue.js';
import { resolvePrintWindow } from '../print-window.js';

// Owner decision 2026-11-22: on framed products no credit ink may sit within
// 12 mm of a trim edge (the vendors do not publish their frame lip).
const DPI = 60;
const overlay = {
  displayCity: '', displayCountry: '', showPosterText: false, includeCredits: true,
  lockupLayout: 'v2', theme: { map: { land: '#ffffff' }, ui: { text: '#111111' } },
};

function inkInBand(sku: string | null, wIn: number, hIn: number) {
  const W = Math.round(wIn * DPI), H = Math.round(hIn * DPI);
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const window = sku
    ? resolvePrintWindow(renderTargetForRow(loadCatalogue().find(r => r.sku === sku)!), false)
    : undefined;
  compositePosterOverlay(ctx, W, H, overlay, 0, 0, '#ffffff', 'none', window);
  const band = Math.floor((FRAMED_SAFE_INSET_MM / 25.4) * DPI) - 1;
  const data = ctx.getImageData(0, 0, W, H).data;
  let ink = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const near = y >= H - band || x < band || x >= W - band;
    if (!near) continue;
    const i = (y * W + x) * 4;
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
  }
  return ink;
}

describe('framed safe inset', () => {
  it('marks framed rows only', () => {
    const rows = loadCatalogue();
    const framed = renderTargetForRow(rows.find(r => r.sku === 'MVS-F-1824-BK')!);
    const poster = renderTargetForRow(rows.find(r => r.sku === 'MVS-P-1824')!);
    expect(framed.framedSafeInsetIn).toBeCloseTo(12 / 25.4, 6);
    expect(poster.framedSafeInsetIn).toBeNull();
  });

  it('without the inset the credits sit inside the 12 mm band (sanity)', () => {
    expect(inkInBand(null, 18, 24)).toBeGreaterThan(0);
  });

  it.each(['MVS-F-1824-BK', 'MVS-F-1824-BR', 'MVS-F-2436-BK', 'MVS-F-2436-BR'])('%s keeps every credit pixel 12 mm clear', sku => {
    const row = loadCatalogue().find(r => r.sku === sku)!;
    expect(inkInBand(sku, row.trimWIn, row.trimHIn)).toBe(0);
  });
});
