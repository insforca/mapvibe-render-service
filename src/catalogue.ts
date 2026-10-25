/**
 * Runtime catalogue: SKU → vendor → product UID / Printful variant → print
 * area. Loaded from data/catalogue-skus.csv (the columns sku-validate.py
 * reads). Design B is on by default. Optional premium rows stay in the file
 * and are routed only when CATALOGUE_ENABLE_OPTIONAL=true.
 *
 * This module does not call Gelato or Printful.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CM_PER_INCH } from './render-dims.js';

export const CATALOGUE_COLUMNS = [
  'sku',
  'vendor',
  'product_ref',
  'orientation',
  'trim_w_in',
  'trim_h_in',
  'px_w',
  'px_h',
  'price_usd',
  'min_dpi',
  'bleed_mm',
  'ship_override',
  'in_designs',
  'tier',
  'size',
  'finish',
  'paper_or_product',
  'note',
] as const;

export interface CatalogueRow {
  sku: string;
  vendor: 'gelato' | 'printful';
  productRef: string;
  orientation: string;
  trimWIn: number;
  trimHIn: number;
  pxW: number;
  pxH: number;
  priceUsd: number;
  minDpi: number | null;
  bleedMm: number | null;
  shipOverrideUsd: number | null;
  inDesigns: string[];
  tier: string;
  size: string;
  finish: string;
  paperOrProduct: string;
  note: string;
}

export interface RenderTarget {
  widthCm: number;
  heightCm: number;
  printWIn: number;
  printHIn: number;
  visibleWIn: number;
  visibleHIn: number;
  visibleFractionW: number;
  visibleFractionH: number;
  /** Print file is larger than the visible product (canvas wrap / frame lip). */
  hasWrap: boolean;
  /** Inches of extra print beyond the visible product, per side. Null when there is no wrap. */
  wrapBleedIn: number | null;
  source: 'gelato-700x1000mm' | 'trim-inches';
}

let cached: CatalogueRow[] | null = null;

export function _resetCatalogueCacheForTests(): void {
  cached = null;
}

export function defaultCataloguePath(): string {
  return join(__dirname, '..', 'data', 'catalogue-skus.csv');
}

/** RFC 4180-ish parser. Quoted fields may contain commas and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function numOrNull(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`catalogue: expected a number, got "${raw}"`);
  }
  return n;
}

function requireNum(raw: string, field: string, sku: string): number {
  const n = numOrNull(raw);
  if (n === null) throw new Error(`catalogue: ${sku} is missing ${field}`);
  return n;
}

export function parseCatalogueCsv(text: string): CatalogueRow[] {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('catalogue: CSV has no data rows');
  const header = table[0].map(h => h.trim());
  const expected = [...CATALOGUE_COLUMNS];
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    throw new Error(`catalogue: header must be ${expected.join(',')} (got ${header.join(',')})`);
  }
  const seen = new Set<string>();
  const rows: CatalogueRow[] = [];
  for (const cells of table.slice(1)) {
    if (cells.length !== expected.length) {
      throw new Error(`catalogue: row has ${cells.length} columns, expected ${expected.length}: ${cells[0] ?? ''}`);
    }
    const get = (name: typeof CATALOGUE_COLUMNS[number]) => cells[expected.indexOf(name)] ?? '';
    const sku = get('sku').trim();
    if (!sku) throw new Error('catalogue: blank sku');
    if (seen.has(sku)) throw new Error(`catalogue: duplicate sku ${sku}`);
    seen.add(sku);
    const vendor = get('vendor').trim().toLowerCase();
    if (vendor !== 'gelato' && vendor !== 'printful') {
      throw new Error(`catalogue: ${sku} has unknown vendor "${vendor}"`);
    }
    const productRef = get('product_ref').trim();
    if (!productRef) throw new Error(`catalogue: ${sku} has an empty product_ref`);
    rows.push({
      sku,
      vendor,
      productRef,
      orientation: get('orientation').trim(),
      trimWIn: requireNum(get('trim_w_in'), 'trim_w_in', sku),
      trimHIn: requireNum(get('trim_h_in'), 'trim_h_in', sku),
      pxW: requireNum(get('px_w'), 'px_w', sku),
      pxH: requireNum(get('px_h'), 'px_h', sku),
      priceUsd: requireNum(get('price_usd'), 'price_usd', sku),
      minDpi: numOrNull(get('min_dpi')),
      bleedMm: numOrNull(get('bleed_mm')),
      shipOverrideUsd: numOrNull(get('ship_override')),
      inDesigns: get('in_designs').split('|').map(s => s.trim().toUpperCase()).filter(Boolean),
      tier: get('tier').trim(),
      size: get('size').trim(),
      finish: get('finish').trim(),
      paperOrProduct: get('paper_or_product').trim(),
      note: get('note').trim(),
    });
  }
  return rows;
}

export function loadCatalogue(path: string = defaultCataloguePath()): CatalogueRow[] {
  if (cached && path === defaultCataloguePath()) return cached;
  const rows = parseCatalogueCsv(readFileSync(path, 'utf8'));
  if (path === defaultCataloguePath()) cached = rows;
  return rows;
}

/**
 * Design B is the live set. CATALOGUE_ENABLE_OPTIONAL=true also routes the
 * premium rows that are in the table but not in design B (16×20 poster,
 * natural-oak frames, gallery canvas including 30×40).
 */
