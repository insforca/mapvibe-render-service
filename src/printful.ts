/**
 * src/printful.ts
 *
 * Printful API client surface: catalog placement lookup, existing-order
 * discovery + dedup-via-suffix, in-place update of draft/pending orders.
 * Extracted from server.ts so the v2/v1 fallback logic and the
 * suffix-retry algorithm can be unit-tested without loading the
 * MapLibre/canvas/sharp native deps.
 *
 * Env vars (read lazily inside functions, not at module load, so vitest
 * stubEnv works without dynamic re-imports):
 *   PRINTFUL_API_KEY   — Bearer token
 *   PRINTFUL_STORE_ID  — scopes API calls (default: 17897492)
 */

export const PRINTFUL_API_V2 = 'https://api.printful.com/v2';
export const PRINTFUL_API_V1 = 'https://api.printful.com';

export const PRINTFUL_TERMINAL_STATUSES = new Set(['canceled', 'cancelled', 'archived', 'failed']);

export interface PrintfulOrderMatch {
  id:         string;
  status:     string;
  isTerminal: boolean;
}

/** Build the standard Printful HTTP headers from current env. */
export function getPrintfulHeaders(): Record<string, string> {
  const key      = process.env.PRINTFUL_API_KEY      ?? '';
  const storeId  = process.env.PRINTFUL_STORE_ID     ?? '17897492';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (storeId) headers['X-PF-Store-Id'] = storeId;
  return headers;
}

// ── Catalog placement resolution (cached per variant) ─────────────────────

const catalogPlacementCache = new Map<number, { placement: string; technique: string }>();

/** Test-only: drop the catalog cache between cases. */
export function _clearCatalogCacheForTests(): void {
  catalogPlacementCache.clear();
}

/**
 * Resolve the correct v2 placement key and technique for a given catalog
 * variant. Calls /v2/catalog-variants/{id} then /v2/catalog-products/{id}
 * to discover the first available placement + technique. Results are
 * cached per variantId. Falls back to { placement: 'default', technique:
 * 'PRINTING' } on any failure so callers can always proceed.
 */
export async function resolveCatalogPlacement(
  catalogVariantId: number,
  pfHeaders: Record<string, string>,
): Promise<{ placement: string; technique: string }> {
  if (catalogPlacementCache.has(catalogVariantId)) {
    return catalogPlacementCache.get(catalogVariantId)!;
  }
  const fallback = { placement: 'default', technique: 'PRINTING' };
  try {
    const varRes = await fetch(
      `${PRINTFUL_API_V2}/catalog-variants/${catalogVariantId}`,
      { headers: pfHeaders },
    );
    if (!varRes.ok) {
      console.warn(`[catalog] variant lookup ${catalogVariantId} HTTP ${varRes.status} — using fallback`);
      catalogPlacementCache.set(catalogVariantId, fallback);
      return fallback;
    }
    const varData: any = await varRes.json();
    const productId: number | undefined = varData.data?.catalog_product_id;
    if (!productId) {
      catalogPlacementCache.set(catalogVariantId, fallback);
      return fallback;
    }

    const prodRes = await fetch(
      `${PRINTFUL_API_V2}/catalog-products/${productId}`,
      { headers: pfHeaders },
    );
    if (!prodRes.ok) {
      console.warn(`[catalog] product lookup ${productId} HTTP ${prodRes.status} — using fallback`);
      catalogPlacementCache.set(catalogVariantId, fallback);
      return fallback;
    }
    const prodData: any = await prodRes.json();
    const placements: any[] = prodData.data?.placements ?? [];
    const first = placements[0];
    if (!first) {
      catalogPlacementCache.set(catalogVariantId, fallback);
      return fallback;
    }

    const result = { placement: String(first.placement), technique: String(first.technique) };
    console.log(`[catalog] variant ${catalogVariantId} → placement '${result.placement}' technique '${result.technique}'`);
    catalogPlacementCache.set(catalogVariantId, result);
    return result;
  } catch (err: any) {
    console.warn(`[catalog] lookup error for variant ${catalogVariantId}: ${err?.message ?? err} — using fallback`);
    catalogPlacementCache.set(catalogVariantId, fallback);
    return fallback;
  }
}

// ── Existing-order discovery + suffix-retry externalId resolution ─────────

