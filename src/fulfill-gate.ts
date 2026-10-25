/**
 * Decide whether /fulfill may accept a line, and which vendor product to
 * render.
 *
 * An explicit catalogue SKU (body `sku` or a single `lineItems[].sku`) is
 * routed from the table. A legacy SKU, or no SKU at all, keeps the pre-catalogue
 * path while LEGACY_SKU_PASSTHROUGH is on (the default). The flag is off only
 * when the env value is the literal string "false".
 *
 * externalId and label are never a SKU source. The studio webhook builds
 * externalId as `shopify-<id>-<sku>` and slices it to 32 characters, which
 * drops the colour suffix and can alias a white-canvas SKU onto the disabled
 * gallery row.
 *
 * This module does not call Gelato, Printful, or Shopify.
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

/**
 * Old studio forms. Hyphen: optional 2–12 letter city, then a size token
 * (inch or metric) and a finish. Underscore: MVS_CITY_* and
 * MVS_<CITY>_50x70cm_*. Design B ids (MVS-P-1824, MVS-C-1824-W) do not match.
 */
const LEGACY_HYPHEN = /^MVS-(?:[A-Z]{2,12}-)?(?:16X20|18X24|20X28|24X36|50X70|70X100|100X150)(?:CM)?-(?:SOLO|BLACK|REDOAK|CANVAS-W)$/;
const LEGACY_UNDERSCORE = /^MVS_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

export interface LineSku {
  sku?: string | null;
}

export interface GateInput {
  sku?: string | null;
  lineItems?: LineSku[] | null;
  /**
   * Accepted so existing callers can still pass it. Never read. A truncated
   * externalId must not select a catalogue row.
   */
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

export interface GateLegacy {
  ok: true;
  mode: 'legacy';
  /** Null when the request did not carry an explicit SKU. */
  sku: string | null;
}

export interface GateSuccess {
  ok: true;
  mode: 'catalogue';
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

export type GateResult = GateSuccess | GateLegacy | GateFailure;

/** Default ON. Off only for the literal env value "false" (same shape as STRICT_ROUTING_LOOKUP). */
export function isLegacyPassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEGACY_SKU_PASSTHROUGH !== 'false';
}

export function isLegacySku(sku: string): boolean {
  const normalized = sku.trim().toUpperCase();
  return LEGACY_HYPHEN.test(normalized) || LEGACY_UNDERSCORE.test(normalized);
}

export interface ExplicitSku {
  sku: string | null;
  /** Set when the request names more than one product. */
  conflict: 'multiple' | 'mismatch' | null;
}

/**
 * Authoritative SKU source: `sku`, else exactly one distinct `lineItems[].sku`.
 * Blank is absent. externalId and label are not consulted.
 */
export function extractExplicitSku(input: { sku?: string | null; lineItems?: LineSku[] | null }): ExplicitSku {
  const explicit = (input.sku ?? '').trim().toUpperCase();
  const fromLines = (Array.isArray(input.lineItems) ? input.lineItems : [])
    .map(line => (line?.sku ?? '').trim().toUpperCase())
    .filter(sku => sku.length > 0);
  const distinct = [...new Set(fromLines)];
  if (distinct.length > 1) return { sku: null, conflict: 'multiple' };
  if (explicit && distinct.length === 1 && distinct[0] !== explicit) return { sku: null, conflict: 'mismatch' };
  if (explicit) return { sku: explicit, conflict: null };
  if (distinct.length === 1) return { sku: distinct[0], conflict: null };
  return { sku: null, conflict: null };
}

function fail(httpStatus: number, reason: GateReason, sku: string | null, message: string): GateFailure {
  return { ok: false, httpStatus, reason, sku, message };
}

export function evaluateFulfillGate(input: GateInput): GateResult {
  const extracted = extractExplicitSku(input);
  if (extracted.conflict === 'multiple') {
    return fail(422, 'sku-unmapped', null, 'This /fulfill call names more than one line SKU. Send one product per call. Nothing was sent to a vendor.');
  }
  if (extracted.conflict === 'mismatch') {
    return fail(422, 'sku-unmapped', null, 'sku and lineItems[].sku disagree. Pass one SKU. Nothing was sent to a vendor.');
  }
  const sku = extracted.sku;

  let rows: ReturnType<typeof loadCatalogue> | null = null;
  let loadError: string | null = null;
  try {
    rows = loadCatalogue();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  // A real catalogue row never falls through to the legacy path, including
  // disabled optional rows (those stay 422 sku-disabled).
  if (rows && sku) {
    const row = rows.find(r => r.sku === sku);
    if (row) return evaluateCatalogueRow(row, sku, input);
  }

  if (!sku || isLegacySku(sku)) {
    if (isLegacyPassthroughEnabled()) {
      return { ok: true, mode: 'legacy', sku };
    }
    if (!rows) {
      return fail(500, 'catalogue-unavailable', sku, `Catalogue table could not be loaded: ${loadError ?? 'unknown error'}`);
    }
    return fail(
      422,
      'sku-unmapped',
      sku,
      sku
        ? `SKU ${sku} is a legacy form and LEGACY_SKU_PASSTHROUGH is false. It was not forwarded to Gelato or Printful.`
        : 'No catalogue SKU on this line and LEGACY_SKU_PASSTHROUGH is false. Pass sku (MVS-P-1824, MVS-F-1824-BK, MVS-C-1824-W, …). Nothing was sent to a vendor.',
    );
  }

  if (!rows) {
    return fail(500, 'catalogue-unavailable', sku, `Catalogue table could not be loaded: ${loadError ?? 'unknown error'}`);
  }
  return fail(
    422,
    'sku-unmapped',
    sku,
    `SKU ${sku} is not in the catalogue. It was not forwarded to Gelato or Printful.`,
  );
}

function evaluateCatalogueRow(row: ReturnType<typeof loadCatalogue>[number], sku: string, input: GateInput): GateResult {
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
    mode: 'catalogue',
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
