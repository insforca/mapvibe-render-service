import { describe, it, expect, vi } from 'vitest';
import { fontOutline } from '../font-outline.js';
import { applyFades, layoutPosterText, resolveLockupLayout, resolveLineToggle, LOCKUP_V2,
  LOCKUP_V2_OVAL, lockupFadeEllipse } from '../poster-text.js';
import { EDITOR_BOTTOM_FADE_STOPS } from '../print-parity.js';

const input = { width: 900, height: 1200, city: 'SAINT PETERSBURG', country: 'RUSSIA',
  coords: '-33.8688° S / 151.2093° E', lockupFont: 'space-plex' as const,
  glyph: (_role: string, text: string, size: number) => ({ width: text.length * .65 * size, ascent: .72 * size, descent: .02 * size }) };

describe('option A versioned layout', () => {
  it('uses the approved radial stops independently of the legacy fade override', () => {
    const layout = layoutPosterText({ ...input, lockupLayout: 'v2' });
    const radial = [[0,.85],[.5,.85],[.62,.78],[.72,.62],[.8,.44],[.87,.27],[.93,.12],[.97,.04],[1,0]];
    expect(LOCKUP_V2_OVAL.stops).toEqual(radial);
    const render = (version?: 'v2') => {
      const stops: number[][] = [];
      const gradient = { addColorStop: (t: number, color: string) => {
        stops.push([t, Number(color.match(/,([^,]+)\)$/)![1])]);
      } };
      const ctx = { createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), fillRect: vi.fn() };
      applyFades(ctx, 900, 1200, '#ffffff', 'fullbleed', version, layout);
      return stops;
    };
    vi.stubEnv('DISABLE_EASEIN_FADE', 'false');
    expect(render()).toEqual(EDITOR_BOTTOM_FADE_STOPS);
    expect(render('v2')).toEqual(radial);
    vi.stubEnv('DISABLE_EASEIN_FADE', 'true');
    expect(render('v2')).toEqual(radial);
    expect(render()).toEqual([[0, 1], [.3, .7], [.65, .2], [1, 0]]);
    vi.unstubAllEnvs();
  });
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
      if (lockupLayout) expect(!!lockupFadeEllipse(l)).toBe(!!mask);
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
