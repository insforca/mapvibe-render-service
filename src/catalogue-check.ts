/**
 * Offline check of the catalogue table against a vendor-catalogue fixture.
 * Does not call Gelato or Printful.
 */
import type { CatalogueRow } from './catalogue.js';

export interface GelatoFixtureProduct {
  productUid: string;
  activated: boolean;
  isPrintable: boolean;
  widthMm: number;
  heightMm: number;
}

export interface PrintfulFixtureVariant {
  variantId: number;
  productId: number;
  inStockUs: boolean;
  printWidthIn: number;
  printHeightIn: number;
}

/** Prodigi GET /products/{sku}: physical size, print area pixels and US shipping. */
export interface ProdigiFixtureProduct {
  sku: string;
  widthIn: number;
  heightIn: number;
  printAreaPx: [number, number];
  shipsToUs: boolean;
}

export interface VendorFixture {
  gelato: GelatoFixtureProduct[];
  printful: PrintfulFixtureVariant[];
  prodigi?: ProdigiFixtureProduct[];
  rejected: { id: string; reason: string }[];
}

export interface CatalogueCheck {
  failures: string[];
  warnings: string[];
}

const MM_PER_IN = 25.4;
/** Giclée "inch" UIDs are metric-cut, about 1.6% under nominal. Above this, fail. */
const METRIC_CUT_FAIL = 0.025;
const METRIC_CUT_WARN = 0.005;

export function checkCatalogueAgainstFixture(rows: CatalogueRow[], fixture: VendorFixture): CatalogueCheck {
  const failures: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.sku)) failures.push(`${row.sku}: duplicate sku`);
    seen.add(row.sku);

    for (const rejected of fixture.rejected) {
      if (row.productRef.includes(rejected.id) || row.sku.includes(rejected.id)) {
        failures.push(`${row.sku}: product_ref matches rejected catalogue entry "${rejected.id}" (${rejected.reason})`);
      }
    }
    if (/1000x1500|100x150|frame_premium_product/.test(row.productRef)) {
      failures.push(`${row.sku}: product_ref is a known-bad Gelato UID (${row.productRef})`);
    }

    if (row.vendor === 'gelato') {
      const product = fixture.gelato.find(p => p.productUid === row.productRef);
      if (!product) {
        failures.push(`${row.sku}: Gelato UID is not in the vendor fixture`);
        continue;
      }
      if (!product.activated) failures.push(`${row.sku}: Gelato product is not activated`);
      if (!product.isPrintable) failures.push(`${row.sku}: Gelato product is not printable`);
      const dw = Math.abs(row.trimWIn * MM_PER_IN - product.widthMm) / product.widthMm;
      const dh = Math.abs(row.trimHIn * MM_PER_IN - product.heightMm) / product.heightMm;
      const delta = Math.max(dw, dh);
      if (delta > METRIC_CUT_FAIL) {
        failures.push(`${row.sku}: nominal trim is ${(delta * 100).toFixed(2)}% off the Gelato sheet`);
      } else if (delta > METRIC_CUT_WARN) {
        warnings.push(`${row.sku}: metric-cut ${(delta * 100).toFixed(2)}% under the nominal inch label (expected for giclée)`);
      }
      continue;
    }

    if (row.vendor === 'prodigi') {
      const product = (fixture.prodigi ?? []).find(p => p.sku === row.productRef);
      if (!product) {
        failures.push(`${row.sku}: Prodigi SKU ${row.productRef} is not in the vendor fixture`);
        continue;
      }
      if (!product.shipsToUs) failures.push(`${row.sku}: Prodigi SKU ${row.productRef} does not ship to the US`);
      if (Math.abs(row.trimWIn - product.widthIn) > 0.01 || Math.abs(row.trimHIn - product.heightIn) > 0.01) {
        failures.push(`${row.sku}: trim ${row.trimWIn}x${row.trimHIn} in does not match Prodigi ${product.widthIn}x${product.heightIn} in`);
      }
      // fillPrintArea scales and crops to fit. Equal aspect ratios mean it only scales.
      const [aw, ah] = product.printAreaPx;
      if (Math.abs(row.pxW / row.pxH - aw / ah) > 0.001) {
        failures.push(`${row.sku}: file ${row.pxW}x${row.pxH} px has a different aspect from the Prodigi print area ${aw}x${ah} px (would crop)`);
      }
      if (row.pxW < aw || row.pxH < ah) {
        failures.push(`${row.sku}: file ${row.pxW}x${row.pxH} px is smaller than the Prodigi print area ${aw}x${ah} px (would upscale)`);
      }
      continue;
    }

    const variantId = Number(row.productRef);
    const variant = fixture.printful.find(v => v.variantId === variantId);
    if (!variant || !Number.isInteger(variantId)) {
      failures.push(`${row.sku}: Printful variant ${row.productRef} is not in the vendor fixture`);
      continue;
    }
    if (!variant.inStockUs) failures.push(`${row.sku}: Printful variant ${variantId} is not in stock for the US`);
    if (Math.abs(row.trimWIn - variant.printWidthIn) > 0.01 || Math.abs(row.trimHIn - variant.printHeightIn) > 0.01) {
      failures.push(
        `${row.sku}: trim ${row.trimWIn}x${row.trimHIn} in does not match Printful print area ${variant.printWidthIn}x${variant.printHeightIn} in`,
      );
    }
  }

  return { failures, warnings };
}
