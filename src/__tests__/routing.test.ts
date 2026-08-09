import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveGelatoRouting, _clearRoutingCacheForTests, isStrictRoutingLookup } from '../routing.js';

const VARIANT_ID = 12345678901;

function mockFetchResponse(opts: { ok: boolean; status?: number; body?: unknown; throws?: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (opts.throws) throw opts.throws;
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? (opts.ok ? 200 : 500),
    });
  }));
}

beforeEach(() => {
  _clearRoutingCacheForTests();
  vi.stubEnv('SHOPIFY_ADMIN_TOKEN', 'test-token');
  vi.stubEnv('SHOPIFY_SHOP', 'test.myshopify.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveGelatoRouting — three-state result', () => {
  it("'ok' — metafields present, routes to gelato + carries the uid", async () => {
    mockFetchResponse({
      ok: true,
      body: { metafields: [
        { namespace: 'custom', key: 'pod_partner', value: 'gelato' },
        { namespace: 'custom', key: 'gelato_uid', value: 'gelato-uid-abc' },
      ] },
    });
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result).toEqual({ status: 'ok', provider: 'gelato', gelatoProductUid: 'gelato-uid-abc' });
  });

  it("'ok' — pod_partner=printful is honored (not silently dropped)", async () => {
    mockFetchResponse({
      ok: true,
      body: { metafields: [{ namespace: 'custom', key: 'pod_partner', value: 'printful' }] },
    });
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result.status).toBe('ok');
    expect(result.provider).toBe('printful');
  });

  it("'no-metafield' — Shopify responds 200 but no pod_partner set", async () => {
    mockFetchResponse({ ok: true, body: { metafields: [] } });
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result.status).toBe('no-metafield');
    expect(result.provider).toBe('printful');
  });

  it("'lookup-error' — Shopify Admin API returns non-2xx", async () => {
    mockFetchResponse({ ok: false, status: 502 });
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result.status).toBe('lookup-error');
  });

  it("'lookup-error' — fetch throws (network / timeout)", async () => {
    mockFetchResponse({ ok: false, throws: new Error('ETIMEDOUT') });
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result.status).toBe('lookup-error');
  });

  it("'lookup-error' — SHOPIFY_ADMIN_TOKEN missing (fail closed)", async () => {
    vi.stubEnv('SHOPIFY_ADMIN_TOKEN', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await resolveGelatoRouting(VARIANT_ID);
    expect(result.status).toBe('lookup-error');
    expect(fetchSpy).not.toHaveBeenCalled(); // never reaches the network
  });
});

describe('resolveGelatoRouting — cache', () => {
  it('caches successful lookups; repeat call skips network', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      metafields: [{ namespace: 'custom', key: 'pod_partner', value: 'gelato' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const first  = await resolveGelatoRouting(VARIANT_ID);
    const second = await resolveGelatoRouting(VARIANT_ID);

    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cache hit on second call
  });

  it("does NOT cache 'lookup-error' results — retries on next call", async () => {
    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      metafields: [{ namespace: 'custom', key: 'pod_partner', value: 'gelato' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const first  = await resolveGelatoRouting(VARIANT_ID);
    const second = await resolveGelatoRouting(VARIANT_ID);

    expect(first.status).toBe('lookup-error');
    expect(second.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // lookup-error never cached
  });
});

describe('isStrictRoutingLookup — strict by default', () => {
  it('returns true when STRICT_ROUTING_LOOKUP=true', () => {
    vi.stubEnv('STRICT_ROUTING_LOOKUP', 'true');
    expect(isStrictRoutingLookup()).toBe(true);
  });

  it('returns true when unset (strict is the default — silent Printful fallback routes non-canvas items to the wrong vendor)', () => {
    vi.stubEnv('STRICT_ROUTING_LOOKUP', '');
    expect(isStrictRoutingLookup()).toBe(true);
  });

  it('returns false ONLY for the literal opt-out value "false"', () => {
    vi.stubEnv('STRICT_ROUTING_LOOKUP', 'false');
    expect(isStrictRoutingLookup()).toBe(false);
    vi.stubEnv('STRICT_ROUTING_LOOKUP', 'FALSE');
    expect(isStrictRoutingLookup()).toBe(true);
    vi.stubEnv('STRICT_ROUTING_LOOKUP', '0');
    expect(isStrictRoutingLookup()).toBe(true);
  });
});
