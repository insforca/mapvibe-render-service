import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeRenderDims, PRODUCTION_RENDER_CAPS } from '../render-dims.js';
import {
  CATALOGUE_COLUMNS,
  parseCatalogueCsv,
  loadCatalogue,
  _resetCatalogueCacheForTests,
  isRowEnabled,
  renderTargetForRow,
} from '../catalogue.js';
import { checkCatalogueAgainstFixture, type VendorFixture } from '../catalogue-check.js';
import { expandProjectedWindow } from '../print-window.js';

const ROOT = join(__dirname, '..', '..');
const CSV_PATH = join(ROOT, 'data', 'catalogue-skus.csv');
const FIXTURE_PATH = join(ROOT, 'fixtures', 'vendor-catalogue.json');

const DESIGN_B = [
  'MVS-P-1824',
  'MVS-P-2436',
  'MVS-P-2840',
  'MVS-F-1824-BK',
  'MVS-F-2436-BK',
  'MVS-C-1824-W',
  'MVS-C-2436-W',
];

const OPTIONAL = [
  'MVS-P-1620',
  'MVS-F-1824-NT',
  'MVS-F-2436-NT',
  'MVS-C-1824',
  'MVS-C-3040',
];

beforeEach(() => {
  _resetCatalogueCacheForTests();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('catalogue table', () => {
  it('loads the CSV with the sku-validate columns, one row per researched SKU', () => {
    const text = readFileSync(CSV_PATH, 'utf8');
    const header = text.split(/\r?\n/)[0].split(',');
    expect(header).toEqual([...CATALOGUE_COLUMNS]);

    const rows = loadCatalogue();
    expect(rows.map(r => r.sku)).toEqual([
      'MVS-P-1620', 'MVS-P-1824', 'MVS-P-2436', 'MVS-P-2840',
      'MVS-F-1824-BK', 'MVS-F-2436-BK', 'MVS-F-1824-NT', 'MVS-F-2436-NT',
      'MVS-C-1824-W', 'MVS-C-2436-W', 'MVS-C-1824', 'MVS-C-3040',
    ]);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map(r => r.sku)).size).toBe(12);
    expect(rows.map(r => r.sku).sort()).toEqual([...DESIGN_B, ...OPTIONAL].sort());
  });

  it('parses quoted commas and keeps bleed empty as null, zero as 0', () => {
    const csv = [
      CATALOGUE_COLUMNS.join(','),
      'MVS-P-1824,gelato,uid,ver,18,24,7200,9600,49.99,300,0,,A|B|C,Poster,18x24,Poster,paper,"note, with comma"',
      'MVS-F-1824-BK,printful,3,ver,18,24,7200,9600,129.99,,,13.99,A|B|C,Premium,18x24,Framed - Black,"Enhanced matte poster, black wood frame",',
    ].join('\n');
    const rows = parseCatalogueCsv(csv);
    expect(rows[0].note).toBe('note, with comma');
    expect(rows[0].bleedMm).toBe(0);
    expect(rows[1].bleedMm).toBeNull();
    expect(rows[1].minDpi).toBeNull();
    expect(rows[1].shipOverrideUsd).toBe(13.99);
    expect(rows[1].paperOrProduct).toBe('Enhanced matte poster, black wood frame');
    expect(rows[0].inDesigns).toEqual(['A', 'B', 'C']);
  });

  it('enables Design B by default and keeps optional premium rows disabled until the flag is set', () => {
    const rows = loadCatalogue();
    const enabled = rows.filter(r => isRowEnabled(r)).map(r => r.sku).sort();
    expect(enabled).toEqual([...DESIGN_B].sort());
    for (const sku of OPTIONAL) {
      const row = rows.find(r => r.sku === sku)!;
      expect(isRowEnabled(row)).toBe(false);
    }

    vi.stubEnv('CATALOGUE_ENABLE_OPTIONAL', 'true');
    expect(rows.filter(r => isRowEnabled(r))).toHaveLength(12);
    vi.stubEnv('CATALOGUE_ENABLE_OPTIONAL', 'false');
    expect(rows.filter(r => isRowEnabled(r)).map(r => r.sku).sort()).toEqual([...DESIGN_B].sort());
  });

  it('maps 28x40 onto the 70x100 cm product and canvas rows onto their print areas', () => {
    const rows = loadCatalogue();
    const bySku = Object.fromEntries(rows.map(r => [r.sku, r]));

    const poster2840 = renderTargetForRow(bySku['MVS-P-2840']);
    expect(poster2840.widthCm).toBe(70);
    expect(poster2840.heightCm).toBe(100);
    expect(poster2840.hasWrap).toBe(false);

    const canvas1824 = renderTargetForRow(bySku['MVS-C-1824-W']);
    expect(canvas1824.printWIn).toBe(21);
    expect(canvas1824.printHIn).toBe(27);
    expect(canvas1824.visibleWIn).toBe(18);
    expect(canvas1824.visibleHIn).toBe(24);
    expect(canvas1824.hasWrap).toBe(true);
    expect(canvas1824.visibleFractionW).toBeCloseTo(18 / 21, 6);
    expect(canvas1824.visibleFractionH).toBeCloseTo(24 / 27, 6);

    const canvas2436 = renderTargetForRow(bySku['MVS-C-2436-W']);
    expect(canvas2436.printWIn).toBe(27);
    expect(canvas2436.printHIn).toBe(39);
    expect(canvas2436.visibleWIn).toBe(24);
    expect(canvas2436.visibleHIn).toBe(36);
    expect(canvas2436.hasWrap).toBe(true);

    const framed = renderTargetForRow(bySku['MVS-F-2436-BK']);
    expect(framed.hasWrap).toBe(false);
    expect(framed.printWIn).toBe(24);
    expect(framed.printHIn).toBe(36);
  });

  it('every row renders single-pass at the table pixel size and at least 300 DPI', () => {
    for (const row of loadCatalogue()) {
      const target = renderTargetForRow(row);
      const dims = computeRenderDims(target.widthCm, target.heightCm, true, PRODUCTION_RENDER_CAPS);
      expect(dims.mode, row.sku).toBe('single-pass');
      expect(dims.numTiles, row.sku).toBe(1);
      expect(dims.actualDpi, row.sku).toBeGreaterThanOrEqual(300);
      expect(dims.width, row.sku).toBe(row.pxW);
      expect(dims.height, row.sku).toBe(row.pxH);
    }
  });

  it('does not list 100x150, metric legacy sizes, or blank-frame UIDs', () => {
    const blob = readFileSync(CSV_PATH, 'utf8');
    expect(blob).not.toMatch(/100x150|1000x1500|frame_premium_product|MVS_CITY|16x20-SOLO/);
    const skus = loadCatalogue().map(r => r.sku);
    expect(skus.some(s => /50x70|100x150|MVS_CITY|16x20-SOLO/.test(s))).toBe(false);
  });
});

