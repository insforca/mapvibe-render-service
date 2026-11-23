import type { CanvasRenderingContext2D } from 'canvas';

export const CREDIT_HALO = {
  widthFactor: 0.25,
  alpha: 0.6,
  sample: dominantOpaqueColor,
} as const;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const STUDIO_CREDIT = 'created with mapvibestudio.com';

type CreditLayout = { size: number; y: number; leftX: number; rightX: number };
export type CreditBox = { left: number; top: number; right: number; bottom: number };
export type ReadCreditPixels = (box: CreditBox) => ArrayLike<number>;

// Flat map fills repeat exactly. Thin roads and antialiased edges get fewer votes.
// Break ties by RGB value so flipped WebGL rows and canvas rows agree.
function dominantOpaqueColor(pixels: ArrayLike<number>): string | undefined {
  const counts = new Map<number, number>();
  let best = 0, most = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255) continue;
    const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    const count = (counts.get(rgb) ?? 0) + 1;
    counts.set(rgb, count);
    if (count > most || (count === most && rgb < best)) {
      best = rgb;
      most = count;
    }
  }
  return most ? '#' + best.toString(16).padStart(6, '0') : undefined;
}

export function canvasCreditPixels(ctx: CanvasRenderingContext2D): ReadCreditPixels {
  // getImageData uses backing pixels, including the print wrap's face translation.
  const { e, f } = ctx.getTransform();
  return box => {
    const x = Math.max(0, Math.floor(box.left + e));
    const y = Math.max(0, Math.floor(box.top + f));
    const w = Math.min(ctx.canvas.width, Math.ceil(box.right + e)) - x;
    const h = Math.min(ctx.canvas.height, Math.ceil(box.bottom + f)) - y;
    return w > 0 && h > 0 ? ctx.getImageData(x, y, w, h).data : [];
  };
}

/** Paint halos on the map before fades, then fill the same glyphs above the lockup. */
export function paintCredits(
  ctx: CanvasRenderingContext2D, credit: CreditLayout, font: string, includeStudio: boolean,
  paint: { fill: string } | { read: ReadCreditPixels },
) {
  ctx.save();
  try {
    ctx.font = font;
    ctx.textBaseline = 'bottom';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    const line = (text: string, x: number, align: 'left' | 'right') => {
      ctx.textAlign = align;
      if ('fill' in paint) {
        ctx.fillStyle = paint.fill;
        ctx.globalAlpha = 0.9;
        ctx.fillText(text, x, credit.y);
        return;
      }
      const bounds = ctx.measureText(text);
      const left = align === 'right' ? x - bounds.width : x;
      const pixels = paint.read({ left, right: left + bounds.width,
        top: credit.y - bounds.actualBoundingBoxAscent, bottom: credit.y + bounds.actualBoundingBoxDescent });
      const color = CREDIT_HALO.sample(pixels);
      if (color) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = CREDIT_HALO.alpha;
        ctx.lineJoin = 'round';
        ctx.lineWidth = credit.size * CREDIT_HALO.widthFactor;
        ctx.strokeText(text, x, credit.y);
      }
    };
    line(OSM_ATTRIBUTION, credit.rightX, 'right');
    if (includeStudio) line(STUDIO_CREDIT, credit.leftX, 'left');
  } finally {
    ctx.restore();
  }
}
