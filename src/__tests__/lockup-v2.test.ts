import { describe, it, expect, vi } from 'vitest';
import { fontOutline } from '../font-outline.js';
import { layoutPosterText, resolveLockupLayout, resolveLineToggle, LOCKUP_V2 } from '../poster-text.js';

const input = { width: 900, height: 1200, city: 'SAINT PETERSBURG', country: 'RUSSIA',
  coords: '-33.8688° S / 151.2093° E', lockupFont: 'space-plex' as const,
  glyph: (_role: string, text: string, size: number) => ({ width: text.length * .65 * size, ascent: .72 * size, descent: .02 * size }) };

describe('option A versioned layout', () => {
  it('warns on unknown versions and invalid toggles, ignores invalid values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveLockupLayout()).toBeUndefined();
    expect(resolveLockupLayout('v2')).toBe('v2');
    expect(warn).not.toHaveBeenCalled();
    for (const value of [null, 'v3', 2, false]) expect(resolveLockupLayout(value)).toBeUndefined();
    for (const value of ['false', 0, null, {}]) expect(resolveLineToggle(value, 'showCity')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(8);
    expect(layoutPosterText({ ...input, lockupLayout: 'bad' as any, showCity: 'false' as any }))
      .toEqual(layoutPosterText(input));
    warn.mockRestore();
  });
  for (const [width, height] of [[5400, 7200], [9933, 14043], [100, 134]]) {
    it(`fits one line and a <=15% block at ${width}x${height}`, () => {
      const l = layoutPosterText({ ...input, width, height, lockupLayout: 'v2' });
      expect((height - l.stripTop) / height).toBeLessThanOrEqual(.15);
      for (const line of [l.city, l.country, l.coords]) {
        expect(line.width + line.spacing * line.size).toBeLessThanOrEqual(width * .84 + 1e-8);
      }
      expect(l.textFadeTop).toBeCloseTo(l.city.y - 1.6 * l.city.ascent);
      expect(l.textFadeTop).toBeLessThan(l.city.y - l.city.ascent);
      expect(l.city.size).toBeCloseTo(width * LOCKUP_V2.city);
    });
  }
  for (const lockupLayout of [undefined, 'v2'] as const) for (let mask = 0; mask < 8; mask++) {
    it(`collapses hidden lines for ${lockupLayout ?? 'legacy'} mask ${mask}`, () => {
      const showCity = !!(mask & 4), showCountry = !!(mask & 2), showCoords = !!(mask & 1);
      const l = layoutPosterText({ ...input, lockupLayout, showCity, showCountry, showCoords });
      expect(l.city.boxHeight > 0).toBe(showCity);
      expect(l.country.boxHeight > 0).toBe(showCountry);
      expect(l.coords.boxHeight > 0).toBe(showCoords);
      expect(l.divider.width > 0).toBe(showCity && (showCountry || showCoords));
      if (!mask) expect(l.stripTop).toBe(input.height);
      if (lockupLayout && mask) {
        const first = showCity ? l.city : showCountry ? l.country : l.coords;
        expect(l.textFadeTop).toBeCloseTo(first.y - 1.6 * first.ascent);
      }
      // Empty source lines have exactly the same flow as hidden lines.
      const empty = layoutPosterText({ ...input, lockupLayout,
        city: showCity ? input.city : '', country: showCountry ? input.country : '', coords: showCoords ? input.coords : '',
        showCity: true, showCountry: true, showCoords: true });
      expect(l.stripTop).toBe(empty.stripTop);
    });
  }
  it('reads exact Space Grotesk and Plex outline ink, independent of canvas hinting', () => {
    expect(fontOutline('SpaceGrotesk-Bold.ttf').baselineEm).toBeCloseTo(.921);
    expect(fontOutline('IBMPlexMono-Light.ttf').baselineEm).toBeCloseTo(.950);
    expect(fontOutline('SpaceGrotesk-Bold.ttf').ink('H')?.ascent).toBe(.7);
    expect(fontOutline('SpaceGrotesk-Bold.ttf').ink('   ')).toEqual({ ascent: 0, descent: 0 });
  });
});
