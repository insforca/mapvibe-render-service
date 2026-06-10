/**
 * src/request-id.ts
 *
 * Per-request correlation ID. Reads `x-request-id` header if the caller
 * sent one (the editor's shopify-order-webhook can do this when it dispatches
 * fulfillment so order/SKU joins are easy), otherwise mints a fresh UUID.
 *
 * The ID lands in `res.locals.requestId` and is echoed in the response
 * `x-request-id` header so callers can also see what was used.
 *
 * Use `getRequestId(res)` to read it; concatenate into log strings so the
 * existing `[fulfill/*]` tag style still works without converting every
 * call site to a logger wrapper. Example:
 *
 *   console.error(`[${getRequestId(res)}] [fulfill] Render error:`, err);
 *
 * Inside the async IIFE that runs after the 202 ACK, capture the value
 * once at the top of the closure so it survives the response object going
 * out of scope.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const MAX_INCOMING_LEN = 64;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = (req.headers['x-request-id'] as string | undefined)?.slice(0, MAX_INCOMING_LEN);
  const id = (incoming && SAFE_ID_RE.test(incoming)) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

export function getRequestId(res: Response): string {
  return (res.locals.requestId as string | undefined) ?? '';
}
