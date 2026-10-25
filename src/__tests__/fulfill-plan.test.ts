import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { planFulfillment, requestIsDryRun, isVendorOrderUrl, planDispatchesVendor } from '../fulfill-plan.js';
import { _resetCatalogueCacheForTests } from '../fulfill-gate.js';
import { _clearRoutingCacheForTests } from '../routing.js';

const GELATO_1824 = 'fine_arts_poster_geo_simplified_product_12-0_ver_450x600-mm-18x24-inch_200-gsm-80lb-enhanced-uncoated';

beforeEach(() => {
  _resetCatalogueCacheForTests();
  _clearRoutingCacheForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function calls(): string[] {
  const fetchMock = globalThis.fetch as unknown as { mock?: { calls: unknown[][] } };
  return (fetchMock.mock?.calls ?? []).map(call => String(call[0]));
}

function shopifyOk(uid = 'gelato-uid-from-shopify') {
  vi.stubEnv('SHOPIFY_ADMIN_TOKEN', 'test-token');
  vi.stubEnv('SHOPIFY_SHOP', 'test.myshopify.com');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (isVendorOrderUrl(String(url))) {
      throw new Error(`vendor order endpoint called: ${url}`);
    }
    return new Response(JSON.stringify({
      metafields: [
        { namespace: 'custom', key: 'pod_partner', value: 'gelato' },
        { namespace: 'custom', key: 'gelato_uid', value: uid },
      ],
    }), { status: 200 });
  }));
}

const legacyBody = {
  label: '18×24 Poster',
  variantId: 42,
  catalogVariantId: 42,
  shopifyVariantId: 555,
  quantity: 1,
  hasPngUrl: true,
  hasConfigUrl: false,
  widthCm: 45.72,
  heightCm: 60.96,
};

describe('request dry run', () => {
  it('honours boolean dryRun and an mv-canary tag, not a stringly true', () => {
    expect(requestIsDryRun({ dryRun: true })).toBe(true);
    expect(requestIsDryRun({ tags: 'mv-canary' })).toBe(true);
    expect(requestIsDryRun({ tags: 'vip, mv-canary' })).toBe(true);
    expect(requestIsDryRun({ tags: ['staff', 'mv-canary'] })).toBe(true);
    expect(requestIsDryRun({ dryRun: 'true' })).toBe(false);
    expect(requestIsDryRun({ tags: 'mv-canary-nope' })).toBe(false);
    expect(requestIsDryRun({})).toBe(false);
  });
});

