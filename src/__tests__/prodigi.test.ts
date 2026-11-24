import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PRODIGI_API_LIVE,
  PRODIGI_ATTRIBUTES,
  buildProdigiOrder,
  fulfillProdigi,
  missingProdigiField,
  prodigiApiBase,
  prodigiIdempotencyKey,
  recipientToProdigi,
} from '../prodigi.js';
import { evaluateFulfillGate } from '../fulfill-gate.js';
import { _resetCatalogueCacheForTests, loadCatalogue } from '../catalogue.js';
import { isVendorOrderUrl } from '../fulfill-plan.js';

const RECIPIENT = {
  name: 'Jane Smith',
  address1: '742 Evergreen Terrace',
  address2: 'Apt 2',
  city: 'Springfield',
  state_code: 'IL',
  country_code: 'us',
  zip: '62701',
  email: 'jane@example.com',
  phone: '+1 555 0100',
};
const PNG = 'https://blob.example/poster-1.png';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.stubEnv('PRODIGI_API_KEY', 'prodigi-test-key');
  vi.stubEnv('PRODIGI_API_BASE', '');
  vi.stubEnv('PRODIGI_CALLBACK_URL', '');
  vi.stubEnv('FULFILL_DRY_RUN', 'false');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetCatalogueCacheForTests();
});

describe('recipientToProdigi', () => {
  it('maps our Printful-style fields to Prodigi v4 names', () => {
    const r = recipientToProdigi(RECIPIENT) as any;
    expect(r).toMatchObject({ name: 'Jane Smith', email: 'jane@example.com', phoneNumber: '+1 555 0100' });
    expect(r.address).toEqual({
      line1: '742 Evergreen Terrace', line2: 'Apt 2', postalOrZipCode: '62701',
      countryCode: 'US', townOrCity: 'Springfield', stateOrCounty: 'IL',
    });
  });

  it('reports the first missing required field', () => {
    expect(missingProdigiField(recipientToProdigi(RECIPIENT) as any)).toBeNull();
    expect(missingProdigiField(recipientToProdigi({ ...RECIPIENT, zip: ' ' }) as any)).toBe('recipient.address.postalOrZipCode');
    expect(missingProdigiField(recipientToProdigi({ ...RECIPIENT, name: '' }) as any)).toBe('recipient.name');
  });
});

