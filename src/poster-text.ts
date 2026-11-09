/**
 * Clean-engine poster typography.
 *
 * The editor's poster block (mapvibe.css .mvs-poster-*) is normal flow,
 * not a fraction of the sheet and not a stack of glyph ink:
 *   .mvs-poster-text-strip   padding 6px 18px 14px
 *   .mvs-poster-city         Roboto 700 / 6.94cqmin / letter-spacing 0.45em
 *                            margin 0 0 3px
 *   .mvs-poster-divider      border-top 1px, width 20% of the content box,
 *                            margin 0 auto 4px
 *   .mvs-poster-country      Roboto 300 / 2.55cqmin, margin 0 0 3px
 *   .mvs-poster-coords       Roboto 400 / 1.62cqmin, margin 1em 0
 * Adjacent vertical margins collapse, so the 3px under the country and
 * the 1em above the coordinates become max(3px, 1em). Each line's box is
 * CSS line-height 1.15, with the alphabetic baseline where Chrome puts it
 * for Roboto: half-leading around the hhea content box (ascender 1900,
 * descender 500, unitsPerEm 2048). Centred letter-spacing keeps a trailing
 * gap, so the city ink sits 0.225em left of the content-box centre.
 *
 * The 6/18/14/3/4/1px lengths are the desktop editor's CSS pixels on a
 * 482.390625px-wide poster (18×24 at the measured preview). They scale
 * with the short side, which is how cqmin and those pixels stay in the
 * same proportion on a print. python/poster_text.py is the same model.
 */

import {
  EDITOR_BOTTOM_FADE_HEIGHT,
  EDITOR_BOTTOM_FADE_STOPS,
  fadeKind,
} from './print-parity.js';

export const TEXT_DIMENSION_REFERENCE_PX = 3600;
export const EDGE_MARGIN = 0.02;
/** Short side of the desktop poster the editor DOM was measured on. */
export const EDITOR_POSTER_SHORT_PX = 482.390625;
/** line-height used by the editor's Roboto strip. Normal is the font's 1.17; the preview boxes are 1.15. */
export const CSS_LINE_HEIGHT = 1.15;
const ROBOTO_HHEA_ASCENT = 1900 / 2048;
const ROBOTO_HHEA_LINE = (1900 + 500) / 2048;
/** Alphabetic baseline, in em, down from the top of a 1.15em line box. */
export const CSS_BASELINE_EM = ROBOTO_HHEA_ASCENT + (CSS_LINE_HEIGHT - ROBOTO_HHEA_LINE) / 2;

const CITY_MIN = 110;
const CITY_CQMIN = 0.0694;
const COUNTRY_CQMIN = 0.0255;
const COORDS_CQMIN = 0.0162;
/** Desktop .mvs-poster-city. The 0.15em value is only the width<=900px override. */
const CITY_SPACING = 0.45;
/** .mvs-poster-country sets no letter-spacing on desktop. */
const COUNTRY_SPACING = 0;
/** .mvs-poster-coords sets no letter-spacing on desktop. */
const COORDS_SPACING = 0;
const ATTRIBUTION_BASE = 30;
const STRIP_PAD_TOP_PX = 6;
const STRIP_PAD_X_PX = 18;
const STRIP_PAD_BOTTOM_PX = 14;
const CITY_MARGIN_BOTTOM_PX = 3;
const RULE_MARGIN_BOTTOM_PX = 4;
const COUNTRY_MARGIN_BOTTOM_PX = 3;
/** Computed border-top of .mvs-poster-divider at the reference poster. */
const RULE_BORDER_PX = 1;
const CREDIT_EDGE_PX = 6;
const EDITORIAL_INSET = 0.06;

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
  /** Spaced width actually drawn, without CSS's trailing letter-spacing gap. */
  width: number;
  ascent: number;
  descent: number;
  /** Top of the CSS line box. */
  boxTop: number;
  /** CSS line-box height. Zero when the line is not rendered. */
  boxHeight: number;
}

