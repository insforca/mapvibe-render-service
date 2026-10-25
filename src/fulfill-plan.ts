/**
 * Turn a /fulfill body into a routing decision.
 *
 * dryRun (body.dryRun === true, or a tags field containing "mv-canary")
 * resolves the same vendor, product id, print area, centimetres, and DPI,
 * then stops. This module never calls Gelato or Printful. The only network
 * it can perform is the legacy Shopify metafield GET, and only when the
 * caller did not pass provider.
 */
import type { FulfillFailReason } from './alerting.js';
import {
  evaluateFulfillGate,
  type GateSuccess,
} from './fulfill-gate.js';
import { resolvePrintWindow, type ResolvedPrintWindow } from './print-window.js';
import { CM_PER_INCH, computeRenderDims, PRODUCTION_RENDER_CAPS } from './render-dims.js';
import {
  isStrictRoutingLookup,
  resolveGelatoRouting,
  type RoutingResult,
} from './routing.js';

export interface PlanInput {
  sku?: string | null;
  lineItems?: { sku?: string | null }[] | null;
  label?: string | null;
  dryRun?: unknown;
  tags?: unknown;
  hasPngUrl: boolean;
  hasConfigUrl: boolean;
  configDownloaded?: boolean;
  dimensionsArePrintArea?: boolean;
  callerProvider?: string | null;
  callerVariantId?: number | null;
  variantId?: number | null;
  catalogVariantId?: number | null;
  shopifyVariantId?: number | null;
  gelatoProductUid?: string | null;
  widthCm?: number | null;
  heightCm?: number | null;
  quantity?: number | null;
}

export interface DryRunRouting {
  dryRun: true;
  mode: 'catalogue' | 'legacy';
  sku: string | null;
  vendor: 'gelato' | 'printful';
  productRef: string | null;
  gelatoProductUid: string | null;
  printfulVariantId: number | null;
  printArea: { widthIn: number; heightIn: number } | null;
  widthCm: number | null;
  heightCm: number | null;
  dpi: number | null;
  widthPx: number | null;
  heightPx: number | null;
  wrapApplied: boolean;
  dimensionsArePrintArea: boolean;
}

export type FulfillPlan =
  | {
      kind: 'invalid';
      httpStatus: number;
      message: string;
      dryRun: boolean;
    }
  | {
      kind: 'reject';
      httpStatus: number;
      reason: FulfillFailReason;
      sku: string | null;
      message: string;
      dryRun: boolean;
    }
  | {
      kind: 'dry-run';
      mode: 'catalogue' | 'legacy';
      needsRender: boolean;
      body: DryRunRouting;
    }
  | {
      kind: 'accept';
      mode: 'catalogue';
      needsRender: boolean;
      gate: GateSuccess;
      printWindow: ResolvedPrintWindow;
    }
  | {
      kind: 'accept';
      mode: 'legacy';
      needsRender: boolean;
      sku: string | null;
      callerProvider: 'printful' | 'gelato';
      resolvedProvider: 'printful' | 'gelato';
      gelatoProductUid: string | null;
      printfulVariantId: number;
    };

const ORDER_ENDPOINT = /gelatoapis\.com|api\.printful\.com/i;

/** True only for boolean true, or a tags string/array that contains mv-canary. */
export function requestIsDryRun(input: { dryRun?: unknown; tags?: unknown }): boolean {
  if (input.dryRun === true) return true;
  return tagsIncludeCanary(input.tags);
}

function tagsIncludeCanary(tags: unknown): boolean {
  if (typeof tags === 'string') {
    return tags.split(/[,\s]+/).some(tag => tag === 'mv-canary');
  }
  if (Array.isArray(tags)) {
    return tags.some(tag => String(tag).trim() === 'mv-canary');
  }
  return false;
}

/** Accept plans are the only ones allowed to place a vendor order. */
export function planDispatchesVendor(plan: FulfillPlan): boolean {
  return plan.kind === 'accept';
}

export async function planFulfillment(
  input: PlanInput,
  lookup: (shopifyVariantId: number) => Promise<RoutingResult> = resolveGelatoRouting,
): Promise<FulfillPlan> {
  const dryRun = requestIsDryRun(input);
  const gate = evaluateFulfillGate({
    sku: input.sku,
    lineItems: input.lineItems,
    hasPngUrl: input.hasPngUrl,
    hasConfigUrl: input.hasConfigUrl,
    configDownloaded: input.configDownloaded,
    callerProvider: input.callerProvider,
    callerVariantId: input.callerVariantId ?? input.variantId ?? null,
  });

  if (!gate.ok) {
    return {
      kind: 'reject',
      httpStatus: gate.httpStatus,
      reason: gate.reason,
      sku: gate.sku,
      message: gate.message,
      dryRun,
    };
  }

  if (gate.mode === 'legacy') {
    return planLegacy(input, gate.sku, dryRun, lookup);
  }

  const dimensionsArePrintArea = input.dimensionsArePrintArea === true;
  const printWindow = resolvePrintWindow(gate, dimensionsArePrintArea);
  if (dryRun) {
    return {
      kind: 'dry-run',
      mode: 'catalogue',
      needsRender: gate.needsRender,
      body: {
        dryRun: true,
        mode: 'catalogue',
        sku: gate.sku,
        vendor: gate.vendor,
        productRef: gate.productRef,
        gelatoProductUid: gate.gelatoProductUid,
        printfulVariantId: gate.printfulVariantId,
        printArea: { widthIn: gate.printWIn, heightIn: gate.printHIn },
        widthCm: gate.widthCm,
        heightCm: gate.heightCm,
        dpi: gate.dims.actualDpi,
        widthPx: gate.dims.width,
        heightPx: gate.dims.height,
        wrapApplied: printWindow.wrapApplied,
        dimensionsArePrintArea,
      },
    };
  }
  return {
    kind: 'accept',
    mode: 'catalogue',
    needsRender: gate.needsRender,
    gate,
    printWindow,
  };
}

