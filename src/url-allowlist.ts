/**
 * src/url-allowlist.ts
 *
 * SSRF defence: any URL the renderer reads from (tiles, glyphs, sprites,
 * inbound style-JSON) is checked against a host allowlist + a private-IP
 * regex. Recursive `extractUrls` walks the entire styleJson object so
 * nested string fields don't slip past.
 *
 * Extracted from server.ts for testability (server.ts pulls in
 * native modules — MapLibre / canvas / sharp — that can't load in a
 * vanilla test environment).
 */

export const ALLOWED_TILE_HOSTS = [
  'tiles.openfreemap.org','tile.openstreetmap.org',
  'a.tile.openstreetmap.org','b.tile.openstreetmap.org','c.tile.openstreetmap.org',
  'basemaps.cartocdn.com','api.maptiler.com','maps.geoapify.com',
  'mapvibe-studio-alpha.vercel.app',
  'mapvibestudio.com',
] as const;

export const PRIVATE_IP_RE =
  /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc00:|fd[0-9a-f]{2}:)/i;

export function isAllowedUrl(url: string): boolean {
  try {
    const { protocol, hostname, host } = new URL(url);
    if (protocol !== 'https:') return false;
    if (PRIVATE_IP_RE.test(host)) return false;
    return ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

export function extractUrls(obj: unknown, urls: string[] = []): string[] {
  if (typeof obj === 'string') { urls.push(obj); return urls; }
  if (Array.isArray(obj)) { obj.forEach(v => extractUrls(v, urls)); return urls; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) extractUrls(v, urls);
  }
  return urls;
}

/**
 * Walk an inbound styleJson and reject any HTTP(S) URL that doesn't sit on
 * the allowlist. Returns null on success, or a human-readable rejection
 * reason on failure.
 */
export function validateStyleJsonUrls(styleJson: object): string | null {
  const urls = extractUrls(styleJson).filter(u => u.startsWith('http'));
  for (const url of urls) {
    try {
      const { hostname } = new URL(url);
      if (!ALLOWED_TILE_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) {
        return `Tile host not in allowlist: ${hostname}`;
      }
    } catch {
      return `Invalid URL in styleJson: ${url}`;
    }
  }
  return null;
}
