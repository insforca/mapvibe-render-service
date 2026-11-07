/**
 * Clean-engine poster typography.
 *
 * The editor's poster block (mapvibe.css .mvs-poster-*) is Roboto:
 * city 700 / 6.94cqmin / letter-spacing 0.45em / uppercase,
 * country 300 / 2.55cqmin / uppercase, coordinates 400 / 1.62cqmin.
 * Those cqmin sizes are 250 / 92 / 58 px on a 3600px short side.
 * The strip is normal flow, not a fraction of the sheet. The city is
 * measured, the rule is placed under that ink, then the country, then
 * the coordinates. A fixed fraction (rule at 0.900, country at 0.915)
 * let the country em-box cross the rule. Flow cannot.
 *
 * CSS margins are 3px under the city, 4px under the rule, 3px under the
 * country, and 14px of bottom padding, beside a city that useFitText
 * caps at 44px on screen. Those pixels scale with the city so a print
 * keeps that same gap-to-type ratio. Type scale is min(width, height) /
 * 3600 with no 0.45 floor — the floor held the faces at their 1620px
 * size while the sheet kept shrinking.
 */

import { fadeKind } from './print-parity.js';

export const TEXT_DIMENSION_REFERENCE_PX = 3600;
export const EDGE_MARGIN = 0.02;
const CITY_BASE = 250;
const CITY_MIN = 110;
/** Desktop .mvs-poster-city. The 0.15em value is only the width<=900px override. */
const CITY_SPACING = 0.45;
const COUNTRY_BASE = 92;
/** .mvs-poster-country sets no letter-spacing on desktop. */
const COUNTRY_SPACING = 0;
const COORDS_BASE = 58;
/** .mvs-poster-coords sets no letter-spacing on desktop. */
const COORDS_SPACING = 0;
const ATTRIBUTION_BASE = 30;
/** useFitText ceiling in the editor. CSS px gaps are authored next to it. */
const CITY_SCREEN_CAP_PX = 44;
const STRIP_GAP_CITY_PX = 3;
const STRIP_GAP_RULE_PX = 4;
const STRIP_GAP_COUNTRY_PX = 3;
const STRIP_PAD_BOTTOM_PX = 14;
const STRIP_PAD_X_PX = 18;
const EDITORIAL_INSET = 0.06;

function stripPx(cssPx: number, citySize: number): number {
  return cssPx * (citySize / CITY_SCREEN_CAP_PX);
}

export interface GlyphBox {
  /** Sum of glyph advances at this font size, before letter-spacing. */
  width: number;
  /** Ink above the middle baseline. Whitespace (ascent <= 0) does not count. */
  ascent: number;
  /** Ink below the middle baseline. */
  descent: number;
}

export type GlyphMeasure = (
  role: 'city' | 'country' | 'coords',
  text: string,
  fontPx: number,
) => GlyphBox;

export interface PosterLine {
  text: string;
  x: number;
  y: number;
  size: number;
  spacing: number;
  /** Spaced width actually drawn. */
  width: number;
  ascent: number;
  descent: number;
}

export interface PosterTextLayout {
  ds: number;
  align: 'center' | 'left';
  city: PosterLine;
  divider: { x: number; y: number; width: number; halfStroke: number };
  country: PosterLine;
  coords: PosterLine;
  credit: { size: number; y: number; leftX: number; rightX: number };
}

export function posterDimensionScale(width: number, height: number): number {
  return Math.min(width, height) / TEXT_DIMENSION_REFERENCE_PX;
}

function shrinkFont(base: number, min: number, len: number, spacing: number): number {
  const n = Math.max(len, 1);
  let size = base;
  if (n > 10) size = Math.max(min, base * (10 / n));
  // Width estimate is in the 3600px reference, same as the editor's shrinkFont.
  // A measured clamp below fits the real canvas when this estimate is short.
  const estimatedEm = n * 0.62 + (n - 1) * spacing;
  const maxRefPx = TEXT_DIMENSION_REFERENCE_PX * 0.92;
  if (estimatedEm * size > maxRefPx) size = Math.max(min, maxRefPx / estimatedEm);
  return size;
}

