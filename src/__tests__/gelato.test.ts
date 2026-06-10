import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GELATO_API_V4,
  recipientToGelatoAddress,
  fulfillGelato,
} from '../gelato.js';

const RECIPIENT = {
  name:         'Jane Smith',
  address1:     '742 Evergreen Terrace',
  city:         'Springfield',
  state_code:   'IL',
  country_code: 'US',
  zip:          '62701',
  email:        'jane@example.com',
};

beforeEach(() => {
  vi.stubEnv('GELATO_API_KEY',  'gel-test-key');
  vi.stubEnv('GELATO_STORE_ID', 'store-abc');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── recipientToGelatoAddress (v4 quirks) ──────────────────────────────────

describe('recipientToGelatoAddress', () => {
  it('uses Gelato v4 field names (state/country/postCode — not stateCode/countryCode/zip)', () => {
    const out = recipientToGelatoAddress(RECIPIENT);
    expect(out.state).toBe('IL');
    expect(out.country).toBe('US');
    expect(out.postCode).toBe('62701');
    // negative assertions — these names must NOT leak through
    expect(out).not.toHaveProperty('stateCode');
    expect(out).not.toHaveProperty('countryCode');
    expect(out).not.toHaveProperty('zip');
  });

  it('splits "First Last" into firstName + lastName', () => {
    const out = recipientToGelatoAddress({ ...RECIPIENT, name: 'Ada Lovelace' });
    expect(out.firstName).toBe('Ada');
    expect(out.lastName).toBe('Lovelace');
  });

  it('handles compound surnames ("Garcia Marquez")', () => {
    const out = recipientToGelatoAddress({ ...RECIPIENT, name: 'Gabriel Garcia Marquez' });
    expect(out.firstName).toBe('Gabriel');
    expect(out.lastName).toBe('Garcia Marquez');
  });

  it('mirrors single-word names into lastName (Gelato rejects empty lastName)', () => {
    const out = recipientToGelatoAddress({ ...RECIPIENT, name: 'Madonna' });
    expect(out.firstName).toBe('Madonna');
    expect(out.lastName).toBe('Madonna');
  });

  it('passes addressLine2 + phone through as undefined when missing', () => {
    const out = recipientToGelatoAddress(RECIPIENT);
    expect(out.addressLine2).toBeUndefined();
    expect(out.phone).toBeUndefined();
  });

  it('preserves addressLine2 + phone when provided', () => {
    const out = recipientToGelatoAddress({ ...RECIPIENT, address2: 'Apt 5B', phone: '+1-555-0100' });
    expect(out.addressLine2).toBe('Apt 5B');
    expect(out.phone).toBe('+1-555-0100');
  });
});

// ── fulfillGelato — happy + failure paths ─────────────────────────────────

describe('fulfillGelato — order POST', () => {
  it('POSTs to /v4/orders with the X-API-KEY header + USD currency + store ID', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'gel-order-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fulfillGelato('mvb-1', RECIPIENT, 'gel-product-uid', 1, '18x24 Black', 'https://blob.test/x.png');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`${GELATO_API_V4}/orders`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('gel-test-key');
    const body = JSON.parse(String(call[1].body));
    expect(body.currency).toBe('USD');
    expect(body.storeId).toBe('store-abc');
    expect(body.orderReferenceId).toBe('mvb-1');
    expect(body.items[0].productUid).toBe('gel-product-uid');
    expect(body.items[0].files[0].url).toBe('https://blob.test/x.png');
  });

  it('returns without POSTing when GELATO_API_KEY is unset (fail closed)', async () => {
    vi.stubEnv('GELATO_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await fulfillGelato('mvb-no-key', RECIPIENT, 'uid', 1, 'label', 'https://blob.test/x.png');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits [FULFILL-FAIL] gelato-api on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Bad address' }), { status: 422 })));
    const errSpy = console.error as ReturnType<typeof vi.spyOn>;

    await fulfillGelato('mvb-422', RECIPIENT, 'uid', 1, 'label', 'https://blob.test/x.png');

    const callsJoined = errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(callsJoined).toMatch(/\[FULFILL-FAIL\] /);
    expect(callsJoined).toMatch(/"reason":"gelato-api"/);
    expect(callsJoined).toMatch(/"externalId":"mvb-422"/);
  });

  it('emits [FULFILL-FAIL] gelato-uncaught when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    const errSpy = console.error as ReturnType<typeof vi.spyOn>;

    await fulfillGelato('mvb-throw', RECIPIENT, 'uid', 1, 'label', 'https://blob.test/x.png');

    const callsJoined = errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(callsJoined).toMatch(/"reason":"gelato-uncaught"/);
    expect(callsJoined).toMatch(/ETIMEDOUT/);
  });
});
