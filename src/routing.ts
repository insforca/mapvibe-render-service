/**
 * src/routing.ts
 *
 * POD vendor routing: read Shopify variant metafields to decide whether an
 * order ships from Printful or Gelato. Extracted from server.ts for
 * testability. Env vars are read inside the function (not at module load)
 * so vi.stubEnv works in tests without dynamic re-imports.
 *
 * See README "Vendor routing" for the operator-facing contract.
 */

export type RoutingResult = {
  /**
   * 'ok'           : metafields read; provider + uid reflect them
   * 'no-metafield' : lookup succeeded but no pod_partner set — legitimate
   *                  Printful default for legacy variants
   * 'lookup-error' : we couldn't reach Shopify (network, missing token,
   *                  non-2xx, timeout). 422-vs-silent-Printful is decided
   *                  by STRICT_ROUTING_LOOKUP at call site.
   */
  status: 'ok' | 'no-metafield' | 'lookup-error';
  provider: 'printful' | 'gelato';
  gelatoProductUid: string | null;
};

export const ROUTING_CACHE_TTL_MS = 10 * 60 * 1000;

const routingCache = new Map<number, { result: RoutingResult; expiresAt: number }>();

/** Test-only: clear the per-variant routing cache between cases. */
export function _clearRoutingCacheForTests(): void {
  routingCache.clear();
}

/** Read at call time (not import time) so tests can stub via vi.stubEnv. */
export function isStrictRoutingLookup(): boolean {
  return process.env.STRICT_ROUTING_LOOKUP === 'true';
}

export async function resolveGelatoRouting(shopifyVariantId: number): Promise<RoutingResult> {
  const cached = routingCache.get(shopifyVariantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN ?? '';
  const SHOPIFY_SHOP        = process.env.SHOPIFY_SHOP        ?? 'mapvibe-studio.myshopify.com';

  if (!SHOPIFY_ADMIN_TOKEN) {
    console.error('[fulfill/routing] SHOPIFY_ADMIN_TOKEN not set — cannot auto-route');
    return { status: 'lookup-error', provider: 'printful', gelatoProductUid: null };
  }
  try {
    const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/variants/${shopifyVariantId}/metafields.json?namespace=custom&limit=20`;
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type':           'application/json',
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      console.error(`[fulfill/routing] Shopify metafield fetch HTTP ${res.status} for variant ${shopifyVariantId}`);
      return { status: 'lookup-error', provider: 'printful', gelatoProductUid: null };
    }
    const body: any = await res.json();
    const mfs: any[] = body.metafields ?? [];
    const podPartner = mfs.find((m: any) => m.namespace === 'custom' && m.key === 'pod_partner')?.value ?? null;
    const gelatoUid  = mfs.find((m: any) => m.namespace === 'custom' && m.key === 'gelato_uid')?.value  ?? null;

    if (!podPartner) {
      console.log(`[fulfill/routing] variant ${shopifyVariantId} → no pod_partner metafield (legacy → printful)`);
      const result: RoutingResult = { status: 'no-metafield', provider: 'printful', gelatoProductUid: null };
      routingCache.set(shopifyVariantId, { result, expiresAt: Date.now() + ROUTING_CACHE_TTL_MS });
      return result;
    }

    const provider: 'printful' | 'gelato' = podPartner === 'gelato' ? 'gelato' : 'printful';
    console.log(`[fulfill/routing] variant ${shopifyVariantId} → pod_partner=${podPartner} gelato_uid=${gelatoUid ?? 'null'} → ${provider}`);
    const result: RoutingResult = { status: 'ok', provider, gelatoProductUid: gelatoUid };
    routingCache.set(shopifyVariantId, { result, expiresAt: Date.now() + ROUTING_CACHE_TTL_MS });
    return result;
  } catch (err: any) {
    console.error(`[fulfill/routing] Shopify metafield lookup error for variant ${shopifyVariantId}: ${err?.message ?? err}`);
    return { status: 'lookup-error', provider: 'printful', gelatoProductUid: null };
  }
}
