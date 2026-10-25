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

export interface VendorFixture {
  gelato: GelatoFixtureProduct[];
  printful: PrintfulFixtureVariant[];
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