function spacedWidth(ink: GlyphBox, fontPx: number, spacing: number, text: string): number {
  const gaps = Math.max(0, text.length - 1);
  return ink.width + spacing * fontPx * gaps;
}

function fitToWidth(
  role: 'city' | 'country' | 'coords',
  text: string,
  fontPx: number,
  spacing: number,
  maxWidth: number,
  glyph: GlyphMeasure,
): { size: number; ink: GlyphBox; width: number } {
  const first = text ? glyph(role, text, fontPx) : { width: 0, ascent: 0, descent: 0 };
  let size = fontPx;
  const widthAt = (ink: GlyphBox, fs: number) => spacedWidth(ink, fs, spacing, text);
  const firstWidth = widthAt(first, fontPx);
  if (text && firstWidth > maxWidth && firstWidth > 0) {
    size = fontPx * (maxWidth / firstWidth);
  }
  const ink = size === fontPx ? first : glyph(role, text, size);
  return { size, ink, width: widthAt(ink, size) };
}

export function layoutPosterText(input: {
  width: number;
  height: number;
  city: string;
  country: string;
  coords: string;
  textLayout?: string;
  glyph: GlyphMeasure;
}): PosterTextLayout {
  const { width, height, glyph } = input;
  const city = input.city || '';
  const country = input.country || '';
  const coords = input.coords || '';
  const ds = posterDimensionScale(width, height);
  const editorial = input.textLayout === 'editorial';
  const align: 'center' | 'left' = editorial ? 'left' : 'center';
  const x = editorial ? width * EDITORIAL_INSET : width * 0.5;
  // .mvs-poster-divider is border-top: .115cqmin, 0.115% of the short side.
  const halfStroke = (0.00115 * Math.min(width, height)) / 2;
  // 20% on every breakpoint. The mobile stylesheet's 24px rule is preview-only.
  const dividerWidth = width * 0.20;
  const designCity = CITY_BASE * ds;
  const padX = stripPx(STRIP_PAD_X_PX, designCity);
  const maxWidth = editorial
    ? Math.max(1, width * (1 - EDITORIAL_INSET) - padX)
    : Math.max(1, width - 2 * padX);

  const citySize0 = shrinkFont(designCity, CITY_MIN * ds, city.length, CITY_SPACING);
  const cityFit = fitToWidth('city', city, citySize0, CITY_SPACING, maxWidth, glyph);
  const countryFit = fitToWidth('country', country, COUNTRY_BASE * ds, COUNTRY_SPACING, maxWidth, glyph);
  const coordsFit = fitToWidth('coords', coords, COORDS_BASE * ds, COORDS_SPACING, maxWidth, glyph);

  // Flow, top to bottom in canvas coordinates, then shifted so the
  // coordinates sit on the strip's bottom padding. Gaps are outside the
  // measured ink, so a descender cannot reach the next line.
  const gapCity = stripPx(STRIP_GAP_CITY_PX, designCity);
  const gapRule = stripPx(STRIP_GAP_RULE_PX, designCity);
  const gapCountry = stripPx(STRIP_GAP_COUNTRY_PX, designCity);
  // The editor strip has no credit line. Ours sits in the bottom padding,
  // under the coordinates, in Roboto Light.
  const creditSize = ATTRIBUTION_BASE * ds;
  const creditAscent = creditSize * 1.04;
  const bottomInset = stripPx(6, designCity);
  const padBottom = Math.max(
    stripPx(STRIP_PAD_BOTTOM_PX, designCity),
    creditAscent + gapCountry + bottomInset,
  );
  const cityDescent = cityFit.ink.descent > 0 ? cityFit.ink.descent : cityFit.size * 0.2;
  const countryAscent = countryFit.ink.ascent > 0 ? countryFit.ink.ascent : countryFit.size * 0.35;
  const countryDescent = countryFit.ink.descent > 0 ? countryFit.ink.descent : countryFit.size * 0.2;
  const coordsAscent = coordsFit.ink.ascent > 0 ? coordsFit.ink.ascent : coordsFit.size * 0.35;
  const coordsDescent = coordsFit.ink.descent > 0 ? coordsFit.ink.descent : coordsFit.size * 0.2;

  let cityY = 0;
  let dividerY = cityY + cityDescent + gapCity + halfStroke;
  let countryY = dividerY + halfStroke + gapRule + countryAscent;
  let coordsY = countryY + countryDescent + gapCountry + coordsAscent;
  const shift = (height - padBottom - coordsDescent) - coordsY;
  cityY += shift;
  dividerY += shift;
  countryY += shift;
  coordsY += shift;

  const line = (
    text: string,
    y: number,
    fit: { size: number; ink: GlyphBox; width: number },
    spacing: number,
  ): PosterLine => ({
    text,
    x,
    y,
    size: fit.size,
    spacing,
    width: fit.width,
    ascent: fit.ink.ascent,
    descent: fit.ink.descent,
  });

  return {
    ds,
    align,
    city: line(city, cityY, cityFit, CITY_SPACING),
    divider: { x, y: dividerY, width: dividerWidth, halfStroke },
    country: line(country, countryY, countryFit, COUNTRY_SPACING),
    coords: line(coords, coordsY, coordsFit, COORDS_SPACING),
    credit: {
      size: creditSize,
      y: height - bottomInset,
      leftX: width * EDGE_MARGIN,
      rightX: width * (1 - EDGE_MARGIN),
    },
  };
}

