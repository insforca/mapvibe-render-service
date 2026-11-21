import { describe, expect, it } from 'vitest';
import {
  fmtCoords,
  layoutPosterText,
  type GlyphBox,
  type PosterTextLayout,
} from '../poster-text.js';

/**
 * Advances and vertical extents measured from the bundled Roboto faces at
 * 100px, textBaseline 'middle' (node-canvas). [width, ascent, descent].
 * Layout y is the alphabetic baseline, which sits 38.5px below that middle
 * for these faces, so box() converts. Bold is the city (700). Light is the
 * country (300). Regular is the coordinates (400). Bold J descends to 21
 * below the alphabetic baseline and Bold Q to 17.
 */
const MIDDLE_TO_ALPHABETIC = 38.5;
const BOLD: Record<string, [number, number, number]> = {
  A: [69, 33.5, 38.5], B: [67.2, 33.5, 38.5], C: [63.7, 34.5, 39.5], D: [74, 33.5, 38.5],
  E: [56, 33.5, 38.5], F: [54.9, 33.5, 39.5], G: [72.4, 34.5, 39.5], H: [76.5, 33.5, 38.5],
  I: [38.9, 33.5, 38.5], J: [33.1, 33.5, 59.5], K: [66.4, 33.5, 38.5], L: [56.5, 33.5, 38.5],
  M: [94.3, 33.5, 38.5], N: [81.3, 33.5, 38.5], O: [79.6, 34.5, 39.5], P: [62.8, 34.5, 38.5],
  Q: [79.6, 34.5, 55.5], R: [66, 34.5, 38.5], S: [55.1, 34.5, 39.5], T: [57.9, 33.5, 38.5],
  U: [75.6, 33.5, 39.5], V: [65, 33.5, 38.5], W: [96.7, 33.5, 38.5], X: [66.7, 33.5, 38.5],
  Y: [62.4, 33.5, 38.5], Z: [57.9, 33.5, 38.5], ' ': [26, -38.5, 38.5],
};
const LIGHT: Record<string, [number, number, number]> = {
  A: [62.5, 33.5, 38.5], B: [61.3, 33.5, 38.5], C: [64.9, 34.5, 39.5], D: [65.5, 33.5, 38.5],
  E: [56.9, 33.5, 38.5], F: [56.3, 32.5, 39.5], G: [68.4, 34.5, 39.5], H: [70.8, 32.5, 38.5],
  I: [26.6, 33.5, 38.5], J: [55, 33.5, 39.5], K: [63.1, 33.5, 38.5], L: [52.7, 33.5, 38.5],
  M: [86.5, 33.5, 38.5], N: [71, 33.5, 38.5], O: [67.7, 34.5, 39.5], P: [61.6, 33.5, 38.5],
  Q: [67.7, 34.5, 51.5], R: [63.5, 33.5, 38.5], S: [59.2, 34.5, 39.5], T: [59.7, 33.5, 38.5],
  U: [65.7, 33.5, 39.5], V: [61.7, 33.5, 38.5], W: [89.6, 33.5, 38.5], X: [61.2, 33.5, 38.5],
  Y: [59.9, 33.5, 38.5], Z: [59.8, 33.5, 38.5], ' ': [24.3, -38.5, 38.5],
};
const REGULAR: Record<string, [number, number, number]> = {
  '0': [57.2, 34.5, 39.5], '1': [57.2, 33.5, 38.5], '2': [57.2, 34.5, 38.5], '3': [57.2, 34.5, 39.5],
  '4': [57.2, 33.5, 39.5], '5': [57.2, 33.5, 39.5], '6': [57.2, 34.5, 39.5], '7': [57.2, 34.5, 38.5],
  '8': [57.2, 34.5, 39.5], '9': [57.2, 34.5, 39.5], '.': [26.8, -25.5, 39.5], '\u00b0': [42.8, 34.5, -3.5],
  N: [76, 33.5, 38.5], S: [54.9, 34.5, 39.5], E: [55.6, 33.5, 38.5], W: [93, 33.5, 38.5],
  '/': [37.2, 33.5, 38.5], '-': [32.2, -7.5, 15.5], ' ': [26, -38.5, 38.5],
};