describe('order payload', () => {
  it('is Standard shipping, fillPrintArea, with the SKU attributes and a stable idempotency key', () => {
    const o = buildProdigiOrder('1001-1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, PNG) as any;
    expect(o.shippingMethod).toBe('Standard');
    expect(o.merchantReference).toBe('1001-1');
    expect(o.items[0]).toMatchObject({ sku: 'GLOBAL-HPR-18X24', copies: 1, sizing: 'fillPrintArea',
      attributes: { paperType: 'HPR', substrateWeight: '308gsm' }, assets: [{ printArea: 'default', url: PNG }] });
    expect(o.idempotencyKey).toBe(prodigiIdempotencyKey('1001-1', 'GLOBAL-HPR-18X24'));
    expect(o.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(prodigiIdempotencyKey('1001-2', 'GLOBAL-HPR-18X24')).not.toBe(o.idempotencyKey);
    expect(o).not.toHaveProperty('callbackUrl');
  });

  it('adds callbackUrl only when configured', () => {
    const o = buildProdigiOrder('1', RECIPIENT, 'GLOBAL-HPR-24X36', 1, PNG, { PRODIGI_CALLBACK_URL: 'https://app.example/api/prodigi' }) as any;
    expect(o.callbackUrl).toBe('https://app.example/api/prodigi');
  });

  it('refuses a SKU without known attributes', () => {
    expect(() => buildProdigiOrder('1', RECIPIENT, 'GLOBAL-UNKNOWN', 1, PNG)).toThrow(/No Prodigi attributes/);
  });

  it('defaults to the live API and honours PRODIGI_API_BASE', () => {
    expect(prodigiApiBase({})).toBe(PRODIGI_API_LIVE);
    expect(prodigiApiBase({ PRODIGI_API_BASE: 'https://api.sandbox.prodigi.com/v4.0/' })).toBe('https://api.sandbox.prodigi.com/v4.0');
  });

  it('every catalogue Prodigi row has attributes, so no order is sent without them', () => {
    const refs = loadCatalogue().filter(r => r.vendor === 'prodigi').map(r => r.productRef);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(PRODIGI_ATTRIBUTES[ref]).toBeDefined();
  });
});

describe('fulfillProdigi', () => {
  it('posts once to /orders with the API key header', async () => {
    const fetchMock = mockFetch(200, { outcome: 'Created', order: { id: 'ord_1' } });
    const out = await fulfillProdigi('1001-1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, 'Lisbon', PNG);
    expect(out).toEqual({ status: 'submitted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PRODIGI_API_LIVE}/orders`);
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('prodigi-test-key');
    expect(JSON.parse(String(init.body)).items[0].sku).toBe('GLOBAL-HPR-18X24');
  });

  it('treats AlreadyExists (a replay) as submitted, not as a failure', async () => {
    mockFetch(200, { outcome: 'AlreadyExists', order: { id: 'ord_1' } });
    expect(await fulfillProdigi('1001-1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, 'Lisbon', PNG)).toEqual({ status: 'submitted' });
  });

  it('is held by FULFILL_DRY_RUN and makes no HTTP call', async () => {
    vi.stubEnv('FULFILL_DRY_RUN', 'true');
    const fetchMock = mockFetch(200, { outcome: 'Created' });
    const out = await fulfillProdigi('1001-1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, 'Lisbon', PNG);
    expect(out).toMatchObject({ status: 'held', shipped: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without a key, an unknown SKU or an incomplete address, with no HTTP call', async () => {
    const fetchMock = mockFetch(200, { outcome: 'Created' });
    vi.stubEnv('PRODIGI_API_KEY', '');
    expect(await fulfillProdigi('1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, 'x', PNG)).toEqual({ status: 'failed' });
    vi.stubEnv('PRODIGI_API_KEY', 'k');
    expect(await fulfillProdigi('1', RECIPIENT, 'GLOBAL-NOPE', 1, 'x', PNG)).toEqual({ status: 'failed' });
    expect(await fulfillProdigi('1', { ...RECIPIENT, city: '' }, 'GLOBAL-HPR-18X24', 1, 'x', PNG)).toEqual({ status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a vendor error as failed', async () => {
    mockFetch(400, { outcome: 'ValidationFailed', failures: {} });
    expect(await fulfillProdigi('1', RECIPIENT, 'GLOBAL-HPR-18X24', 1, 'x', PNG)).toEqual({ status: 'failed' });
  });
});

describe('catalogue routing', () => {
  it('Photo Rag rows are off by default and route to Prodigi when optional rows are enabled', () => {
    const input = { sku: 'MVS-PR-1824', hasPngUrl: false, hasConfigUrl: true, configDownloaded: true } as any;
    const off = evaluateFulfillGate(input);
    expect(off).toMatchObject({ ok: false, reason: 'sku-disabled' });
    vi.stubEnv('CATALOGUE_ENABLE_OPTIONAL', 'true');
    const on = evaluateFulfillGate(input) as any;
    expect(on).toMatchObject({ ok: true, vendor: 'prodigi', prodigiSku: 'GLOBAL-HPR-18X24', gelatoProductUid: null, printfulVariantId: null });
    expect(on.dims).toMatchObject({ width: 7200, height: 9600 });
  });

  it('the planner treats Prodigi as an order endpoint it must never call', () => {
    expect(isVendorOrderUrl('https://api.prodigi.com/v4.0/orders')).toBe(true);
    expect(isVendorOrderUrl('https://api.sandbox.prodigi.com/v4.0/orders')).toBe(true);
  });
});