export function fmtCoords(lat: number, lon: number): string {
  return Math.abs(lat).toFixed(4) + '\u00b0 ' + (lat >= 0 ? 'N' : 'S')
    + ' / ' + Math.abs(lon).toFixed(4) + '\u00b0 ' + (lon >= 0 ? 'E' : 'W');
}

export function fmtCity(city: string): string {
  if (!city) return '';
  let latin = 0;
  let letters = 0;
  for (let i = 0; i < city.length; i++) {
    const ch = city[i];
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) { latin++; letters++; }
    else if (/\p{L}/u.test(ch)) letters++;
  }
  return (letters === 0 || latin / letters > 0.8) ? city.toUpperCase() : city;
}

function drawSpaced(
  ctx: any,
  text: string,
  x: number,
  y: number,
  spacingEm: number,
  fontPx: number,
  align: 'center' | 'left',
): void {
  if (spacingEm === 0 || text.length === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  const gap = spacingEm * fontPx;
  const total = ctx.measureText(text).width + gap * (text.length - 1);
  let cursor = align === 'center' ? x - total / 2 : x;
  const saved = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + gap;
  }
  ctx.textAlign = saved;
}

function measureCanvasGlyph(ctx: any, font: string, text: string): GlyphBox {
  ctx.font = font;
  ctx.textBaseline = 'middle';
  // Whole-string width matches drawSpaced's centering measure. Vertical
  // extent is per glyph so a space (negative ascent) cannot pad the line box.
  const width = text ? ctx.measureText(text).width : 0;
  let ascent = 0;
  let descent = 0;
  for (const ch of text) {
    const g = ctx.measureText(ch);
    const a = g.actualBoundingBoxAscent || 0;
    const d = g.actualBoundingBoxDescent || 0;
    if (a > 0) {
      if (a > ascent) ascent = a;
      if (d > descent) descent = d;
    }
  }
  return { width, ascent, descent };
}