function box(text: string, table: Record<string, [number, number, number]>, fontPx: number): GlyphBox {
  const scale = fontPx / 100;
  let width = 0;
  let ascent = 0;
  let descent = 0;
  for (const ch of text) {
    const m = table[ch] ?? table['A'] ?? table['0'];
    width += m[0] * scale;
    if (m[1] > 0) {
      ascent = Math.max(ascent, (m[1] + MIDDLE_TO_ALPHABETIC) * scale);
      descent = Math.max(descent, (m[2] - MIDDLE_TO_ALPHABETIC) * scale);
    }
  }
  return { width, ascent, descent };
}

function layout(width: number, height: number, city: string, country: string, textLayout = 'centered'): PosterTextLayout {
  return layoutPosterText({
    width,
    height,
    city,
    country,
    coords: fmtCoords(38.7223, -9.1393),
    textLayout,
    glyph: (role, text, fontPx) => box(
      text,
      role === 'city' ? BOLD : role === 'country' ? LIGHT : REGULAR,
      fontPx,
    ),
  });
}

/** Distance from the bottom of one ink box to the top of the next. Negative means overlap. */
function gap(bottom: number, top: number): number {
  return top - bottom;
}

function ink(line: { y: number; ascent: number; descent: number }) {
  return { top: line.y - line.ascent, bottom: line.y + line.descent };
}

const SHEETS: Array<[string, number, number]> = [
  ['preview 900x1200', 900, 1200],
  ['18x24 @400dpi', 7200, 9600],
  ['24x36 @400dpi', 9600, 14400],
  ['28x40 @365dpi', 10059, 14370],
  ['A0 @307dpi', 10165, 14371],
];

/** Credit ink above a bottom baseline, measured on Roboto Light (ascent/size). */
const CREDIT_ASCENT_EM = 1.04;

function assertStackClears(laid: PosterTextLayout, label: string) {
  const city = ink(laid.city);
  const country = ink(laid.country);
  const coords = ink(laid.coords);
  const ruleTop = laid.divider.y - laid.divider.halfStroke;
  const ruleBottom = laid.divider.y + laid.divider.halfStroke;
  const creditTop = laid.credit.y - CREDIT_ASCENT_EM * laid.credit.size;
  const cityRule = gap(city.bottom, ruleTop);
  const ruleCountry = gap(ruleBottom, country.top);
  const countryCoords = gap(country.bottom, coords.top);
  const coordsCredit = gap(coords.bottom, creditTop);
  expect(cityRule, `${label} city/rule ${cityRule.toFixed(2)}`).toBeGreaterThan(0);
  expect(ruleCountry, `${label} rule/country ${ruleCountry.toFixed(2)}`).toBeGreaterThan(0);
  expect(countryCoords, `${label} country/coords ${countryCoords.toFixed(2)}`).toBeGreaterThan(0);
  expect(coordsCredit, `${label} coords/credit ${coordsCredit.toFixed(2)}`).toBeGreaterThan(0);
}

/** Cap ink of the bundled Roboto, alphabetic baseline, as a fraction of em. */
const CAP_ASCENT = 0.73;
const CAP_DESCENT = 0.01;

function editorLayout(width: number, height: number, textLayout = 'centered') {
  return layoutPosterText({
    width,
    height,
    city: 'LISBON',
    country: 'PORTUGAL',
    coords: '38.7078\u00b0 N / 9.1366\u00b0 W',
    textLayout,
    glyph: (_role, text, fontPx) => ({
      width: text.length * 0.62 * fontPx,
      ascent: text ? CAP_ASCENT * fontPx : 0,
      descent: text ? CAP_DESCENT * fontPx : 0,
    }),
  });
}

