import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPrintfulHeaders,
  resolveCatalogPlacement,
  _clearCatalogCacheForTests,
  findExistingPrintfulOrder,
  resolveExternalId,
  tryUpdateExistingOrder,
} from '../printful.js';

const TEST_HEADERS = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };

beforeEach(() => {
  _clearCatalogCacheForTests();
  vi.stubEnv('PRINTFUL_API_KEY',  'test-key');
  vi.stubEnv('PRINTFUL_STORE_ID', '99999');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── getPrintfulHeaders ────────────────────────────────────────────────────

describe('getPrintfulHeaders', () => {
  it('builds Bearer auth + Content-Type + Store-Id from env', () => {
    const h = getPrintfulHeaders();
    expect(h.Authorization).toBe('Bearer test-key');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-PF-Store-Id']).toBe('99999');
  });

  it('reads env at call time (vi.stubEnv works without re-import)', () => {
    vi.stubEnv('PRINTFUL_API_KEY', 'rotated-key');
    expect(getPrintfulHeaders().Authorization).toBe('Bearer rotated-key');
  });
});

// ── resolveCatalogPlacement ───────────────────────────────────────────────

describe('resolveCatalogPlacement', () => {
  it('returns placement+technique from the first catalog placement entry', async () => {
    const fetchSpy = vi.fn();
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { catalog_product_id: 614 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { placements: [{ placement: 'front', technique: 'embroidery' }] },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await resolveCatalogPlacement(15029, TEST_HEADERS);
    expect(result).toEqual({ placement: 'front', technique: 'embroidery' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back when catalog-variant lookup returns non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const result = await resolveCatalogPlacement(99999, TEST_HEADERS);
    expect(result).toEqual({ placement: 'default', technique: 'PRINTING' });
  });

  it('falls back when product has no placements', async () => {
    const fetchSpy = vi.fn();
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { catalog_product_id: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { placements: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await resolveCatalogPlacement(123, TEST_HEADERS);
    expect(result).toEqual({ placement: 'default', technique: 'PRINTING' });
  });

  it('caches the fallback too — failures do not retry network', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchSpy);

    await resolveCatalogPlacement(777, TEST_HEADERS);
    await resolveCatalogPlacement(777, TEST_HEADERS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches successful lookups across calls', async () => {
    const fetchSpy = vi.fn();
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { catalog_product_id: 614 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { placements: [{ placement: 'front', technique: 'PRINTING' }] },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const a = await resolveCatalogPlacement(15029, TEST_HEADERS);
    const b = await resolveCatalogPlacement(15029, TEST_HEADERS);
    expect(a).toEqual(b);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // 2 calls in first request, cache hit on second
  });
});

// ── findExistingPrintfulOrder ─────────────────────────────────────────────

describe('findExistingPrintfulOrder', () => {
  it('returns null when no order matches the externalId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const result = await findExistingPrintfulOrder('mvb-nope');
    expect(result).toBeNull();
  });

  it('returns id + status + isTerminal=false for an active order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 88001, external_id: 'mvb-1', status: 'PENDING' }],
    }), { status: 200 })));

    const result = await findExistingPrintfulOrder('mvb-1');
    expect(result).toEqual({ id: '88001', status: 'pending', isTerminal: false });
  });

  it('isTerminal=true for cancelled / archived / failed', async () => {
    for (const status of ['canceled', 'cancelled', 'archived', 'failed']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        data: [{ id: 1, external_id: 'mvb-t', status }],
      }), { status: 200 })));

      const result = await findExistingPrintfulOrder('mvb-t');
      expect(result?.isTerminal, `status=${status}`).toBe(true);
    }
  });

  it('returns null on non-2xx from Printful', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status: 502 })));
    expect(await findExistingPrintfulOrder('mvb-x')).toBeNull();
  });

  it('returns null when fetch throws (network)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    expect(await findExistingPrintfulOrder('mvb-x')).toBeNull();
  });
});

// ── resolveExternalId (suffix retry algorithm) ────────────────────────────

describe('resolveExternalId', () => {
  it('returns baseId when no existing order found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    expect(await resolveExternalId('mvb-fresh')).toBe('mvb-fresh');
  });

  it('returns null when an ACTIVE order already exists (no double-charge)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 1, external_id: 'mvb-active', status: 'pending' }],
    }), { status: 200 })));
    expect(await resolveExternalId('mvb-active')).toBeNull();
  });

  it('appends -r2 suffix when a TERMINAL order exists, then succeeds', async () => {
    const fetchSpy = vi.fn();
    // First call: terminal for base
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 1, external_id: 'mvb-term', status: 'cancelled' }],
    }), { status: 200 }));
    // Second call: no order for mvb-term-r2 → ok
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveExternalId('mvb-term')).toBe('mvb-term-r2');
  });

  it('returns null after 10 terminal collisions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({
      data: [{ id: 1, external_id: decodeURIComponent(url.split('external_id=')[1]), status: 'archived' }],
    }), { status: 200 })));

    expect(await resolveExternalId('mvb-cursed')).toBeNull();
  });
});

// ── tryUpdateExistingOrder ────────────────────────────────────────────────

describe('tryUpdateExistingOrder', () => {
  const PAYLOAD_ARGS = (autoConfirm = false) =>
    ['mvb-1', 'https://blob.test/x.png', 999, 1, '18x24 Black', autoConfirm, TEST_HEADERS] as const;

  it('returns false when no existing order found (caller should create fresh)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    expect(await tryUpdateExistingOrder(...PAYLOAD_ARGS())).toBe(false);
  });

  it('returns false when existing order is non-updatable (shipped/fulfilled)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 1, external_id: 'mvb-1', status: 'fulfilled' }],
    }), { status: 200 })));
    expect(await tryUpdateExistingOrder(...PAYLOAD_ARGS())).toBe(false);
  });

  it('returns true after a successful PUT on a draft order', async () => {
    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 88001, external_id: 'mvb-1', status: 'draft' }],
    }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: { updated: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await tryUpdateExistingOrder(...PAYLOAD_ARGS())).toBe(true);
    // Find the PUT call — second invocation
    const putCall = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(putCall[1].method).toBe('PUT');
    expect(putCall[0]).toMatch(/\/orders\/88001$/);
  });

  it('calls /confirm when autoConfirm=true on a draft order', async () => {
    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 88001, external_id: 'mvb-1', status: 'draft' }],
    }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 })); // confirm
    vi.stubGlobal('fetch', fetchSpy);

    expect(await tryUpdateExistingOrder(...PAYLOAD_ARGS(true))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const confirmCall = fetchSpy.mock.calls[2] as unknown as [string, RequestInit];
    expect(confirmCall[1].method).toBe('POST');
    expect(confirmCall[0]).toMatch(/\/orders\/88001\/confirm$/);
  });

  it('issues DELETE after a failed PUT on a pending order (caller picks fresh suffix)', async () => {
    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 88001, external_id: 'mvb-1', status: 'pending' }],
    }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'cannot update' }), { status: 400 }));
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 })); // DELETE
    vi.stubGlobal('fetch', fetchSpy);

    expect(await tryUpdateExistingOrder(...PAYLOAD_ARGS())).toBe(false);
    const deleteCall = fetchSpy.mock.calls[2] as unknown as [string, RequestInit];
    expect(deleteCall[1].method).toBe('DELETE');
  });
});
