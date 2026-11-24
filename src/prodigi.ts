/**
 * src/prodigi.ts
 *
 * Prodigi Print API v4 client: address mapping and a one-shot order POST.
 * Same shape as gelato.ts. Every HTTP call goes through vendorFetch, so
 * FULFILL_DRY_RUN holds it.
 *
 * Env vars (read lazily at call time so vitest stubEnv works):
 *   PRODIGI_API_KEY      X-API-Key header
 *   PRODIGI_API_BASE     default https://api.prodigi.com/v4.0 (sandbox: https://api.sandbox.prodigi.com/v4.0)
 *   PRODIGI_CALLBACK_URL optional; per-order callbackUrl for status/shipment events
 *
 * Duplicates: the idempotencyKey is derived from the order line id and the SKU,
 * so a Shopify webhook replay or a manual re-trigger can never create a second
 * Prodigi order. Prodigi answers AlreadyExists, which counts as submitted.
 */
import { createHash } from 'crypto';
import { assertDispatchAllowed, vendorFetch, DispatchHeldError, type HeldResult } from './vendor-dispatch.js';
import { notifyFulfillFail } from './alerting.js';

export const PRODIGI_API_LIVE = 'https://api.prodigi.com/v4.0';
export const PRODIGI_SHIPPING_METHOD = 'Standard';

/**
 * Product attributes Prodigi requires per SKU (from GET /products/{sku}, 2026-11-24).
 * A SKU missing here is refused before any call: an order without its
 * attributes would be rejected or, worse, defaulted by the vendor.
 */
export const PRODIGI_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'GLOBAL-HPR-18X24': { paperType: 'HPR', substrateWeight: '308gsm' },
  'GLOBAL-HPR-24X36': { paperType: 'HPR', substrateWeight: '308gsm' },
};

export function prodigiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PRODIGI_API_BASE ?? '').trim().replace(/\/+$/, '') || PRODIGI_API_LIVE;
}

/** A stable GUID-shaped key: the same order line and SKU always give the same key. */
export function prodigiIdempotencyKey(externalId: string, sku: string): string {
  const h = createHash('sha256').update(`mapvibe:${externalId}:${sku}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Our recipient shape (Printful field names) to Prodigi v4 `recipient`. */
export function recipientToProdigi(recipient: any): Record<string, unknown> {
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    name: clean(recipient?.name) ?? '',
    email: clean(recipient?.email),
    phoneNumber: clean(recipient?.phone),
    address: {
      line1: clean(recipient?.address1) ?? '',
      line2: clean(recipient?.address2),
      postalOrZipCode: clean(recipient?.zip) ?? '',
      countryCode: (clean(recipient?.country_code) ?? '').toUpperCase(),
      townOrCity: clean(recipient?.city) ?? '',
      stateOrCounty: clean(recipient?.state_code),
    },
  };
}

/** Required recipient fields per the v4 reference; returns the first missing one. */
export function missingProdigiField(r: Record<string, any>): string | null {
  if (!r.name) return 'recipient.name';
  for (const f of ['line1', 'postalOrZipCode', 'countryCode', 'townOrCity']) {
    if (!r.address?.[f]) return `recipient.address.${f}`;
  }
  return null;
}

export function buildProdigiOrder(
  externalId: string,
  recipient: any,
  sku: string,
  quantity: number,
  finalPngUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const attributes = PRODIGI_ATTRIBUTES[sku];
  if (!attributes) throw new Error(`No Prodigi attributes for ${sku}`);
  const callbackUrl = (env.PRODIGI_CALLBACK_URL ?? '').trim();
  return {
    merchantReference: externalId,
    idempotencyKey: prodigiIdempotencyKey(externalId, sku),
    shippingMethod: PRODIGI_SHIPPING_METHOD,
    ...(callbackUrl ? { callbackUrl } : {}),
    recipient: recipientToProdigi(recipient),
    items: [{
      merchantReference: 'item-1',
      sku,
      copies: quantity,
      // The print file has the product's aspect ratio (checked by the catalogue
      // fixture), so fill only scales; it does not crop.
      sizing: 'fillPrintArea',
      attributes: { ...attributes },
      assets: [{ printArea: 'default', url: finalPngUrl }],
    }],
  };
}

export async function fulfillProdigi(
  externalId: string,
  recipient: any,
  sku: string,
  quantity: number,
  label: string,
  finalPngUrl: string,
): Promise<HeldResult | { status: 'submitted' | 'failed' }> {
  const context = { vendor: 'prodigi' as const, orderId: externalId, lineItem: sku };
  try {
    assertDispatchAllowed(context);
  } catch (err) {
    if (err instanceof DispatchHeldError) return err.result;
    throw err;
  }
  const key = (process.env.PRODIGI_API_KEY ?? '').trim();
  if (!key) {
    console.error(`[fulfill/prodigi] PRODIGI_API_KEY not configured — order ${externalId} not submitted`);
    notifyFulfillFail(externalId, 'prodigi-api', 'PRODIGI_API_KEY not configured');
    return { status: 'failed' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = buildProdigiOrder(externalId, recipient, sku, quantity, finalPngUrl);
  } catch (err: any) {
    console.error(`[fulfill/prodigi] ${err?.message ?? err} — order ${externalId} not submitted`);
    notifyFulfillFail(externalId, 'prodigi-api', String(err?.message ?? err));
    return { status: 'failed' };
  }
  const missing = missingProdigiField(payload.recipient as Record<string, any>);
  if (missing) {
    console.error(`[fulfill/prodigi] ${missing} is empty — order ${externalId} not submitted`);
    notifyFulfillFail(externalId, 'prodigi-api', `${missing} is empty`);
    return { status: 'failed' };
  }
  try {
    const res = await vendorFetch(context, `${prodigiApiBase()}/orders`, {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data: any = await res.json().catch(() => ({}));
    const outcome = String(data?.outcome ?? '');
    if (res.ok && /^(created|createdwithissues|alreadyexists|onhold)$/i.test(outcome)) {
      const id = data?.order?.id ?? data?.id ?? '?';
      console.log(`[fulfill/prodigi] Order ${outcome}: ${id} (${label}) for ${externalId}`);
      if (/createdwithissues/i.test(outcome)) {
        // Issues on a created order (for example the US sales tax notice) are not fatal; keep them in the log.
        console.error(`[fulfill/prodigi] issues for ${externalId}: ${JSON.stringify(data?.order?.issues ?? data?.issues ?? []).slice(0, 400)}`);
      }
      return { status: 'submitted' };
    }
    console.error(`[fulfill/prodigi] FAILED for ${externalId} HTTP ${res.status} outcome=${outcome || 'none'} — ${JSON.stringify(data).slice(0, 400)}`);
    notifyFulfillFail(externalId, 'prodigi-api', { http: res.status, outcome, body: data });
  } catch (err: any) {
    if (err instanceof DispatchHeldError) return err.result;
    console.error(`[fulfill/prodigi] Error for ${externalId}: ${err?.message ?? err}`);
    notifyFulfillFail(externalId, 'prodigi-uncaught', err);
  }
  return { status: 'failed' };
}