describe('editor poster strip', () => {
  it('matches the compact Lisbon line boxes, ink, rule, and city tracking', () => {
    // 18×24, the aspect the editor DOM was measured on. Fractions are of height
    // except the rule width and the city shift, which are of width.
    const laid = editorLayout(5400, 7200);
    const h = 7200;
    const w = 5400;
    const near = (actual: number, expected: number, tol: number, label: string) => {
      expect(Math.abs(actual - expected), `${label}: ${actual.toFixed(4)} vs ${expected}`).toBeLessThanOrEqual(tol);
    };
    const ruleTop = laid.divider.y - laid.divider.halfStroke;
    const cityInkBottom = laid.city.y + laid.city.descent;
    const fractions = {
      strip: laid.stripTop / h,
      cityBoxTop: laid.city.boxTop / h,
      cityBoxBottom: (laid.city.boxTop + laid.city.boxHeight) / h,
      cityInkTop: (laid.city.y - laid.city.ascent) / h,
      cityInkBottom: cityInkBottom / h,
      rule: ruleTop / h,
      gap: (ruleTop - cityInkBottom) / h,
      countryInkTop: (laid.country.y - laid.country.ascent) / h,
      countryInkBottom: (laid.country.y + laid.country.descent) / h,
      coordsInkTop: (laid.coords.y - laid.coords.ascent) / h,
      coordsInkBottom: (laid.coords.y + laid.coords.descent) / h,
    };
    near(fractions.strip, 0.8988, 0.002, 'strip top');
    near(fractions.cityBoxTop, 0.9078, 0.002, 'city box top');
    near(fractions.cityBoxBottom, 0.9515, 0.002, 'city box bottom');
    near(fractions.cityInkTop, 0.9139, 0.002, 'city ink top');
    near(fractions.cityInkBottom, 0.9439, 0.002, 'city ink bottom');
    near(fractions.rule, 0.9545, 0.002, 'rule');
    near(fractions.gap, 0.0106, 0.002, 'city-to-rule gap');
    near(fractions.countryInkTop, 0.9613, 0.002, 'country ink top');
    near(fractions.countryInkBottom, 0.9718, 0.002, 'country ink bottom');
    near(fractions.coordsInkTop, 0.9789, 0.002, 'coords ink top');
    near(fractions.coordsInkBottom, 0.9856, 0.002, 'coords ink bottom');
    near(laid.divider.width / w, 0.12 * (1 - 2 * 0.055), 0.0001, 'rule width');
    // Trailing 0.18em letter-spacing pulls the centred city left by 0.09em.
    near((w / 2 - laid.city.x) / w, (0.09 * laid.city.size) / w, 0.001, 'city tracking shift');
    expect(laid.city.x).toBeCloseTo(w / 2 - 0.09 * laid.city.size, 4);
  });

  it('keeps the same fractions on the measured editor poster and clears the credit', () => {
    const laid = editorLayout(482.390625, 643.1875);
    expect(laid.stripTop / 643.1875).toBeCloseTo(0.8988, 3);
    expect(laid.city.boxTop / 643.1875).toBeCloseTo(0.9078, 3);
    const creditTop = laid.credit.y - 1.04 * laid.credit.size;
    expect(creditTop).toBeGreaterThan(laid.coords.y + laid.coords.descent);
    expect(laid.credit.y).toBeLessThanOrEqual(643.1875);
  });

  it('uses the same line boxes for editorial and does not shift a left-aligned city', () => {
    const centered = editorLayout(7200, 9600);
    const editorial = editorLayout(7200, 9600, 'editorial');
    expect(editorial.city.boxTop).toBeCloseTo(centered.city.boxTop, 4);
    expect(editorial.divider.y).toBeCloseTo(centered.divider.y, 4);
    expect(editorial.coords.y).toBeCloseTo(centered.coords.y, 4);
    expect(editorial.city.x).toBeCloseTo(7200 * 0.06, 4);
    expect(editorial.divider.width).toBeCloseTo(centered.divider.width, 4);
    const creditTop = editorial.credit.y - 1.04 * editorial.credit.size;
    expect(creditTop).toBeGreaterThan(editorial.coords.y + editorial.coords.descent);
  });
});

