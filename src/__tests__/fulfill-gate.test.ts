import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluateFulfillGate, _resetCatalogueCacheForTests } from '../fulfill-gate.js';

const GELATO_1824 = 'fine_arts_poster_geo_simplified_product_12-0_ver_450x600-mm-18x24-inch_200-gsm-80lb-enhanced-uncoated';
const GELATO_2840 = 'fine_arts_poster_geo_simplified_product_12-0_ver_700x1000-mm-28x40-inch_200-gsm-80lb-enhanced-uncoated';

beforeEach(() => {
  _resetCatalogueCacheForTests();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function gate(partial: Parameters<typeof evaluateFulfillGate>[0]) {
  return evaluateFulfillGate({
    hasPngUrl: false,
    hasConfigUrl: true,
    configDownloaded: true,
    ...partial,
  });
}

describe('fulfill gate — catalogue routing', () => {
  it('routes a poster SKU to the Gelato giclée UID, not a caller-supplied Printful id', () => {
    const result = gate({
      sku: 'MVS-P-1824',
      externalId: 'shopify-1-ignored',
      hasPngUrl: true,
      hasConfigUrl: false,
      callerProvider: 'printful',
      callerVariantId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vendor).toBe('gelato');
    expect(result.gelatoProductUid).toBe(GELATO_1824);
    expect(result.printfulVariantId).toBeNull();
    expect(result.callerProviderIgnored).toBe(true);
    expect(result.callerVariantIgnored).toBe(true);
    expect(result.needsRender).toBe(false);
    expect(result.dims).toMatchObject({ width: 7200, height: 9600, mode: 'single-pass' });
    expect(result.httpStatus).toBeUndefined();
  });

  it('reads the SKU out of externalId when the body omits sku', () => {
    const result = gate({
      externalId: 'shopify-7724620874069-MVS-P-2436',
      hasPngUrl: true,
      hasConfigUrl: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sku).toBe('MVS-P-2436');
    expect(result.vendor).toBe('gelato');
    expect(result.dims).toMatchObject({ width: 9600, height: 14400, mode: 'single-pass' });
  });

  it('maps 28x40 to the 70x100 cm single-pass frame', () => {
    const result = gate({ sku: 'MVS-P-2840', hasPngUrl: true, hasConfigUrl: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gelatoProductUid).toBe(GELATO_2840);
    expect(result.widthCm).toBe(70);
    expect(result.heightCm).toBe(100);
    expect(result.hasWrap).toBe(false);
    expect(result.dims.mode).toBe('single-pass');
    expect(result.dims.numTiles).toBe(1);
    expect(result.dims.width).toBe(10059);
    expect(result.dims.height).toBe(14370);
    expect(result.dims.actualDpi).toBeGreaterThanOrEqual(360);
    expect(result.dims.actualDpi).toBeLessThanOrEqual(370);
  });

  it('routes black frames to Printful variant ids from the table', () => {
    const small = gate({ sku: 'MVS-F-1824-BK', hasPngUrl: true, hasConfigUrl: false });
    const large = gate({ sku: 'MVS-F-2436-BK', hasPngUrl: true, hasConfigUrl: false });
    expect(small.ok && large.ok).toBe(true);
    if (!small.ok || !large.ok) return;
    expect(small.vendor).toBe('printful');
    expect(small.printfulVariantId).toBe(3);
    expect(large.printfulVariantId).toBe(4);
    expect(small.gelatoProductUid).toBeNull();
    expect(small.hasWrap).toBe(false);
  });

  it('renders white canvas at the print-area aspect and will not accept a pre-made PNG', () => {
    const missingConfig = gate({
      sku: 'MVS-C-1824-W',
      hasPngUrl: true,
      hasConfigUrl: false,
      callerVariantId: 10996,
    });
    expect(missingConfig.ok).toBe(false);
    if (missingConfig.ok) return;
    expect(missingConfig.httpStatus).toBeGreaterThanOrEqual(400);
    expect(missingConfig.httpStatus).toBeLessThan(500);
    expect(missingConfig.reason).toBe('sku-unrenderable');

    const small = gate({ sku: 'MVS-C-1824-W', hasPngUrl: true, hasConfigUrl: true, callerVariantId: 10996 });
    const large = gate({ sku: 'MVS-C-2436-W' });
    expect(small.ok && large.ok).toBe(true);
    if (!small.ok || !large.ok) return;
    expect(small.vendor).toBe('printful');
    expect(small.printfulVariantId).toBe(15699);
    expect(small.callerVariantIgnored).toBe(true);
    expect(small.needsRender).toBe(true);
    expect(small.printWIn).toBe(21);
    expect(small.printHIn).toBe(27);
    expect(small.visibleFractionW).toBeCloseTo(18 / 21, 6);
    expect(small.visibleFractionH).toBeCloseTo(24 / 27, 6);
    expect(small.dims).toMatchObject({ width: 8400, height: 10800, mode: 'single-pass', actualDpi: 400 });
    expect(small.dims.width / small.dims.height).toBeCloseTo(21 / 27, 5);
    expect(small.dims.width / small.dims.height).not.toBeCloseTo(18 / 24, 3);

    expect(large.printfulVariantId).toBe(15700);
    expect(large.printWIn).toBe(27);
    expect(large.printHIn).toBe(39);
    expect(large.dims).toMatchObject({ width: 9963, height: 14391, mode: 'single-pass' });
    expect(large.dims.width / large.dims.height).toBeCloseTo(27 / 39, 5);
    expect(large.needsRender).toBe(true);
  });
});

describe('fulfill gate — loud failure', () => {
  it.each([
    'MVS-100x150-SOLO',
    'MVS-50x70-SOLO',
    'MVS_CITY_18x24_SOLO',
    'MVS-NYC-18x24-BLACK',
    'MVS-NYC-18x24-CANVAS-W',
    'MVS-16x20-SOLO',
    '',
  ])('rejects unmapped SKU %j with a non-2xx status', (sku) => {
    const result = gate({ sku, externalId: 'shopify-9-no-catalogue-sku', hasPngUrl: true, hasConfigUrl: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBeGreaterThanOrEqual(400);
    expect(result.reason).toBe('sku-unmapped');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('rejects a disabled optional SKU instead of fulfilling it', () => {
    for (const sku of ['MVS-P-1620', 'MVS-F-1824-NT', 'MVS-F-2436-NT', 'MVS-C-3040', 'MVS-C-1824']) {
      const result = gate({ sku, hasPngUrl: true, hasConfigUrl: false });
      expect(result.ok, sku).toBe(false);
      if (result.ok) continue;
      expect(result.httpStatus).toBeGreaterThanOrEqual(400);
      expect(result.reason).toBe('sku-disabled');
    }
  });

  it('enables optional rows only when CATALOGUE_ENABLE_OPTIONAL=true', () => {
    vi.stubEnv('CATALOGUE_ENABLE_OPTIONAL', 'true');
    const oak = gate({ sku: 'MVS-F-1824-NT', hasPngUrl: true, hasConfigUrl: false });
    const gallery = gate({ sku: 'MVS-C-3040' });
    const small = gate({ sku: 'MVS-P-1620', hasPngUrl: true, hasConfigUrl: false });
    expect(oak.ok && gallery.ok && small.ok).toBe(true);
    if (!oak.ok || !gallery.ok || !small.ok) return;
    expect(oak.printfulVariantId).toBe(15031);
    expect(gallery.printfulVariantId).toBe(19323);
    expect(gallery.hasWrap).toBe(true);
    expect(gallery.dims.mode).toBe('single-pass');
    expect(gallery.dims.actualDpi).toBeGreaterThanOrEqual(300);
    expect(small.dims).toMatchObject({ width: 6400, height: 8000, mode: 'single-pass' });
  });

  it('returns 502 when a required config snapshot cannot be downloaded', () => {
    const result = gate({ sku: 'MVS-C-1824-W', configDownloaded: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(502);
    expect(result.reason).toBe('config-render');
  });

  it('does not call fetch (no vendor order endpoint)', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used by the gate');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const result = gate({ sku: 'MVS-C-2436-W' });
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