export function drawPosterText(
  ctx: any,
  W: number,
  H: number,
  theme: any,
  lat: number,
  lon: number,
  city: string,
  country: string,
  fontFamily: string,
  showText: boolean,
  credits: boolean,
  textLayout: string,
): void {
  const land = (theme && theme.map && theme.map.land) || '#808080';
  const rgb = parseHex(land);
  const luma = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  const textColor = (theme && theme.ui && theme.ui.text) || (luma < 0.5 ? '#FFFFFF' : '#111111');
  const attrColor = luma < 0.52 ? '#f5faff' : '#0e1822';
  // Roboto Light is registered under its own family. node-canvas collapses
  // Light and Regular when both files keep the name-table family "Roboto".
  const titleFamily = fontFamily
    ? '"' + fontFamily + '",Roboto,sans-serif'
    : 'Roboto';
  const lightFamily = fontFamily
    ? '"' + fontFamily + '","Roboto Light",Roboto,sans-serif'
    : '"Roboto Light",Roboto,sans-serif';

  let laid: PosterTextLayout | undefined;
  if (showText) {
    laid = layoutPosterText({
      width: W,
      height: H,
      city: fmtCity(city || ''),
      country: (country || '').toUpperCase(),
      coords: fmtCoords(lat, lon),
      textLayout,
      glyph: (role, text, fontPx) => {
        const font = role === 'city'
          ? '700 ' + fontPx + 'px ' + titleFamily
          : role === 'country'
            ? '300 ' + fontPx + 'px ' + lightFamily
            : '400 ' + fontPx + 'px ' + titleFamily;
        return measureCanvasGlyph(ctx, font, text);
      },
    });

    ctx.fillStyle = textColor;
    ctx.textAlign = laid.align;
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + laid.city.size + 'px ' + titleFamily;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    drawSpaced(ctx, laid.city.text, laid.city.x, laid.city.y, laid.city.spacing, laid.city.size, laid.align);

    ctx.strokeStyle = textColor;
    ctx.lineWidth = laid.divider.halfStroke * 2;
    ctx.beginPath();
    if (laid.align === 'center') {
      ctx.moveTo(laid.divider.x - laid.divider.width / 2, laid.divider.y);
      ctx.lineTo(laid.divider.x + laid.divider.width / 2, laid.divider.y);
    } else {
      ctx.moveTo(laid.divider.x, laid.divider.y);
      ctx.lineTo(laid.divider.x + laid.divider.width, laid.divider.y);
    }
    ctx.stroke();

    ctx.font = '300 ' + laid.country.size + 'px ' + lightFamily;
    drawSpaced(ctx, laid.country.text, laid.country.x, laid.country.y, laid.country.spacing, laid.country.size, laid.align);

    ctx.globalAlpha = 0.7;
    ctx.font = '400 ' + laid.coords.size + 'px ' + titleFamily;
    drawSpaced(ctx, laid.coords.text, laid.coords.x, laid.coords.y, laid.coords.spacing, laid.coords.size, laid.align);
    ctx.globalAlpha = 1;
  }

  const creditSize = laid ? laid.credit.size : ATTRIBUTION_BASE * posterDimensionScale(W, H);
  const creditY = laid ? laid.credit.y : H * (1 - EDGE_MARGIN);
  const creditLeft = laid ? laid.credit.leftX : W * EDGE_MARGIN;
  const creditRight = laid ? laid.credit.rightX : W * (1 - EDGE_MARGIN);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = attrColor;
  ctx.globalAlpha = 0.9;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = '300 ' + creditSize + 'px ' + lightFamily;
  ctx.fillText('\u00a9 OpenStreetMap contributors', creditRight, creditY);
  ctx.globalAlpha = 1;
  if (credits) {
    ctx.fillStyle = attrColor;
    ctx.globalAlpha = 0.9;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.font = '300 ' + creditSize + 'px ' + lightFamily;
    ctx.fillText('created with mapvibestudio.com', creditLeft, creditY);
    ctx.globalAlpha = 1;
  }
}

function withAlpha(hex: string, alpha: number): string {
  let h = (hex || '#000').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + alpha + ')';
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '#808080').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

function dither(ctx: any, rx: number, ry: number, w: number, h: number, intensity?: number): void {
  const i = intensity ?? 4;
  const rw = Math.round(w);
  const rh = Math.round(h);
  if (rw <= 0 || rh <= 0) return;
  const t = ctx.getTransform();
  const ax = Math.round(rx + t.e);
  const ay = Math.round(ry + t.f);
  const id = ctx.getImageData(ax, ay, rw, rh);
  const d = id.data;
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let py = 0; py < rh; py++) {
    const rb = py * rw;
    const br = (py & 3) * 4;
    for (let px = 0; px < rw; px++) {
      const ii = (rb + px) * 4;
      const dv = Math.round(((B[br + (px & 3)] / 15) - 0.5) * 2 * i);
      d[ii] = Math.max(0, Math.min(255, d[ii] + dv));
      d[ii + 1] = Math.max(0, Math.min(255, d[ii + 1] + dv));
      d[ii + 2] = Math.max(0, Math.min(255, d[ii + 2] + dv));
    }
  }
  ctx.putImageData(id, ax, ay);
}

