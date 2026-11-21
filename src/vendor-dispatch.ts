/** The single dispatch boundary for ALL Gelato and Printful HTTP requests. */
export interface DispatchContext {
  vendor: 'gelato' | 'printful';
  orderId: string;
  /** Identifier only: never a label, gift message, address, or other customer data. */
  lineItem: string;
}

export interface HeldResult {
  status: 'held';
  shipped: false;
  retryable: true;
}

export class DispatchHeldError extends Error {
  readonly result: HeldResult = { status: 'held', shipped: false, retryable: true };
  constructor() {
    super('Vendor dispatch held by FULFILL_DRY_RUN');
    this.name = 'DispatchHeldError';
  }
}

export function isFulfillDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FULFILL_DRY_RUN ?? '').toLowerCase() === 'true';
}

export function warnIfDispatchHeld(): void {
  if (isFulfillDryRun()) console.warn('[WARN] FULFILL_DRY_RUN enabled: all vendor HTTP calls are held');
}

export function assertDispatchAllowed(context: DispatchContext): void {
  if (!isFulfillDryRun()) return;
  console.warn(`[DRY-RUN] held ${JSON.stringify(context)}`);
  throw new DispatchHeldError();
}

export async function vendorFetch(
  context: DispatchContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // No await between the call-time flag check and dispatch. Never cache this flag.
  assertDispatchAllowed(context);
  return fetch(url, init);
}