export function isRowEnabled(row: CatalogueRow, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CATALOGUE_ENABLE_OPTIONAL ?? '').trim().toLowerCase() === 'true') return true;
  const design = (env.CATALOGUE_DESIGN ?? 'B').trim().toUpperCase() || 'B';
  return row.inDesigns.includes(design);
}

function parseSizeLabel(size: string): { w: number; h: number } | null {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(size.trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Physical file the renderer must produce.
 *
 * 28×40 giclée is the Gelato 700×1000 mm product. That is the existing
 * 70×100 cm single-pass size (~365 DPI, 10059×14370). Nominal 28×40 in
 * would be a different pixel grid (10080×14400 at 360 DPI) for a sheet
 * the product is not cut to.
 *
 * Canvas trim columns are the Printful print area (21×27, 27×39, …), which
 * is larger than the visible size in the `size` column. The visible window
 * stays centred; the margin is wrap.
 */
export function renderTargetForRow(row: CatalogueRow): RenderTarget {
  if (row.productRef.includes('700x1000-mm')) {
    const printWIn = 70 / CM_PER_INCH;
    const printHIn = 100 / CM_PER_INCH;
    return {
      widthCm: 70,
      heightCm: 100,
      printWIn,
      printHIn,
      visibleWIn: printWIn,
      visibleHIn: printHIn,
      visibleFractionW: 1,
      visibleFractionH: 1,
      hasWrap: false,
      wrapBleedIn: null,
      source: 'gelato-700x1000mm',
    };
  }
  const nominal = parseSizeLabel(row.size);
  const printWIn = row.trimWIn;
  const printHIn = row.trimHIn;
  const visibleWIn = nominal?.w ?? printWIn;
  const visibleHIn = nominal?.h ?? printHIn;
  const hasWrap = printWIn - visibleWIn > 0.05 || printHIn - visibleHIn > 0.05;
  const visibleFractionW = hasWrap ? visibleWIn / printWIn : 1;
  const visibleFractionH = hasWrap ? visibleHIn / printHIn : 1;
  const wrapBleedIn = hasWrap
    ? Math.min(printWIn - visibleWIn, printHIn - visibleHIn) / 2
    : null;
  return {
    widthCm: printWIn * CM_PER_INCH,
    heightCm: printHIn * CM_PER_INCH,
    printWIn,
    printHIn,
    visibleWIn,
    visibleHIn,
    visibleFractionW,
    visibleFractionH,
    hasWrap,
    wrapBleedIn,
    source: 'trim-inches',
  };
}