describe('catalogue fixture check', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as VendorFixture;

  it('accepts the shipped table against the offline vendor fixture', () => {
    const result = checkCatalogueAgainstFixture(loadCatalogue(), fixture);
    expect(result.failures).toEqual([]);
    // Giclée inch labels are metric-cut (~1.6% small). That is a warning, not a failure.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every(w => /metric-cut|1\./.test(w))).toBe(true);
  });

  it('fails when a row points at a rejected or unknown product', () => {
    const rows = loadCatalogue();
    const bad = rows.map(r => r.sku === 'MVS-P-1824'
      ? { ...r, productRef: 'flat_product_pf_1000x1500-mm_deactivated' }
      : r);
    const result = checkCatalogueAgainstFixture(bad, fixture);
    expect(result.failures.some(f => /1000x1500|rejected/.test(f))).toBe(true);
  });

  it('fails when a Printful trim does not match the fixture print area', () => {
    const rows = loadCatalogue().map(r => r.sku === 'MVS-C-1824-W'
      ? { ...r, trimWIn: 18, trimHIn: 24 }
      : r);
    const result = checkCatalogueAgainstFixture(rows, fixture);
    expect(result.failures.some(f => /MVS-C-1824-W/.test(f))).toBe(true);
  });
});

describe('print window', () => {
  it('expands a visible 18x24 box so it sits centred in a 21x27 sheet', () => {
    const out = expandProjectedWindow(0, 18, 0, 24, 21, 27, 18, 24);
    expect(out.x0).toBeCloseTo(-1.5, 6);
    expect(out.x1).toBeCloseTo(19.5, 6);
    expect(out.y0).toBeCloseTo(-1.5, 6);
    expect(out.y1).toBeCloseTo(25.5, 6);
    expect((out.x1 - out.x0) / (out.y1 - out.y0)).toBeCloseTo(21 / 27, 6);
  });

  it('leaves the box alone when there is no wrap', () => {
    const out = expandProjectedWindow(0, 18, 0, 24, 18, 24, 18, 24);
    expect(out).toEqual({ x0: 0, x1: 18, y0: 0, y1: 24 });
  });

  it('python helper matches the TypeScript expansion and never places an order', () => {
    const script = join(ROOT, 'python', 'print_window.py');
    const run = spawnSync('python3', [script, '--self-test'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('ok');
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(/printful\.com|gelatoapis\.com|api\.printful/);
  });
});

describe('sku-validate.py', () => {
  const script = join(ROOT, 'scripts', 'sku-validate.py');

  it('passes offline against the shipped table and fixture', () => {
    const run = spawnSync('python3', [script, '--csv', CSV_PATH, '--fixture', FIXTURE_PATH], { encoding: 'utf8' });
    expect(run.stdout + run.stderr).toMatch(/FAIL|WARN|PASS|ok|SKU/i);
    expect(run.status).toBe(0);
  });

  it('refuses a live vendor call', () => {
    const run = spawnSync('python3', [script, '--live'], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toMatch(/offline|live|refus/i);
  });
});
