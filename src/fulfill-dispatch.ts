import type { Response } from 'express';
import { assertDispatchAllowed, DispatchHeldError, type DispatchContext } from './vendor-dispatch.js';

/** Check before the 202 ACK. Also alerts through the shared dispatch guard. */
export function rejectHeldFulfillment(context: DispatchContext, res: Pick<Response, 'status' | 'json'>): boolean {
  try {
    assertDispatchAllowed(context);
    return false;
  } catch (err) {
    if (!(err instanceof DispatchHeldError)) throw err;
    // No durable queue; upstream/manual re-trigger is required, even after 503.
    res.status(503).json({ ...err.result, success: false, accepted: false, externalId: context.orderId });
    return true;
  }
}
