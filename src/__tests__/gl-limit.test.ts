import { describe, expect, it } from 'vitest';
import { cameraExceedsGlLimits, GL_MAX_FRAMEBUFFER_EDGE, resolvePrintCamera } from '../print-parity.js';

// 2026-11-23: a snapshot taken in the editor's landscape explore step (bounds
// about 2.4 times wider than tall) on an 18x24 poster produced a 17252x9600
// framebuffer. maplibre-gl-native aborted the process and production went to
// 502 until a restart. These are the real numbers from that snapshot.
const crashing = {
  zoom: 14.728477779211811,
  bounds: { west: -96.88304359866038, south: 32.7364354830944, east: -96.71095640133836, north: 32.816946306012895 },
};
// A preview-step snapshot that rendered correctly on Railway the same day.
const working = {
  zoom: 14.304821051283295,
  bounds: { west: -9.178002365638207, south: 38.682037590155346, east: -9.10059763436223, north: 38.76253973767774 },
};

// 18x24 in at 400 DPI, the sheet /proof computes before downscaling.
const sheet = { outputWidth: 7200, outputHeight: 9600, visibleFractionW: 1, visibleFractionH: 1, maxZoom: 17 };

describe('GL framebuffer guard', () => {
  it('refuses the camera that crashed production', () => {
    const camera = resolvePrintCamera({ ...sheet, ...crashing });
    expect(camera.bufferWidth).toBeGreaterThan(GL_MAX_FRAMEBUFFER_EDGE);
    expect(cameraExceedsGlLimits(camera)).toMatch(/exceeds the GL edge limit/);
  });

  it('accepts a matching preview-step camera unchanged', () => {
    const camera = resolvePrintCamera({ ...sheet, ...working });
    expect(cameraExceedsGlLimits(camera)).toBeNull();
    expect(camera.bufferWidth).toBeLessThanOrEqual(GL_MAX_FRAMEBUFFER_EDGE);
    expect(camera.bufferHeight).toBeLessThanOrEqual(GL_MAX_FRAMEBUFFER_EDGE);
  });

  it('accepts the largest valid single-pass edge (14 400 px)', () => {
    expect(cameraExceedsGlLimits({ bufferWidth: 10_200, bufferHeight: 14_400, cssWidth: 2228, cssHeight: 3145 })).toBeNull();
  });

  it('refuses empty or non-finite framebuffers', () => {
    expect(cameraExceedsGlLimits({ bufferWidth: 0, bufferHeight: 100, cssWidth: 0, cssHeight: 100 })).not.toBeNull();
    expect(cameraExceedsGlLimits({ bufferWidth: Number.NaN, bufferHeight: 100, cssWidth: 1, cssHeight: 1 })).not.toBeNull();
  });
});
