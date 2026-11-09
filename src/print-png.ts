import sharp from 'sharp';
import { loadPackagedSrgbIcc } from './srgb-icc.js';

/**
 * Encode a print PNG from straight RGBA pixels.
 *
 * Flattens alpha onto white, writes the caller-supplied DPI into pHYs, and
 * embeds the vendored sRGB2014 profile. Output is 8-bit RGB and lossless PNG.
 *
 * `withMetadata({ density })` installs Sharp's built-in sRGB profile and
 * replaces a profile passed to an earlier `withIccProfile`. Call
 * `withIccProfile` after `withMetadata` so the vendored file is the one
 * that lands in the iCCP chunk. `toColorspace('srgb')` does not remove it.
 */
export async function encodePrintPng(
  rawRgba: Buffer | Uint8Array,
  width: number,
  height: number,
  density: number,
): Promise<Buffer> {
  const icc = loadPackagedSrgbIcc().path;
  return sharp(Buffer.from(rawRgba), { raw: { width, height, channels: 4 } })
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .withMetadata({ density })
    .withIccProfile(icc)
    .png({ compressionLevel: 9 })
    .toBuffer();
}
