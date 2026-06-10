import { describe, it, expect } from 'vitest';
import {
  isAllowedUrl,
  validateStyleJsonUrls,
  extractUrls,
} from '../url-allowlist.js';

describe('isAllowedUrl — SSRF defence', () => {
  it('accepts known tile providers over https', () => {
    expect(isAllowedUrl('https://tiles.openfreemap.org/planet')).toBe(true);
    expect(isAllowedUrl('https://api.maptiler.com/tiles/v3')).toBe(true);
    expect(isAllowedUrl('https://a.tile.openstreetmap.org/12/2048/1361.png')).toBe(true);
  });

  it('rejects plain http (no TLS)', () => {
    expect(isAllowedUrl('http://tiles.openfreemap.org/planet')).toBe(false);
  });

  it('rejects off-allowlist hosts', () => {
    expect(isAllowedUrl('https://evil.example.com/tiles/12/2048/1361.png')).toBe(false);
    expect(isAllowedUrl('https://tiles.openfreemap.org.evil.com/x')).toBe(false);
  });

  it('rejects private + loopback + link-local IPs (SSRF)', () => {
    expect(isAllowedUrl('https://127.0.0.1/tiles')).toBe(false);
    expect(isAllowedUrl('https://10.0.0.1/tiles')).toBe(false);
    expect(isAllowedUrl('https://192.168.1.1/tiles')).toBe(false);
    expect(isAllowedUrl('https://169.254.169.254/latest/meta-data/')).toBe(false); // EC2 IMDS
    expect(isAllowedUrl('https://172.16.0.1/tiles')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedUrl('not-a-url')).toBe(false);
    expect(isAllowedUrl('')).toBe(false);
  });
});

describe('extractUrls — recursive walker', () => {
  it('collects strings from nested objects + arrays', () => {
    const style = {
      glyphs:  'https://mapvibestudio.com/glyphs/{fontstack}/{range}.pbf',
      sources: { openmaptiles: { url: 'https://tiles.openfreemap.org/planet' } },
      layers:  [
        { id: 'a', tags: ['x', 'https://api.maptiler.com/x'] },
      ],
    };
    const urls = extractUrls(style);
    expect(urls).toContain('https://mapvibestudio.com/glyphs/{fontstack}/{range}.pbf');
    expect(urls).toContain('https://tiles.openfreemap.org/planet');
    expect(urls).toContain('https://api.maptiler.com/x');
  });
});

describe('validateStyleJsonUrls — full styleJson validation', () => {
  it('returns null when every URL is on the allowlist', () => {
    const style = {
      sources: { openmaptiles: { url: 'https://tiles.openfreemap.org/planet' } },
      glyphs:  'https://mapvibestudio.com/glyphs/{fontstack}/{range}.pbf',
    };
    expect(validateStyleJsonUrls(style)).toBeNull();
  });

  it('rejects off-allowlist URLs even if nested', () => {
    const style = {
      sources: { openmaptiles: { url: 'https://attacker.example.com/tiles.json' } },
    };
    const reason = validateStyleJsonUrls(style);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/attacker\.example\.com/);
  });

  it('rejects styleJson with a private-IP URL', () => {
    const style = {
      sources: { mal: { url: 'https://169.254.169.254/secrets' } },
    };
    expect(validateStyleJsonUrls(style)).not.toBeNull();
  });
});
