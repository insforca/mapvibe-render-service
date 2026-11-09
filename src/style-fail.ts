/**
 * Turn a rejected fulfill route into the existing [FULFILL-FAIL] alert.
 *
 * Email and the webhook are best-effort inside notifyFulfillFail. Calling
 * this always logs. A missing RESEND_API_KEY or ALERT_EMAIL does not
 * change the fact that the order was rejected.
 *
 * The detail object is the order id, place names, style state, and the
 * route the Python renderer would have taken. It must not carry styleJson,
 * theme payloads, or secrets.
 */

import { notifyFulfillFail } from './alerting.js';
import type { FulfillRoute } from './detail-routing.js';

export interface StyleFailContext {
  externalId: string;
  city?: string;
  country?: string;
}

export function notifyRejectedFulfillRoute(
  route: Extract<FulfillRoute, { engine: 'rejected' }>,
  ctx: StyleFailContext,
): void {
  const detail: Record<string, string> = {
    message: route.message,
    externalId: ctx.externalId,
    styleState: route.styleState,
    formerRoute: route.reason,
  };
  if (ctx.city) detail.city = ctx.city;
  if (ctx.country) detail.country = ctx.country;
  notifyFulfillFail(ctx.externalId, route.failReason, detail);
}
