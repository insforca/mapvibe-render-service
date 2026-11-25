import { canvasCreditPixels, paintCredits } from './credit-halo.js';
import { innerViewportPx, type ResolvedPrintWindow } from './print-window.js';
import { fontOutline } from './font-outline.js';
import { resolvePickerFont, pickerFamily } from './picker-fonts.js';
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
 * for the selected lockup (see LOCKUP_METRICS). Roboto preserves the
 * historical baseline; space-plex uses the bundled faces' hhea metrics.
 * Centred letter-spacing keeps a trailing gap, so the city ink sits
 * 0.225em left of the content-box centre.
 *
 * The 6/18/14/3/4/1px lengths are the desktop editor's CSS pixels on a
 * 482.390625px-wide poster (18×24 at the measured preview). They scale
 * with the short side, which is how cqmin and those pixels stay in the
 * same proportion on a print.
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
export type LockupFont = 'space-plex' | 'roboto';
/** New-design producers must persist this id; absent snapshots remain legacy. */
export const DEFAULT_LOCKUP_FONT: LockupFont = 'space-plex';

export function resolveLockupFont(value?: unknown): LockupFont {
  if (value === 'space-plex' || value === 'roboto') return value;
  if (value !== undefined) console.warn('[fonts] Unknown lockupFont; falling back to roboto');
  return 'roboto';
}

export interface LockupOptions {
  lockupLayout?: 'v2';
  showCity?: boolean;
  showCountry?: boolean;
  showCoords?: boolean;
  /** Framed products: keep the credits this many px from every trim edge. */
  creditInsetPx?: number;
}
export function resolveLockupLayout(value?: unknown): 'v2' | undefined {
  if (value === 'v2') return value;
  if (value !== undefined) console.warn('[lockup] Unknown lockupLayout; falling back to legacy');
  return undefined;
}
export function resolveLineToggle(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value !== undefined) console.warn('[lockup] Non-boolean ' + field + '; ignoring');
  return true;
}
/** Ivan's option A Small. Reference lengths scale by short / 482.390625. */
export const LOCKUP_V2 = { city: .055, country: .025, coords: .021, citySpacing: .12,
  countrySpacing: .14, coordsSpacing: .04, padX: 38.59125, padTop: 6, padBottom: 14,
  cityMarginBottom: 3, ruleMarginBottom: 4, countryMarginBottom: 3, coordMargin: .4,
  ruleHeight: 1, dividerWidth: .2, safeWidth: .84 } as const;

/** Approved v2 oval: em padding, radius scale and [normalized radius, alpha] stops. */
export const LOCKUP_V2_OVAL = {
  paddingX: 1.2,
  paddingY: .9,
  scale: 1.35,
  stops: [[0, .85], [.5, .85], [.62, .78], [.72, .62], [.8, .44],
    [.87, .27], [.93, .12], [.97, .04], [1, 0]],
} as const;

export function lockupFadeEllipse(layout?: PosterTextLayout) {
  if (!layout) return;
  const lines = [layout.city, layout.country, layout.coords].filter(line => line.text);
  if (!lines.length) return;
  const widest = lines.reduce((a, b) => a.width >= b.width ? a : b);
  const top = Math.min(...lines.map(line => line.y - line.ascent));
  const bottom = Math.max(...lines.map(line => line.y + line.descent));
  const size = lines[0].size;
  const { paddingX, paddingY, scale } = LOCKUP_V2_OVAL;
  return {
    // The divider keeps the poster centre anchor even when its width is zero.
    cx: layout.align === 'center' ? layout.divider.x : widest.x + widest.width / 2,
    cy: (top + bottom) / 2,
    rx: (widest.width / 2 + paddingX * size) * scale,
    ry: ((bottom - top) / 2 + paddingY * size) * scale,
  };
}

/** Explicit editor CSS line-height, shared by both lockups (not font "normal"). */
export const CSS_LINE_HEIGHT = 1.15;
function faceMetrics(ascent: number, descent: number, unitsPerEm: number) {
  const normalLineEm = (ascent + descent) / unitsPerEm;
  const halfLeadingEm = (CSS_LINE_HEIGHT - normalLineEm) / 2;
  return { lineHeight: CSS_LINE_HEIGHT, normalLineEm, halfLeadingEm,
    baselineEm: ascent / unitsPerEm + halfLeadingEm };
}
/** Studio mirror: hhea ascent / positive descent / head.unitsPerEm.
 * Space Grotesk Bold 984/292/1000 => baseline .921;
 * Plex Mono Light and Regular 1025/275/1000 => .950.
 * Keep explicit 1.15 line boxes; negative half-leading is intentional.
 * Legacy Roboto freezes the previous 1900/500/2048 layout => .916796875.
 * Those historical constants are NOT the bundled Roboto's actual hhea
 * (2146/555/2048). Correcting them would move existing orders' baselines.
 */