export async function findExistingPrintfulOrder(externalId: string): Promise<PrintfulOrderMatch | null> {
  try {
    const res = await fetch(
      `${PRINTFUL_API_V1}/orders?external_id=${encodeURIComponent(externalId)}`,
      { headers: getPrintfulHeaders() },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const orders: Array<{ id: number; external_id: string | null; status: string }> = data?.data ?? data?.result ?? [];
    const match = orders.find(o => o.external_id === externalId);
    if (!match) return null;
    const status = (match.status ?? '').toLowerCase();
    return { id: String(match.id), status, isTerminal: PRINTFUL_TERMINAL_STATUSES.has(status) };
  } catch {
    return null;
  }
}

/**
 * Resolve a stable externalId for Printful order creation.
 *  - candidate ID has an ACTIVE order → return null (skip creation)
 *  - candidate ID has a TERMINAL order (cancelled/archived) → auto-append `-rN`
 *  - up to 10 suffix attempts; returns null if no free ID found
 */
export async function resolveExternalId(baseId: string): Promise<string | null> {
  let candidate = baseId;
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await findExistingPrintfulOrder(candidate);
    if (!existing) return candidate;
    if (!existing.isTerminal) {
      console.log(`[fulfill] Active Printful order ${existing.id} (${existing.status}) already exists for ${candidate} — skipping`);
      return null;
    }
    console.log(`[fulfill] Terminal order ${existing.id} (${existing.status}) for ${candidate} — trying next suffix`);
    const suffix = `-r${attempt + 2}`;
    candidate = baseId.slice(0, 32 - suffix.length) + suffix;
  }
  console.error(`[fulfill] Could not find a free externalId after 10 attempts for base ${baseId}`);
  return null;
}

// ── In-place draft/pending order update ───────────────────────────────────

/**
 * Attempt to update an existing Printful draft/pending order with a new PNG.
 * Returns true if the order was updated (caller should skip creation).
 * Returns false if no updatable order exists (caller should create fresh).
 *
 * Failure modes:
 *  - No existing order found → false (caller creates)
 *  - Existing order in non-updatable status (e.g. shipped) → false
 *  - PUT fails on a draft/pending order → tries DELETE to free the externalId
 *    so the caller's next resolveExternalId() picks a fresh -rN suffix
 */
export async function tryUpdateExistingOrder(
  baseId: string,
  finalPngUrl: string,
  variantId: number,
  quantity: number,
  label: string,
  autoConfirm: boolean,
  pfHeaders: Record<string, string>,
  gift?: { message: string; para?: string },
): Promise<boolean> {
  const existing = await findExistingPrintfulOrder(baseId);
  if (!existing) return false;
  if (existing.status !== 'draft' && existing.status !== 'pending') return false;

  console.log(`[fulfill] Existing ${existing.status} order ${existing.id} for ${baseId} — updating with new PNG`);
  const giftMessage = gift?.message
    ? (gift.para ? `To ${gift.para}: ${gift.message}` : gift.message)
    : null;
  const updatePayload: any = {
    items: [{ variant_id: variantId, quantity, name: `MapVibe — ${label}`, files: [{ type: 'default', url: finalPngUrl }] }],
  };
  if (giftMessage) updatePayload.gift = { subject: 'A gift for you', message: giftMessage };

  try {
    const updateRes = await fetch(`${PRINTFUL_API_V1}/orders/${existing.id}`, {
      method: 'PUT', headers: pfHeaders, body: JSON.stringify(updatePayload),
    });
    if (!updateRes.ok) {
      const errData = await updateRes.json().catch(() => ({}));
      console.error(`[fulfill] Failed to update order ${existing.id}:`, errData);

      // Draft/pending orders may fail PUT — delete/cancel them so
      // resolveExternalId can assign a -rN suffix and create a fresh order.
      if (existing.status === 'pending' || existing.status === 'draft') {
        console.log(`[fulfill] Attempting to cancel pending order ${existing.id} to allow re-creation`);
        try {
          const cancelRes = await fetch(`${PRINTFUL_API_V1}/orders/${existing.id}`, {
            method: 'DELETE', headers: pfHeaders,
          });
          if (cancelRes.ok) {
            console.log(`[fulfill] Pending order ${existing.id} cancelled — fresh order will be created`);
          } else {
            const cancelErr = await cancelRes.json().catch(() => ({}));
            console.warn(`[fulfill] Could not cancel pending order ${existing.id}:`, cancelErr);
          }
        } catch (cancelErr: any) {
          console.warn(`[fulfill] Cancel attempt threw for ${existing.id}:`, cancelErr);
        }
      }
      return false;
    }
    console.log(`[fulfill] Order ${existing.id} (${existing.status}) updated with new PNG: ${finalPngUrl}`);

    if (autoConfirm && existing.status === 'draft') {
      const confirmRes = await fetch(`${PRINTFUL_API_V1}/orders/${existing.id}/confirm`, {
        method: 'POST', headers: pfHeaders,
      });
      if (confirmRes.ok) {
        console.log(`[fulfill] Order ${existing.id} confirmed`);
      } else {
        const confirmErr = await confirmRes.json().catch(() => ({}));
        console.warn(`[fulfill] Order ${existing.id} updated but confirm failed:`, confirmErr);
      }
    }
    return true;
  } catch (err: any) {
    console.error(`[fulfill] Error updating order ${existing.id}:`, err);
    return false;
  }
}