async function planLegacy(
  input: PlanInput,
  sku: string | null,
  dryRun: boolean,
  lookup: (shopifyVariantId: number) => Promise<RoutingResult>,
): Promise<FulfillPlan> {
  const variantId = input.variantId ?? null;
  const catalogVariantId = input.catalogVariantId ?? null;
  if (!variantId || !catalogVariantId || !input.label || !input.quantity) {
    return {
      kind: 'invalid',
      httpStatus: 400,
      dryRun,
      message: 'Missing required fields: externalId, recipient, variantId, catalogVariantId, label, quantity',
    };
  }
  if (!input.hasPngUrl && !input.hasConfigUrl) {
    return {
      kind: 'invalid',
      httpStatus: 400,
      dryRun,
      message: 'Either pngUrl or configUrl must be provided',
    };
  }

  const rawProvider = (input.callerProvider ?? 'printful').trim().toLowerCase();
  if (rawProvider !== 'printful' && rawProvider !== 'gelato') {
    return {
      kind: 'invalid',
      httpStatus: 400,
      dryRun,
      message: `Unknown provider '${rawProvider}'. Accepted: printful, gelato`,
    };
  }
  const callerProvider = rawProvider as 'printful' | 'gelato';
  const callerProvidedProvider = (input.callerProvider ?? '').trim() !== '';

  let resolvedProvider = callerProvider;
  let gelatoProductUid = input.gelatoProductUid ?? null;

  if (!callerProvidedProvider && input.shopifyVariantId) {
    const preflight = await lookup(input.shopifyVariantId);
    if (preflight.status === 'lookup-error' && isStrictRoutingLookup()) {
      return {
        kind: 'reject',
        httpStatus: 422,
        reason: 'routing-lookup-error',
        sku,
        dryRun,
        message: `Shopify metafield lookup failed for variant ${input.shopifyVariantId}; order rejected (422), caller will retry`,
      };
    }
    if (preflight.status === 'no-metafield' && !/canvas/i.test(input.label)) {
      return {
        kind: 'reject',
        httpStatus: 422,
        reason: 'routing-unresolved',
        sku,
        dryRun,
        message: `Variant ${input.shopifyVariantId} ("${input.label}") has no custom.pod_partner metafield; non-canvas items must be tagged gelato with a gelato_uid`,
      };
    }
    if (preflight.status === 'ok' && preflight.provider === 'gelato') {
      resolvedProvider = 'gelato';
      if (!gelatoProductUid && preflight.gelatoProductUid) gelatoProductUid = preflight.gelatoProductUid;
    } else if (preflight.status === 'ok' && preflight.provider === 'printful') {
      resolvedProvider = 'printful';
    }
  }

  if (dryRun) {
    const size = legacySize(input.widthCm, input.heightCm);
    return {
      kind: 'dry-run',
      mode: 'legacy',
      needsRender: !input.hasPngUrl,
      body: {
        dryRun: true,
        mode: 'legacy',
        sku,
        vendor: resolvedProvider,
        productRef: resolvedProvider === 'gelato' ? gelatoProductUid : String(variantId),
        gelatoProductUid: resolvedProvider === 'gelato' ? gelatoProductUid : null,
        printfulVariantId: resolvedProvider === 'printful' ? variantId : null,
        printArea: size.printArea,
        widthCm: size.widthCm,
        heightCm: size.heightCm,
        dpi: size.dpi,
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        wrapApplied: false,
        dimensionsArePrintArea: false,
      },
    };
  }

  return {
    kind: 'accept',
    mode: 'legacy',
    needsRender: !input.hasPngUrl,
    sku,
    callerProvider,
    resolvedProvider,
    gelatoProductUid: resolvedProvider === 'gelato' ? gelatoProductUid : null,
    printfulVariantId: variantId,
  };
}

function legacySize(widthCm?: number | null, heightCm?: number | null): {
  widthCm: number | null;
  heightCm: number | null;
  dpi: number | null;
  widthPx: number | null;
  heightPx: number | null;
  printArea: { widthIn: number; heightIn: number } | null;
} {
  if (widthCm == null || heightCm == null || !(widthCm > 0) || !(heightCm > 0)) {
    return { widthCm: widthCm ?? null, heightCm: heightCm ?? null, dpi: null, widthPx: null, heightPx: null, printArea: null };
  }
  const dims = computeRenderDims(widthCm, heightCm, true, PRODUCTION_RENDER_CAPS);
  return {
    widthCm,
    heightCm,
    dpi: dims.actualDpi,
    widthPx: dims.width,
    heightPx: dims.height,
    printArea: { widthIn: widthCm / CM_PER_INCH, heightIn: heightCm / CM_PER_INCH },
  };
}

/** Test helper: a URL the planner must never request. */
export function isVendorOrderUrl(url: string): boolean {
  return ORDER_ENDPOINT.test(url);
}