export const LOCKUP_METRICS = {
  roboto: { city: faceMetrics(1900, 500, 2048), country: faceMetrics(1900, 500, 2048), coords: faceMetrics(1900, 500, 2048) },
  'space-plex': { city: faceMetrics(984, 292, 1000), country: faceMetrics(1025, 275, 1000), coords: faceMetrics(1025, 275, 1000) },
};
export const CSS_BASELINE_EM = LOCKUP_METRICS.roboto.city.baselineEm;

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
  lockupFont?: LockupFont;
  glyph: GlyphMeasure;
  baselineEm?: Partial<Record<'city' | 'country' | 'coords', number>>;
} & LockupOptions): PosterTextLayout {
  const { width, height, glyph } = input;
  const metrics = LOCKUP_METRICS[input.lockupFont ?? 'roboto'];
  const v2 = resolveLockupLayout(input.lockupLayout) === 'v2';
  const city = resolveLineToggle(input.showCity, 'showCity') ? input.city || '' : '';
  const country = resolveLineToggle(input.showCountry, 'showCountry') ? input.country || '' : '';
  const coords = resolveLineToggle(input.showCoords, 'showCoords') ? input.coords || '' : '';
  const citySpacing = v2 ? LOCKUP_V2.citySpacing : CITY_SPACING;
  const countrySpacing = v2 ? LOCKUP_V2.countrySpacing : COUNTRY_SPACING;
  const coordsSpacing = v2 ? LOCKUP_V2.coordsSpacing : COORDS_SPACING;
  const ds = posterDimensionScale(width, height);
  const editorial = input.textLayout === 'editorial';
  const align: 'center' | 'left' = editorial ? 'left' : 'center';
  const anchorX = editorial ? width * EDITORIAL_INSET : width * 0.5;
  const short = Math.min(width, height);
  const css = short / EDITOR_POSTER_SHORT_PX;
  const px = (cssPx: number) => cssPx * css;
  // 1px at the reference poster, scaled with the sheet. 20% of the content
  // box (the strip's 18px side padding), not 20% of the full sheet.
  const border = px(v2 ? LOCKUP_V2.ruleHeight : RULE_BORDER_PX);
  const halfStroke = border / 2;
  const padX = px(v2 ? LOCKUP_V2.padX : STRIP_PAD_X_PX);
  const dividerWidth = (v2 ? LOCKUP_V2.dividerWidth : 0.20) * Math.max(1, width - 2 * padX);
  const maxWidth = v2 ? width * LOCKUP_V2.safeWidth : editorial
    ? Math.max(1, width * (1 - EDITORIAL_INSET) - padX)
    : Math.max(1, width - 2 * padX);

  const citySize0 = v2 ? LOCKUP_V2.city * short : shrinkFont(CITY_CQMIN * short, CITY_MIN * ds, city.length, CITY_SPACING);
  const cityFit = fitToWidth('city', city, citySize0, citySpacing, maxWidth, glyph);
  const countryFit = fitToWidth('country', country, (v2 ? LOCKUP_V2.country : COUNTRY_CQMIN) * short, countrySpacing, maxWidth, glyph);
  const coordsFit = fitToWidth('coords', coords, (v2 ? LOCKUP_V2.coords : COORDS_CQMIN) * short, coordsSpacing, maxWidth, glyph);

  // CSS block flow inside the strip's padding. Vertical margins collapse.
  // y grows downward. The strip is bottom-aligned, so the stack is shifted
  // to sit on the 14px bottom padding. Line boxes are 1.15em; a descender
  // stays inside its box instead of pushing the next line down.
  interface FlowBlock { box: number; marginTop: number; marginBottom: number }
  const blocks: FlowBlock[] = [];
  if (city) blocks.push({ box: cityFit.size * metrics.city.lineHeight, marginTop: 0, marginBottom: px(v2 ? LOCKUP_V2.cityMarginBottom : CITY_MARGIN_BOTTOM_PX) });
  // Keep unmodified legacy snapshots byte-for-byte, including their unconditional rule.
  const rule = (!!city && !!(country || coords)) || (!v2 && ![input.showCity, input.showCountry, input.showCoords].some(value => typeof value === 'boolean'));
  if (rule) blocks.push({ box: border, marginTop: 0, marginBottom: px(v2 ? LOCKUP_V2.ruleMarginBottom : RULE_MARGIN_BOTTOM_PX) });
  if (country) blocks.push({ box: countryFit.size * metrics.country.lineHeight, marginTop: 0, marginBottom: px(v2 ? LOCKUP_V2.countryMarginBottom : COUNTRY_MARGIN_BOTTOM_PX) });
  if (coords) blocks.push({ box: coordsFit.size * metrics.coords.lineHeight, marginTop: coordsFit.size * (v2 ? LOCKUP_V2.coordMargin : 1), marginBottom: coordsFit.size * (v2 ? LOCKUP_V2.coordMargin : 1) });

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
  const padTop = px(v2 ? LOCKUP_V2.padTop : STRIP_PAD_TOP_PX);
  const padBottom = px(v2 ? LOCKUP_V2.padBottom : STRIP_PAD_BOTTOM_PX);
  const stripTop = height - (padTop + contentBottom + padBottom);
  const origin = stripTop + padTop;

  let slot = 0;
  const take = () => {
    const box = placed[slot];
    slot += 1;
    return box;
  };
  const cityBox = city ? take() : { top: 0, bottom: 0 };
  const ruleBox = rule ? take() : { top: 0, bottom: 0 };
  const countryBox = country ? take() : { top: 0, bottom: 0 };
  const coordsBox = coords ? take() : { top: 0, bottom: 0 };
  const baselineY = (box: { top: number }, size: number, text: string, role: 'city' | 'country' | 'coords') =>
    origin + box.top + (text ? (input.baselineEm?.[role] ?? metrics[role].baselineEm) * size : 0);

  // Trailing letter-spacing is part of the centred inline box, so the ink
  // sits half a spacing to the left. Left-aligned editorial text starts at
  // the inset; the trailing gap only extends to the right.
  const cityX = align === 'center' && city
    ? anchorX - (citySpacing / 2) * cityFit.size
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


  return {
    ds,
    align,
    city: line(city, baselineY(cityBox, cityFit.size, city, 'city'), cityX, cityFit, citySpacing, cityBox),
    divider: {
      x: anchorX,
      y: origin + (ruleBox.top + ruleBox.bottom) / 2,
      width: rule ? dividerWidth : 0,
      halfStroke,
    },
    country: line(country, baselineY(countryBox, countryFit.size, country, 'country'), align === 'center' ? anchorX - countrySpacing * countryFit.size / 2 : anchorX, countryFit, countrySpacing, countryBox),
    coords: line(coords, baselineY(coordsBox, coordsFit.size, coords, 'coords'), align === 'center' ? anchorX - coordsSpacing * coordsFit.size / 2 : anchorX, coordsFit, coordsSpacing, coordsBox),
    stripTop: blocks.length ? stripTop : height,
    credit: layoutPosterCredits(width, height, true),
  };
}

