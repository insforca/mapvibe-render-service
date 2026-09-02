/**
 * render-dims.ts — fulfillment render dimension / DPI selection.
 *
 * Policy (2026-09-02, decoupling 70×100 from the tiled path):
 *   1. Prefer the highest DPI ≤ TARGET_DPI (400) whose FULL frame fits a
 *      single pass: both edges ≤ MAX_RENDER_PX_WH and total pixels ≤ MAX_PX.
 *   2. If that DPI is ≥ MIN_SINGLE_PASS_DPI (300 — the advertised customer
 *      standard), render single-pass at it. Sizes that fit 400 keep rendering
 *      at 400 exactly as before; sizes like 70×100 cm (400-DPI nominal
 *      11,024×15,748 px exceeds the 14,400 edge cap) now land single-pass at
 *      their ceiling (365 DPI, 10,059×14,370 px ≈ 144.6 MP) instead of tiling.
 *   3. Only when the single-pass ceiling is < 300 DPI (e.g. 100×150 cm,
 *      ceiling ≈ 243 DPI) does the render tile — and only when geographic
 *      bounds exist for subdivision. Boundsless oversize falls back to a
 *      capped single pass (may land under 300 DPI; callers log it loudly).
 *
 * Pure module — no I/O — so the selection is unit-testable in isolation.
 */

export const CM_PER_INCH = 2.54;

export interface RenderDims {
  width: number;      // final render width, px
  height: number;     // final render height, px
  actualDpi: number;  // effective DPI after caps (width / width-in-inches)
  numTiles: number;   // 1 = single pass; >1 = vertical tiles
  mode: 'single-pass' | 'tiled' | 'single-pass-fallback';
}

export function computeRenderDims(
  widthCm: number,
  heightCm: number,
  hasBounds: boolean,
  opts: { targetDpi: number; minSinglePassDpi: number; maxEdgePx: number; maxPx: number },
): RenderDims {
  const { targetDpi, minSinglePassDpi, maxEdgePx, maxPx } = opts;
  const widthIn  = widthCm  / CM_PER_INCH;
  const heightIn = heightCm / CM_PER_INCH;

  // Highest DPI whose full frame fits one pass (edge cap AND area cap).
  const edgeFitDpi = Math.floor(maxEdgePx / Math.max(widthIn, heightIn));
  const areaFitDpi = Math.floor(Math.sqrt(maxPx / (widthIn * heightIn)));
  const singlePassDpi = Math.min(targetDpi, edgeFitDpi, areaFitDpi);

  if (singlePassDpi >= minSinglePassDpi) {
    const width  = Math.round(widthIn  * singlePassDpi);
    const height = Math.round(heightIn * singlePassDpi);
    return {
      width, height,
      actualDpi: Math.round(width / widthIn),
      numTiles: 1,
      mode: 'single-pass',
    };
  }

  const nominalW = Math.round(widthIn  * targetDpi);
  const nominalH = Math.round(heightIn * targetDpi);

  if (hasBounds) {
    // Tiled: width capped to the edge limit, height keeps aspect; each tile
    // stays within the per-pass area cap.
    const wScale = Math.min(1, maxEdgePx / nominalW);
    const width  = Math.round(nominalW * wScale);
    const height = Math.round(nominalH * wScale);
    const maxTileH = Math.floor(maxPx / width);
    return {
      width, height,
      actualDpi: Math.round(width / widthIn),
      numTiles: Math.ceil(height / maxTileH),
      mode: 'tiled',
    };
  }

  // Boundsless fallback: aspect-preserving cap to BOTH limits (edge + area) in
  // one pass. May land under the 300 DPI floor — callers flag it loudly.
  const dimScale = Math.min(
    1,
    maxEdgePx / Math.max(nominalW, nominalH),
    Math.sqrt(maxPx / (nominalW * nominalH)),
  );
  const width  = Math.round(nominalW * dimScale);
  const height = Math.round(nominalH * dimScale);
  return {
    width, height,
    actualDpi: Math.round(width / widthIn),
    numTiles: 1,
    mode: 'single-pass-fallback',
  };
}
