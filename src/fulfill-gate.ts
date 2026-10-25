/**
 * Decide whether /fulfill may accept a line, and which vendor product to
 * render. The catalogue table is the only source of vendor, product UID /
 * variant id, and print size. Unknown SKUs and disabled rows fail before
 * any vendor call. This module does not call Gelato, Printful, or Shopify.
 */
import { computeRenderDims, PRODUCTION_RENDER_CAPS, type RenderDims } from './render-dims.js';
import {
  isRowEnabled,
  loadCatalogue,
  renderTargetForRow,
  _resetCatalogueCacheForTests,
  type RenderTarget,
} from './catalogue.js';

export { _resetCatalogueCacheForTests };

export type GateReason =
  | 'sku-unmapped'
  | 'sku-disabled'
  | 'sku-unrenderable'
  | 'config-render'
  | 'catalogue-unavailable';

const SKU_IN_TEXT = /MVS-[PFC]-\d{4}(?:-(?:BK|NT|W))?/;

export interface GateInput {
  sku?: string | null;
  externalId?: string | null;
  label?: string | null;
  hasPngUrl: boolean;
  hasConfigUrl: boolean;
  /**
   * undefined — config download has not been attempted.
   * true / false — attempted, and the snapshot was or was not readable.
   * A failed download is a non-2xx only when this line must render.
   */
  configDownloaded?: boolean;
  callerProvider?: string | null;
  callerVariantId?: number | null;
}

export interface GateFailure {
  ok: false;
  httpStatus: number;
  reason: GateReason;
  sku: string | null;
  message: string;
}

export interface GateSuccess {
  ok: true;
  sku: string;
  vendor: 'gelato' | 'printful';
  productRef: string;
  gelatoProductUid: string | null;
  printfulVariantId: number | null;
  widthCm: number;
  heightCm: number;
  printWIn: number;
  printHIn: number;
  visibleWIn: number;
  visibleHIn: number;
  visibleFractionW: number;
  visibleFractionH: number;
  hasWrap: boolean;
  wrapBleedIn: number | null;
  bleedMm: number | null;
  needsRender: boolean;
  callerProviderIgnored: boolean;
  callerVariantIgnored: boolean;
  dims: RenderDims;
  target: RenderTarget;
}

export type GateResult = GateSuccess | GateFailure;

export function extractSku(input: Pick<GateInput, 'sku' | 'externalId' | 'label'>): string | null {
  const explicit = (input.sku ?? '').trim().toUpperCase();
  if (explicit) return explicit;
  const blob = `${input.externalId ?? ''} ${input.label ?? ''}`.toUpperCase();
  return blob.match(SKU_IN_TEXT)?.[0] ?? null;
}

function fail(httpStatus: number, reason: GateReason, sku: string | null, message: string): GateFailure {
  return { ok: false, httpStatus, reason, sku, message };
}

export function evaluateFulfillGate(input: GateInput): GateResult {
  let rows;
  try {
    rows = loadCatalogue();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(500, 'catalogue-unavailable', null, `Catalogue table could not be loaded: ${detail}`);
  }

  const sku = extractSku(input);
  if (!sku) {
    return fail(
      422,
      'sku-unmapped',
      null,
      'No catalogue SKU on this line. Pass sku (MVS-P-1824, MVS-F-1824-BK, MVS-C-1824-W, …). Unmapped lines are not sent to a vendor.',
    );
  }
  const row = rows.find(r => r.sku === sku);
  if (!row) {
    return fail(
      422,
      'sku-unmapped',
      sku,
      `SKU ${sku} is not in the catalogue. It was not forwarded to Gelato or Printful. Shopify should retry only after the SKU is a catalogue row.`,
    );
  }
  if (!isRowEnabled(row)) {
    return fail(
      422,
      'sku-disabled',
      sku,
      `SKU ${sku} is in the catalogue but disabled (not in design ${process.env.CATALOGUE_DESIGN ?? 'B'}; set CATALOGUE_ENABLE_OPTIONAL=true to route optional premium rows). Not forwarded to a vendor.`,
    );
  }

  const target = renderTargetForRow(row);
  const dims = computeRenderDims(target.widthCm, target.heightCm, true, PRODUCTION_RENDER_CAPS);
  if (dims.mode !== 'single-pass' || dims.actualDpi < PRODUCTION_RENDER_CAPS.minSinglePassDpi) {
    return fail(
      422,
      'sku-unrenderable',
      sku,
      `SKU ${sku} would render as ${dims.mode} at ${dims.actualDpi} DPI (${dims.width}×${dims.height}). Only single-pass at ≥ ${PRODUCTION_RENDER_CAPS.minSinglePassDpi} DPI is supported.`,
    );
  }

  const needsRender = target.hasWrap || !input.hasPngUrl;
  if (target.hasWrap && !input.hasConfigUrl) {
    return fail(
      422,
      'sku-unrenderable',
      sku,
      `SKU ${sku} prints at ${target.printWIn}×${target.printHIn} in (visible ${target.visibleWIn}×${target.visibleHIn} in). A pre-rendered PNG is the wrong aspect. Pass configUrl so fulfillment can render the print area.`,
    );
  }
  if (needsRender && !input.hasConfigUrl) {
    return fail(
      422,
      'sku-unrenderable',
      sku,
      `SKU ${sku} has no pngUrl and no configUrl, so there is nothing to print.`,
    );
  }
  if (needsRender && input.configDownloaded === false) {
    return fail(
      502,
      'config-render',
      sku,
      `Config snapshot for ${sku} could not be downloaded. The line was not acknowledged and no vendor order was created.`,
    );
  }

  const callerProvider = (input.callerProvider ?? '').trim().toLowerCase();
  const callerProviderIgnored = callerProvider !== '' && callerProvider !== row.vendor;
  const catalogueVariant = row.vendor === 'printful' ? Number(row.productRef) : null;
  const callerVariantIgnored = input.callerVariantId != null
    && (catalogueVariant == null || input.callerVariantId !== catalogueVariant);

  return {
    ok: true,
    sku,
    vendor: row.vendor,
    productRef: row.productRef,
    gelatoProductUid: row.vendor === 'gelato' ? row.productRef : null,
    printfulVariantId: catalogueVariant,
    widthCm: target.widthCm,
    heightCm: target.heightCm,
    printWIn: target.printWIn,
    printHIn: target.printHIn,
    visibleWIn: target.visibleWIn,
    visibleHIn: target.visibleHIn,
    visibleFractionW: target.visibleFractionW,
    visibleFractionH: target.visibleFractionH,
    hasWrap: target.hasWrap,
    wrapBleedIn: target.wrapBleedIn,
    bleedMm: row.bleedMm,
    needsRender,
    callerProviderIgnored,
    callerVariantIgnored,
    dims,
    target,
  };
}
