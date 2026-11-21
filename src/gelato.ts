/**
 * src/gelato.ts
 *
 * Gelato v4 client. Smaller surface than Printful — Gelato doesn't need
 * dedup or in-place updates, so this is just address mapping + a one-shot
 * order POST. Extracted from server.ts to match the same env-read-at-call
 * pattern as routing/printful so vitest stubEnv works cleanly.
 *
 * Env vars (read lazily inside fulfillGelato):
 *   GELATO_API_KEY    — X-API-KEY header
 *   GELATO_STORE_ID   — scopes the order (default: known mapvibe store)
 */
import { assertDispatchAllowed, vendorFetch, DispatchHeldError, type HeldResult } from './vendor-dispatch.js';
import { notifyFulfillFail } from './alerting.js';

export const GELATO_API_V4 = 'https://order.gelatoapis.com/v4';

/**
 * Map our internal recipient shape to Gelato v4's `shippingAddress` shape.
 *
 * Gelato v4 quirks (vs Printful):
 *   - `state` not `stateCode`
 *   - `country` not `countryCode`
 *   - `postCode` not `zip`
 *   - first/last name are split fields — single-name recipients land the
 *     same value in both so Gelato's validator doesn't reject an empty
 *     lastName.
 */
export function recipientToGelatoAddress(
  recipient: any,
): Record<string, string | undefined> {
  const nameParts = (recipient.name ?? '').split(' ');
  return {
    firstName:    nameParts[0]  ?? '',
    lastName:     (nameParts.slice(1).join(' ') || nameParts[0]) ?? '',
    addressLine1: recipient.address1,
    addressLine2: recipient.address2 ?? undefined,
    city:         recipient.city,
    state:        recipient.state_code,
    postCode:     recipient.zip,
    country:      recipient.country_code,
    email:        recipient.email,
    phone:        recipient.phone ?? undefined,
  };
}

/**
 * Submit a single Gelato v4 order. Fire-and-forget shape — terminal
 * failures emit `[FULFILL-FAIL]` via notifyFulfillFail (see alerting.ts).
 * Returns an explicit held result when dispatch is paused, never submission success.
 */
export async function fulfillGelato(
  externalId:   string,
  recipient:    any,
  productUid:   string,
  quantity:     number,
  label:        string,
  finalPngUrl:  string,
): Promise<HeldResult | { status: 'submitted' | 'failed' }> {
  try {
    assertDispatchAllowed({ vendor: 'gelato', orderId: externalId, lineItem: productUid });
  } catch (err) {
    if (err instanceof DispatchHeldError) return err.result;
    throw err;
  }
  const GELATO_KEY      = process.env.GELATO_API_KEY  ?? '';
  const GELATO_STORE_ID = process.env.GELATO_STORE_ID ?? 'e611e2bb-567a-42af-8e95-66e1ef54d156';

  if (!GELATO_KEY) {
    console.error(`[fulfill/gelato] GELATO_API_KEY not configured — order ${externalId} not submitted`);
    notifyFulfillFail(externalId, 'gelato-api', 'GELATO_API_KEY not configured');
    return { status: 'failed' };
  }
  const headers: Record<string, string> = {
    'X-API-KEY':    GELATO_KEY,
    'Content-Type': 'application/json',
  };
  const payload = {
    orderType:           'order',
    orderReferenceId:    externalId,
    customerReferenceId: externalId,
    currency:            'USD',
    storeId:             GELATO_STORE_ID,
    // Posters and framed posters are one print area. Gelato v4 fills that
    // area from a single file of type "default" (the same item shape for a
    // giclée UID and a frame_and_poster UID).
    items: [{ itemReferenceId: 'item-1', productUid, files: [{ type: 'default', url: finalPngUrl }], quantity }],
    shippingAddress: recipientToGelatoAddress(recipient),
    preventDuplicate: true,
  };
  try {
    const res  = await vendorFetch({ vendor: 'gelato', orderId: externalId, lineItem: productUid }, `${GELATO_API_V4}/orders`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`[fulfill/gelato] Order created: ${data.id ?? '?'} (${label}) for ${externalId}`);
      return { status: 'submitted' };
    } else {
      console.error(`[fulfill/gelato] FAILED for ${externalId} HTTP ${res.status} — ${JSON.stringify(data).slice(0, 400)}`);
      notifyFulfillFail(externalId, 'gelato-api', { http: res.status, body: data });
    }
  } catch (err: any) {
    if (err instanceof DispatchHeldError) return err.result;
    console.error(`[fulfill/gelato] Error for ${externalId}: ${err?.message ?? err}`);
    notifyFulfillFail(externalId, 'gelato-uncaught', err);
  }
  return { status: 'failed' };
}