describe('poster text vertical rhythm', () => {
  it('scales type with the poster instead of holding a 0.45 floor', () => {
    const preview = layout(900, 1200, 'LISBON', 'PORTUGAL');
    expect(preview.ds).toBeCloseTo(900 / 3600, 6);
    expect(preview.city.size).toBeCloseTo(0.054 * 900, 4);
    expect(preview.city.spacing).toBe(0.18);
    expect(preview.country.spacing).toBe(0.16);
    expect(preview.coords.spacing).toBe(0.08);
    expect(preview.country.size).toBeCloseTo(0.019 * 900, 4);
    expect(preview.coords.size).toBeCloseTo(0.012 * 900, 4);
    const print = layout(7200, 9600, 'LISBON', 'PORTUGAL');
    expect(print.ds).toBeCloseTo(2, 6);
    expect(print.city.size).toBeCloseTo(0.054 * 7200, 4);
  });

  it('stacks the strip under the measured city, rule at 12% of the content box', () => {
    for (const [name, w, h] of SHEETS) {
      const laid = layout(w, h, 'LISBON', 'PORTUGAL');
      expect(laid.divider.width, name).toBeCloseTo(0.12 * (w - 2 * 0.055 * w), 4);
      const cityBottom = laid.city.y + laid.city.descent;
      const ruleTop = laid.divider.y - laid.divider.halfStroke;
      const ruleBottom = laid.divider.y + laid.divider.halfStroke;
      const countryTop = laid.country.y - laid.country.ascent;
      const countryBottom = laid.country.y + laid.country.descent;
      const coordsTop = laid.coords.y - laid.coords.ascent;
      expect(ruleTop, name).toBeGreaterThan(cityBottom);
      expect(countryTop, name).toBeGreaterThan(ruleBottom);
      expect(coordsTop, name).toBeGreaterThan(countryBottom);
      // Not the old absolute fractions. The block sits in the bottom strip.
      expect(laid.country.y, name).not.toBeCloseTo(h * 0.915, 0);
      expect(laid.coords.y + laid.coords.descent, name).toBeGreaterThan(h * 0.9);
    }
  });

  it('does not overlap title, rule, country, coordinates, or credit', () => {
    for (const [name, w, h] of SHEETS) {
      assertStackClears(layout(w, h, 'LISBON', 'PORTUGAL'), name);
      assertStackClears(layout(w, h, 'LISBON', 'PORTUGAL', 'editorial'), name + ' editorial');
    }
  });

  it('clears the rule when the city has a Roboto descender (J, Q)', () => {
    for (const [name, w, h] of SHEETS) {
      for (const city of ['JOHANNESBURG', 'QATAR']) {
        const laid = layout(w, h, city, 'PORTUGAL');
        assertStackClears(laid, `${name} ${city}`);
        const ruleTop = laid.divider.y - laid.divider.halfStroke;
        const air = ruleTop - (laid.city.y + laid.city.descent);
        expect(air, `${name} ${city}`).toBeGreaterThan(laid.city.size * 0.05);
      }
    }
  });

  it('fits a long country on the sheet without moving the country line', () => {
    const country = 'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND';
    for (const [name, w, h] of SHEETS) {
      const laid = layout(w, h, 'LISBON', country);
      const maxW = w * (1 - 2 * 0.02);
      expect(laid.country.width, name).toBeLessThanOrEqual(maxW + 0.5);
      const ruleBottom = laid.divider.y + laid.divider.halfStroke;
      expect(laid.country.y - laid.country.ascent, name).toBeGreaterThan(ruleBottom);
      assertStackClears(laid, name + ' long country');
    }
    const overflowing = layout(7200, 9600, 'LISBON', `${country} ${country} ${country}`);
    expect(overflowing.country.size).toBeLessThan(92 * overflowing.ds);
    expect(overflowing.country.width).toBeLessThanOrEqual(7200 * 0.96 + 0.5);
    assertStackClears(overflowing, '18x24 repeated country');
  });

  it('fits a long city without letting it cross the rule', () => {
    const city = 'LLANFAIRPWLLGWYNGYLLGOGERYCHWYRNDROBWLLLLANTYSILIOGOGOGOCH';
    for (const [name, w, h] of SHEETS) {
      const laid = layout(w, h, city, 'PORTUGAL');
      expect(laid.city.width, name).toBeLessThanOrEqual(w * 0.96 + 0.5);
      assertStackClears(laid, name + ' long city');
    }
  });
});