/** Bottom (and, for fadeStyle 'text', top) gradient behind the poster lines.
 *  fullbleed is the editor GradientFades bottom ease-in, the same stops as default.
 */
export function applyFades(ctx: any, W: number, H: number, color: string, fadeStyle: string, layout?: string): void {
  const kind = fadeKind(fadeStyle);
  if (kind === 'none') return;
  if (kind === 'text') {
    const tH = Math.round(H * 0.25);
    const tg = ctx.createLinearGradient(0, 0, 0, tH);
    tg.addColorStop(0, withAlpha(color, 1));
    tg.addColorStop(0.4, withAlpha(color, 0.45));
    tg.addColorStop(0.7, withAlpha(color, 0.12));
    tg.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = tg;
    ctx.fillRect(0, 0, W, tH);
    dither(ctx, 0, 0, W, tH);
    const fH = Math.round(H * 0.065);
    const gH = Math.round(H * 0.15);
    const fT = H - fH - gH;
    const fg = ctx.createLinearGradient(0, fT, 0, fT + gH);
    fg.addColorStop(0, withAlpha(color, 0));
    fg.addColorStop(0.10, withAlpha(color, 0.04));
    fg.addColorStop(0.22, withAlpha(color, 0.10));
    fg.addColorStop(0.36, withAlpha(color, 0.26));
    fg.addColorStop(0.5, withAlpha(color, 0.44));
    fg.addColorStop(0.64, withAlpha(color, 0.63));
    fg.addColorStop(0.76, withAlpha(color, 0.80));
    fg.addColorStop(0.87, withAlpha(color, 0.92));
    fg.addColorStop(0.95, withAlpha(color, 0.98));
    fg.addColorStop(1, color);
    ctx.fillStyle = fg;
    ctx.fillRect(0, fT, W, gH);
    ctx.fillStyle = color;
    ctx.fillRect(0, H - fH, W, fH);
    dither(ctx, 0, fT, W, gH + fH);
    return;
  }

  // Keep the previous fade geometry. Text layout no longer uses this anchor.
  const ds = Math.max(0.45, posterDimensionScale(W, H));
  const cityAnchor = H * (layout === 'editorial' ? 0.820 : 0.885);
  const bandTop = cityAnchor - CITY_BASE * ds * 0.55;
  const bY = Math.round(Math.max(bandTop - H * 0.035, H * 0.6));
  const bH = H - bY;
  const bg = ctx.createLinearGradient(0, H, 0, bY);
  if (process.env.DISABLE_EASEIN_FADE === 'true') {
    bg.addColorStop(0, withAlpha(color, 1));
    bg.addColorStop(0.30, withAlpha(color, 0.70));
    bg.addColorStop(0.65, withAlpha(color, 0.20));
    bg.addColorStop(1, withAlpha(color, 0));
  } else {
    bg.addColorStop(0, withAlpha(color, 1));
    bg.addColorStop(0.12, withAlpha(color, 0.94));
    bg.addColorStop(0.26, withAlpha(color, 0.80));
    bg.addColorStop(0.40, withAlpha(color, 0.62));
    bg.addColorStop(0.54, withAlpha(color, 0.43));
    bg.addColorStop(0.66, withAlpha(color, 0.27));
    bg.addColorStop(0.78, withAlpha(color, 0.14));
    bg.addColorStop(0.88, withAlpha(color, 0.055));
    bg.addColorStop(0.95, withAlpha(color, 0.014));
    bg.addColorStop(1, withAlpha(color, 0));
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, bY, W, bH);
  dither(ctx, 0, bY, W, bH);
}