describe('planFulfillment — no vendor order call', () => {
  it('dry-runs a Design B SKU and does not call fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const plan = await planFulfillment({
      sku: 'MVS-P-1824',
      dryRun: true,
      hasPngUrl: true,
      hasConfigUrl: false,
      label: '18×24 Poster',
      quantity: 1,
    });
    expect(plan.kind).toBe('dry-run');
    expect(planDispatchesVendor(plan)).toBe(false);
    if (plan.kind !== 'dry-run') return;
    expect(plan.body).toMatchObject({
      dryRun: true,
      mode: 'catalogue',
      sku: 'MVS-P-1824',
      vendor: 'gelato',
      productRef: GELATO_1824,
      gelatoProductUid: GELATO_1824,
      printfulVariantId: null,
      widthCm: 45.72,
      heightCm: 60.96,
      dpi: 400,
      wrapApplied: false,
    });
    expect(plan.body.printArea).toEqual({ widthIn: 18, heightIn: 24 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dry-runs a canvas SKU with the wrap skipped when dimensionsArePrintArea is set', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const plan = await planFulfillment({
      sku: 'MVS-C-1824-W',
      tags: ['mv-canary'],
      hasPngUrl: false,
      hasConfigUrl: true,
      configDownloaded: true,
      dimensionsArePrintArea: true,
      label: '18×24 Canvas',
      quantity: 1,
    });
    expect(plan.kind).toBe('dry-run');
    if (plan.kind !== 'dry-run') return;
    expect(plan.body.dryRun).toBe(true);
    expect(plan.body.vendor).toBe('printful');
    expect(plan.body.printfulVariantId).toBe(15699);
    expect(plan.body.printArea).toEqual({ widthIn: 21, heightIn: 27 });
    expect(plan.body.wrapApplied).toBe(false);
    expect(plan.body.dimensionsArePrintArea).toBe(true);
    expect(plan.body.dpi).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still reports wrap on a canvas dry run when the editor flag is absent', async () => {
    const plan = await planFulfillment({
      sku: 'MVS-C-2436-W',
      dryRun: true,
      hasPngUrl: false,
      hasConfigUrl: true,
      configDownloaded: true,
      quantity: 1,
      label: 'canvas',
    });
    expect(plan.kind).toBe('dry-run');
    if (plan.kind !== 'dry-run') return;
    expect(plan.body.wrapApplied).toBe(true);
    expect(plan.body.printArea).toEqual({ widthIn: 27, heightIn: 39 });
    expect(plan.body.dpi).toBeGreaterThanOrEqual(360);
  });

  it('legacy dry run looks up Shopify metafields and never a vendor order URL', async () => {
    shopifyOk('uid-from-metafield');
    const plan = await planFulfillment({ ...legacyBody, dryRun: true });
    expect(plan.kind).toBe('dry-run');
    expect(planDispatchesVendor(plan)).toBe(false);
    if (plan.kind !== 'dry-run') return;
    expect(plan.body).toMatchObject({
      dryRun: true,
      mode: 'legacy',
      sku: null,
      vendor: 'gelato',
      gelatoProductUid: 'uid-from-metafield',
      productRef: 'uid-from-metafield',
      printfulVariantId: null,
      wrapApplied: false,
    });
    expect(plan.body.dpi).toBe(400);
    expect(plan.body.widthCm).toBe(45.72);
    const urls = calls();
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('myshopify.com');
    expect(urls.some(isVendorOrderUrl)).toBe(false);
  });

  it('legacy canvas label with no metafield dry-runs as Printful and does not call a vendor', async () => {
    vi.stubEnv('SHOPIFY_ADMIN_TOKEN', 'test-token');
    vi.stubEnv('SHOPIFY_SHOP', 'test.myshopify.com');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (isVendorOrderUrl(String(url))) throw new Error(`vendor order endpoint called: ${url}`);
      return new Response(JSON.stringify({ metafields: [] }), { status: 200 });
    }));
    const plan = await planFulfillment({
      ...legacyBody,
      sku: 'MVS-NYC-18x24-CANVAS-W',
      label: '18×24 White Canvas',
      tags: 'mv-canary',
    });
    expect(plan.kind).toBe('dry-run');
    if (plan.kind !== 'dry-run') return;
    expect(plan.body.vendor).toBe('printful');
    expect(plan.body.printfulVariantId).toBe(42);
    expect(plan.body.productRef).toBe('42');
    expect(calls().some(isVendorOrderUrl)).toBe(false);
  });

  it('flag off rejects a legacy body with 422 and does not call a vendor', async () => {
    vi.stubEnv('LEGACY_SKU_PASSTHROUGH', 'false');
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const plan = await planFulfillment({ ...legacyBody, sku: 'MVS-50x70-SOLO', dryRun: true });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.httpStatus).toBe(422);
    expect(plan.reason).toBe('sku-unmapped');
    expect(plan.dryRun).toBe(true);
    expect(planDispatchesVendor(plan)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an unknown explicit SKU is 422 in both flag states, including dry run', async () => {
    for (const flag of [undefined, 'false'] as const) {
      vi.stubEnv('LEGACY_SKU_PASSTHROUGH', flag ?? '');
      const fetchSpy = vi.fn(() => {
        throw new Error('network must not be used');
      });
      vi.stubGlobal('fetch', fetchSpy);
      const plan = await planFulfillment({
        sku: 'MVS-NOPE',
        dryRun: true,
        hasPngUrl: true,
        hasConfigUrl: false,
        label: 'nope',
        quantity: 1,
        variantId: 1,
        catalogVariantId: 1,
      });
      expect(plan.kind).toBe('reject');
      if (plan.kind !== 'reject') continue;
      expect(plan.httpStatus).toBe(422);
      expect(plan.reason).toBe('sku-unmapped');
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('a disabled optional SKU stays 422 on dry run with the legacy flag on', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be used');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const plan = await planFulfillment({
      sku: 'MVS-C-1824',
      dryRun: true,
      hasPngUrl: false,
      hasConfigUrl: true,
      label: 'gallery',
      quantity: 1,
    });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('sku-disabled');
    expect(plan.dryRun).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a live legacy order (no sku, flag on, dryRun omitted) is an accept, not a catalogue 422', async () => {
    shopifyOk();
    const plan = await planFulfillment(legacyBody);
    expect(plan.kind).toBe('accept');
    if (plan.kind !== 'accept' || plan.mode !== 'legacy') return;
    expect(plan.resolvedProvider).toBe('gelato');
    expect(plan.gelatoProductUid).toBe('gelato-uid-from-shopify');
    expect(calls().some(isVendorOrderUrl)).toBe(false);
  });

  it('non-canvas with no metafield is the old 422, and dry run still does not call a vendor', async () => {
    vi.stubEnv('SHOPIFY_ADMIN_TOKEN', 'test-token');
    vi.stubEnv('SHOPIFY_SHOP', 'test.myshopify.com');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (isVendorOrderUrl(String(url))) throw new Error(`vendor order endpoint called: ${url}`);
      return new Response(JSON.stringify({ metafields: [] }), { status: 200 });
    }));
    const plan = await planFulfillment({ ...legacyBody, dryRun: true, label: '18×24 Poster' });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('routing-unresolved');
    expect(plan.httpStatus).toBe(422);
    expect(calls().some(isVendorOrderUrl)).toBe(false);
  });
});
