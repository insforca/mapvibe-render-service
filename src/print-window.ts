/**
 * Canvas print files are larger than the visible poster. The editor bounds
 * are the visible window. Expanding that window about its centre, by
 * print/visible on each axis, keeps the framed map inside the area the
 * frame does not cover. The margin is extra map (wrap), never a crop.
 *
 * Pure arithmetic. No vendor I/O.
 */
export interface ProjectedBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function expandProjectedWindow(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  printWIn: number,
  printHIn: number,
  visibleWIn: number | null | undefined,
  visibleHIn: number | null | undefined,
): ProjectedBox {
  if (visibleWIn == null || visibleHIn == null) return { x0, x1, y0, y1 };
  if (!(printWIn > 0) || !(printHIn > 0) || !(visibleWIn > 0) || !(visibleHIn > 0)) {
    return { x0, x1, y0, y1 };
  }
  let nx0 = x0;
  let nx1 = x1;
  let ny0 = y0;
  let ny1 = y1;
  if (visibleWIn < printWIn - 1e-6) {
    const span = nx1 - nx0;
    const want = span * (printWIn / visibleWIn);
    const pad = (want - span) / 2;
    nx0 -= pad;
    nx1 += pad;
  }
  if (visibleHIn < printHIn - 1e-6) {
    const span = ny1 - ny0;
    const want = span * (printHIn / visibleHIn);
    const pad = (want - span) / 2;
    ny0 -= pad;
    ny1 += pad;
  }
  return { x0: nx0, x1: nx1, y0: ny0, y1: ny1 };
}

export interface WrapTarget {
  printWIn: number;
  printHIn: number;
  visibleWIn: number;
  visibleHIn: number;
  visibleFractionW: number;
  visibleFractionH: number;
  hasWrap: boolean;
}

export interface ResolvedPrintWindow {
  visibleFractionW: number;
  visibleFractionH: number;
  visibleWIn: number;
  visibleHIn: number;
  hasWrap: boolean;
  /** False when the editor already expanded bounds to the print area. */
  wrapApplied: boolean;
}

/**
 * The editor snapshot can set dimensionsArePrintArea. That flag means the
 * bounds are already the print sheet, so fulfillment must not expand them
 * again. The file is still rendered at the catalogue print-area centimetres.
 * When the flag is absent, bounds are the visible face and the wrap is applied
 * once.
 */
export function resolvePrintWindow(target: WrapTarget, dimensionsArePrintArea: boolean): ResolvedPrintWindow {
  if (dimensionsArePrintArea) {
    return {
      visibleFractionW: 1,
      visibleFractionH: 1,
      visibleWIn: target.printWIn,
      visibleHIn: target.printHIn,
      hasWrap: false,
      wrapApplied: false,
    };
  }
  return {
    visibleFractionW: target.visibleFractionW,
    visibleFractionH: target.visibleFractionH,
    visibleWIn: target.visibleWIn,
    visibleHIn: target.visibleHIn,
    hasWrap: target.hasWrap,
    wrapApplied: target.hasWrap,
  };
}

/** Viewport passed to zoomForBounds so the visible bounds fill the centre window, not the whole sheet. */
export function innerViewportPx(
  canvasW: number,
  canvasH: number,
  visibleFractionW: number,
  visibleFractionH: number,
): { w: number; h: number } {
  const fw = visibleFractionW > 0 && visibleFractionW <= 1 ? visibleFractionW : 1;
  const fh = visibleFractionH > 0 && visibleFractionH <= 1 ? visibleFractionH : 1;
  return { w: Math.max(1, canvasW * fw), h: Math.max(1, canvasH * fh) };
}