function layoutPosterCredits(width: number, height: number, showText: boolean, inset = 0): PosterTextLayout['credit'] {
  const y = showText ? height - CREDIT_EDGE_PX * (Math.min(width, height) / EDITOR_POSTER_SHORT_PX) : height * (1 - EDGE_MARGIN);
  return {
    size: ATTRIBUTION_BASE * posterDimensionScale(width, height),
    y: Math.min(y, height - inset),
    leftX: Math.max(width * EDGE_MARGIN, inset),
    rightX: Math.min(width * (1 - EDGE_MARGIN), width - inset),
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
  v2 = false,
): void {
  if (spacingEm === 0 || text.length === 0) {
    ctx.fillText(text, x + 1, y); // DELIBERATE BREAK (parity proof), reverted next commit
    return;
  }
  const gap = spacingEm * fontPx;
  const total = (v2 ? [...text].reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) : ctx.measureText(text).width) + gap * (text.length - 1);
  let cursor = align === 'center' ? x - total / 2 : x;
  const saved = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + gap;
  }
  ctx.textAlign = saved;
}

function measureCanvasGlyph(ctx: any, font: string, text: string, v2 = false): GlyphBox {
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  // Legacy uses whole-string width; v2 sums the same glyph advances it draws. Vertical
  // extent is per glyph so a space (negative ascent) cannot pad the line box.
  const width = v2 ? [...text].reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) : text ? ctx.measureText(text).width : 0;
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
  lockupFont?: LockupFont,
  options: LockupOptions = {},
  beforeDraw?: (layout?: PosterTextLayout) => void,
): void {
  const v2 = resolveLockupLayout(options.lockupLayout) === 'v2';
  if (v2) ctx.fontKerning = 'none';
  const land = (theme && theme.map && theme.map.land) || '#808080';
  const rgb = parseHex(land);
  const luma = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  const textColor = (theme && theme.ui && theme.ui.text) || (luma < 0.5 ? '#FFFFFF' : '#111111');
  const attrColor = luma < 0.52 ? '#f5faff' : '#0e1822';
  // Roboto Light is registered under its own family. node-canvas collapses
  // Light and Regular when both files keep the name-table family "Roboto".
  // A picker font chosen by the customer always wins family selection.
  // Layout versioning is independent, so v2 also uses picker metrics. The
  // lockup id only replaces the default (Roboto) when no picker font is set.
  // A blank or whitespace-only fontFamily means "no picker font".
  const pickerValue = (fontFamily || '').trim();
  const picker = resolvePickerFont(pickerValue);
  const selectedLockup: LockupFont = pickerValue ? 'roboto' : resolveLockupFont(lockupFont);
  const spacePlex = selectedLockup === 'space-plex';
  const titleFamily = spacePlex ? '"Space Grotesk"' : picker
    ? pickerFamily(picker, 700) + ',Roboto,sans-serif' : 'Roboto';
  const lightFamily = spacePlex ? '"IBM Plex Mono Light"' : picker
    ? pickerFamily(picker, 300) + ',"Roboto Light",Roboto,sans-serif' : '"Roboto Light",Roboto,sans-serif';
  const coordsFamily = spacePlex ? '"IBM Plex Mono"' : picker
    ? pickerFamily(picker, 400) + ',Roboto,sans-serif' : 'Roboto';
  const creditFamily = spacePlex ? coordsFamily : lightFamily;
  const creditWeight = spacePlex ? '400' : '300';

  const credit = layoutPosterCredits(W, H, showText, options.creditInsetPx);
  const creditFont = creditWeight + ' ' + credit.size + 'px ' + creditFamily;
  if (v2) paintCredits(ctx, credit, creditFont, credits, { read: canvasCreditPixels(ctx) });

  const faceFile = (role: 'city' | 'country' | 'coords') => {
    const weight = role === 'city' ? 700 : role === 'country' ? 300 : 400;
    return picker ? (picker.faces.find(f => +f.weight === weight) ?? picker.faces.find(f => f.weight === '400')!).staticFile
      : spacePlex ? ({ city: 'SpaceGrotesk-Bold.ttf', country: 'IBMPlexMono-Light.ttf', coords: 'IBMPlexMono-Regular.ttf' })[role]
      : 'Roboto-' + (role === 'city' ? 'Bold' : role === 'country' ? 'Light' : 'Regular') + '.ttf';
  };
  let laid: PosterTextLayout | undefined;
  if (showText) {
    laid = layoutPosterText({
      ...options,
      baselineEm: v2 ? Object.fromEntries((['city', 'country', 'coords'] as const).map(role => [role, fontOutline(faceFile(role)).baselineEm])) : undefined,
      width: W,
      height: H,
      city: fmtCity(city || ''),
      country: (country || '').toUpperCase(),
      coords: fmtCoords(lat, lon),
      textLayout,
      lockupFont: selectedLockup,
      glyph: (role, text, fontPx) => {
        const font = role === 'city'
          ? '700 ' + fontPx + 'px ' + titleFamily
          : role === 'country'
            ? '300 ' + fontPx + 'px ' + lightFamily
            : '400 ' + fontPx + 'px ' + coordsFamily;
        const measured = measureCanvasGlyph(ctx, font, text, v2);
        if (!v2) return measured;
        const outline = fontOutline(faceFile(role)).ink(text);
        if (outline) return { ...measured, ascent: outline.ascent * fontPx, descent: outline.descent * fontPx };
        const probe = measureCanvasGlyph(ctx, font.replace(fontPx + 'px', '1000px'), text, true);
        return { ...measured, ascent: probe.ascent * fontPx / 1000, descent: probe.descent * fontPx / 1000 };
      },
    });

    beforeDraw?.(laid);
    if (v2) ctx.globalAlpha = 1;
    ctx.fillStyle = textColor;
    ctx.textAlign = laid.align;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 ' + laid.city.size + 'px ' + titleFamily;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    drawSpaced(ctx, laid.city.text, laid.city.x, laid.city.y, laid.city.spacing, laid.city.size, laid.align, v2);

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
    if (laid.divider.width > 0) ctx.stroke();

    ctx.font = '300 ' + laid.country.size + 'px ' + lightFamily;
    drawSpaced(ctx, laid.country.text, laid.country.x, laid.country.y, laid.country.spacing, laid.country.size, laid.align, v2);

    ctx.globalAlpha = 0.7;
    ctx.font = '400 ' + laid.coords.size + 'px ' + coordsFamily;
    drawSpaced(ctx, laid.coords.text, laid.coords.x, laid.coords.y, laid.coords.spacing, laid.coords.size, laid.align, v2);
    ctx.globalAlpha = 1;
  }

  if (!showText) beforeDraw?.();
  paintCredits(ctx, credit, creditFont, credits, { fill: attrColor });
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

/** Apply the selected fade before drawing the measured lockup. */
export function applyFades(ctx: any, W: number, H: number, color: string, fadeStyle: string, lockupLayout?: 'v2', layout?: PosterTextLayout): void {
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

  if (lockupLayout === 'v2') {
    const ellipse = lockupFadeEllipse(layout);
    if (!ellipse) return;
    const { cx, cy, rx, ry } = ellipse;
    const previousFill = ctx.fillStyle;
    ctx.save();
    try {
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      for (const [radius, alpha] of LOCKUP_V2_OVAL.stops) {
        gradient.addColorStop(radius, withAlpha(color, alpha));
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(-rx, -rx, 2 * rx, 2 * rx);
    } finally {
      ctx.restore();
      // node-canvas retains the gradient in its fillStyle getter after restore().
      ctx.fillStyle = previousFill;
    }
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

/** Shared compositor for both render paths. Legacy fade choices stay frozen. */
export function compositePosterOverlay(ctx: any, width: number, height: number, overlay: any,
  lat: number, lon: number, legacyFadeColor: string, legacyFadeStyle: string, printWindow?: ResolvedPrintWindow): void {
  const inset = printWindow?.safeInsetIn && printWindow.visibleWIn > 0
    ? printWindow.safeInsetIn * (printWindow.hasWrap ? width * printWindow.visibleFractionW : width) / printWindow.visibleWIn
    : undefined;
  if (inset) overlay = { ...overlay, creditInsetPx: inset };
  if (printWindow?.hasWrap) {
    const face = innerViewportPx(width, height, printWindow.visibleFractionW, printWindow.visibleFractionH);
    ctx.save();
    try {
      ctx.translate((width - face.w) / 2, (height - face.h) / 2);
      ctx.beginPath();
      ctx.rect(0, 0, face.w, face.h);
      ctx.clip();
      drawOverlay(ctx, face.w, face.h, overlay, lat, lon, legacyFadeColor, legacyFadeStyle);
    } finally {
      ctx.restore();
    }
  } else {
    drawOverlay(ctx, width, height, overlay, lat, lon, legacyFadeColor, legacyFadeStyle);
  }
}

function drawOverlay(ctx: any, width: number, height: number, overlay: any,
  lat: number, lon: number, legacyFadeColor: string, legacyFadeStyle: string): void {
  const v2 = resolveLockupLayout(overlay.lockupLayout) === 'v2';
  const theme = overlay.theme ?? {};
  const color = v2 ? theme.map?.overlayBg ?? theme.ui?.bg ?? '#f5f5f0' : legacyFadeColor;
  drawPosterText(ctx, width, height, theme, lat, lon, overlay.displayCity || '', overlay.displayCountry || '',
    overlay.fontFamily || '', overlay.showPosterText !== false, overlay.includeCredits !== false,
    overlay.textLayout || 'centered', overlay.lockupFont, { ...overlay, lockupLayout: v2 ? 'v2' : undefined },
    layout => applyFades(ctx, width, height, color, overlay.fadeStyle || (v2 ? 'fullbleed' : legacyFadeStyle),
      v2 ? 'v2' : undefined, layout));
}
/** Normalized mean alpha over nonzero glyph pixels, plus area for weight comparisons. */
export function measureInkCoverage(data: ArrayLike<number>) {
  let alpha = 0, pixels = 0;
  for (let i = 3; i < data.length; i += 4) { alpha += data[i] / 255; if (data[i]) pixels++; }
  return { meanAlpha: pixels ? alpha / pixels : 0, glyphPixels: pixels, alphaArea: alpha, coverage: alpha / (data.length / 4) };
}