export interface PosterTextLayout {
  ds: number;
  align: 'center' | 'left';
  city: PosterLine;
  divider: { x: number; y: number; width: number; halfStroke: number };
  country: PosterLine;
  coords: PosterLine;
  /** Top of .mvs-poster-text-strip, in canvas pixels from the top of the poster. */
  stripTop: number;
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

function spacedWidth(ink: GlyphBox, fontPx: number, spacing: number, text: string, trailing: boolean): number {
  const gaps = Math.max(0, text.length - 1);
  const extra = trailing && spacing > 0 && text.length > 0 ? 1 : 0;
  return ink.width + spacing * fontPx * (gaps + extra);
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
  // The fit uses the CSS inline size, which includes the trailing letter-spacing gap.
  const inlineAt = (ink: GlyphBox, fs: number) => spacedWidth(ink, fs, spacing, text, true);
  const firstWidth = inlineAt(first, fontPx);
  if (text && firstWidth > maxWidth && firstWidth > 0) {
    size = fontPx * (maxWidth / firstWidth);
  }
  const ink = size === fontPx ? first : glyph(role, text, size);
  return { size, ink, width: spacedWidth(ink, size, spacing, text, false) };
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
  const anchorX = editorial ? width * EDITORIAL_INSET : width * 0.5;
  const short = Math.min(width, height);
  const css = short / EDITOR_POSTER_SHORT_PX;
  const px = (cssPx: number) => cssPx * css;
  // 1px at the reference poster, scaled with the sheet. 20% of the content
  // box (the strip's 18px side padding), not 20% of the full sheet.
  const border = px(RULE_BORDER_PX);
  const halfStroke = border / 2;
  const padX = px(STRIP_PAD_X_PX);
  const dividerWidth = 0.20 * Math.max(1, width - 2 * padX);
  const maxWidth = editorial
    ? Math.max(1, width * (1 - EDITORIAL_INSET) - padX)
    : Math.max(1, width - 2 * padX);

  const citySize0 = shrinkFont(CITY_CQMIN * short, CITY_MIN * ds, city.length, CITY_SPACING);
  const cityFit = fitToWidth('city', city, citySize0, CITY_SPACING, maxWidth, glyph);
  const countryFit = fitToWidth('country', country, COUNTRY_CQMIN * short, COUNTRY_SPACING, maxWidth, glyph);
  const coordsFit = fitToWidth('coords', coords, COORDS_CQMIN * short, COORDS_SPACING, maxWidth, glyph);

  // CSS block flow inside the strip's padding. Vertical margins collapse.
  // y grows downward. The strip is bottom-aligned, so the stack is shifted
  // to sit on the 14px bottom padding. Line boxes are 1.15em; a descender
  // stays inside its box instead of pushing the next line down.
  interface FlowBlock { box: number; marginTop: number; marginBottom: number }
  const blocks: FlowBlock[] = [];
  if (city) blocks.push({ box: cityFit.size * CSS_LINE_HEIGHT, marginTop: 0, marginBottom: px(CITY_MARGIN_BOTTOM_PX) });
  blocks.push({ box: border, marginTop: 0, marginBottom: px(RULE_MARGIN_BOTTOM_PX) });
  if (country) blocks.push({ box: countryFit.size * CSS_LINE_HEIGHT, marginTop: 0, marginBottom: px(COUNTRY_MARGIN_BOTTOM_PX) });
  if (coords) blocks.push({ box: coordsFit.size * CSS_LINE_HEIGHT, marginTop: coordsFit.size, marginBottom: coordsFit.size });

  const placed: Array<{ top: number; bottom: number }> = [];
  let cursor = 0;
  let prevMarginBottom = 0;
  for (const block of blocks) {
    const gap = placed.length === 0 ? block.marginTop : Math.max(prevMarginBottom, block.marginTop);
    const top = cursor + gap;
    const bottom = top + block.box;
    placed.push({ top, bottom });
    cursor = bottom;
    prevMarginBottom = block.marginBottom;
  }
  const contentBottom = cursor + prevMarginBottom;
  const padTop = px(STRIP_PAD_TOP_PX);
  const padBottom = px(STRIP_PAD_BOTTOM_PX);
  const stripTop = height - (padTop + contentBottom + padBottom);
  const origin = stripTop + padTop;

  let slot = 0;
  const take = () => {
    const box = placed[slot];
    slot += 1;
    return box;
  };
  const cityBox = city ? take() : { top: 0, bottom: 0 };
  const ruleBox = take();
  const countryBox = country ? take() : { top: 0, bottom: 0 };
  const coordsBox = coords ? take() : { top: 0, bottom: 0 };
  const baselineY = (box: { top: number }, size: number, text: string) =>
    origin + box.top + (text ? CSS_BASELINE_EM * size : 0);

  // Trailing letter-spacing is part of the centred inline box, so the ink
  // sits half a spacing to the left. Left-aligned editorial text starts at
  // the inset; the trailing gap only extends to the right.
  const cityX = align === 'center' && city
    ? anchorX - (CITY_SPACING / 2) * cityFit.size
    : anchorX;

  const line = (
    text: string,
    y: number,
    lineX: number,
    fit: { size: number; ink: GlyphBox; width: number },
    spacing: number,
    box: { top: number; bottom: number },
  ): PosterLine => ({
    text,
    x: lineX,
    y,
    size: fit.size,
    spacing,
    width: fit.width,
    ascent: fit.ink.ascent,
    descent: fit.ink.descent,
    boxTop: origin + box.top,
    boxHeight: text ? box.bottom - box.top : 0,
  });

  // The editor has no credit line. Ours is Roboto Light in the bottom
  // padding, under the coordinates, and does not move the strip.
  const creditSize = ATTRIBUTION_BASE * ds;
  const bottomInset = px(CREDIT_EDGE_PX);

  return {
    ds,
    align,
    city: line(city, baselineY(cityBox, cityFit.size, city), cityX, cityFit, CITY_SPACING, cityBox),
    divider: {
      x: anchorX,
      y: origin + (ruleBox.top + ruleBox.bottom) / 2,
      width: dividerWidth,
      halfStroke,
    },
    country: line(country, baselineY(countryBox, countryFit.size, country), anchorX, countryFit, COUNTRY_SPACING, countryBox),
    coords: line(coords, baselineY(coordsBox, coordsFit.size, coords), anchorX, coordsFit, COORDS_SPACING, coordsBox),
    stripTop,
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
  ctx.textBaseline = 'alphabetic';
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
    ctx.textBaseline = 'alphabetic';
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
 *  fullbleed / default is the editor's `.poster-fade` bottom 14% ease-in.
 *  The sheet fraction is the band; the stops are fractions of that band.
 *  No dither: the editor gradient is smooth, and a ±4 dither shifted the cream.
 */
export function applyFades(ctx: any, W: number, H: number, color: string, fadeStyle: string, _layout?: string): void {
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

  // Editor `.poster-fade` / `.poster-fade--bottom`: height 14%, pinned to the bottom.
  const bH = Math.max(1, Math.round(H * EDITOR_BOTTOM_FADE_HEIGHT));
  const bY = H - bH;
  const bg = ctx.createLinearGradient(0, H, 0, bY);
  const stops = process.env.DISABLE_EASEIN_FADE === 'true'
    ? [[0, 1], [0.30, 0.70], [0.65, 0.20], [1, 0]] as const
    : EDITOR_BOTTOM_FADE_STOPS;
  for (const [t, a] of stops) bg.addColorStop(t, withAlpha(color, a));
  ctx.fillStyle = bg;
  ctx.fillRect(0, bY, W, bH);
}
