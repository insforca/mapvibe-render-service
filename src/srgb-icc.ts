import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Official ICC sRGB profile (sRGB2014, ICC v2, display class).
 * See the LICENSE file beside the profile for source, copyright, and why
 * this is not the sRGB v4 preference profile.
 */
export const SRGB_ICC_FILENAME = 'sRGB2014.icc';

const ICC_HEADER_BYTES = 128;
const ICC_MAGIC = Buffer.from('acsp');

/**
 * Absolute path to the profile shipped in assets/color.
 * Resolved from this module so `dist/server.js` and the Vitest sources agree.
 */
export function packagedSrgbIccPath(): string {
  return join(__dirname, '..', 'assets', 'color', SRGB_ICC_FILENAME);
}

/**
 * ICC files store the ASCII signature `acsp` at byte offset 36, and the
 * big-endian profile size at offset 0. HTML (including the color.org landing
 * page that replaced the old profile URL) fails both checks.
 */
export function isIccProfile(buf: Buffer): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < ICC_HEADER_BYTES) return false;
  if (!buf.subarray(36, 40).equals(ICC_MAGIC)) return false;
  return buf.readUInt32BE(0) === buf.length;
}

let loaded: { path: string; bytes: number } | null = null;

/** Read the vendored profile. Does not use the network. */
export function loadPackagedSrgbIcc(): { path: string; bytes: number } {
  if (loaded) return loaded;
  const path = packagedSrgbIccPath();
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`packaged sRGB ICC profile is not readable at ${path}: ${message}`);
  }
  if (!isIccProfile(buf)) {
    throw new Error(
      `packaged sRGB ICC profile at ${path} is not an ICC file (${buf.length} bytes)`,
    );
  }
  loaded = { path, bytes: buf.length };
  return loaded;
}
