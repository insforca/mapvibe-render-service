#!/usr/bin/env python3
"""Read-only catalogue validator.

Checks data/catalogue-skus.csv against fixtures/vendor-catalogue.json.
Columns match the table sku-validate.py historically read. This script
never calls Gelato or Printful. --live and --quote are refused.

Exit 0 when there are no failures. Warnings (giclée metric-cut) do not fail.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

COLUMNS = [
    'sku', 'vendor', 'product_ref', 'orientation', 'trim_w_in', 'trim_h_in',
    'px_w', 'px_h', 'price_usd', 'min_dpi', 'bleed_mm', 'ship_override',
    'in_designs', 'tier', 'size', 'finish', 'paper_or_product', 'note',
]

DESIGN_B = {
    'MVS-P-1824', 'MVS-P-2436', 'MVS-P-2840',
    'MVS-F-1824-BK', 'MVS-F-2436-BK',
    'MVS-C-1824-W', 'MVS-C-2436-W',
}

MM_PER_IN = 25.4
METRIC_CUT_FAIL = 0.025
METRIC_CUT_WARN = 0.005
BANNED = ('1000x1500', '100x150', 'frame_premium_product')


def _num(raw: str):
    raw = (raw or '').strip()
    if raw == '':
        return None
    return float(raw)


def load_rows(path: Path):
    with path.open(newline='', encoding='utf-8') as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames or []
        if list(header) != COLUMNS:
            raise SystemExit(
                f'FAIL header must be {",".join(COLUMNS)} (got {",".join(header)})'
            )
        return list(reader)


def check(rows, fixture, design: str):
    failures = []
    warnings = []
    gelato = {p['productUid']: p for p in fixture.get('gelato', [])}
    printful = {int(v['variantId']): v for v in fixture.get('printful', [])}
    rejected = fixture.get('rejected', [])
    seen = set()
    enabled = []

    for row in rows:
        sku = (row.get('sku') or '').strip()
        if not sku:
            failures.append('blank sku')
            continue
        if sku in seen:
            failures.append(f'{sku}: duplicate sku')
        seen.add(sku)
        vendor = (row.get('vendor') or '').strip().lower()
        ref = (row.get('product_ref') or '').strip()
        designs = [d.strip().upper() for d in (row.get('in_designs') or '').split('|') if d.strip()]
        if design in designs:
            enabled.append(sku)
        if vendor not in ('gelato', 'printful'):
            failures.append(f'{sku}: unknown vendor {vendor}')
            continue
        if not ref:
            failures.append(f'{sku}: empty product_ref')
            continue
        for bad in BANNED:
            if bad in ref or bad in sku:
                failures.append(f'{sku}: banned token {bad}')
        for item in rejected:
            token = str(item.get('id', ''))
            if token and (token in ref or token in sku):
                failures.append(f'{sku}: rejected {token} ({item.get("reason", "")})')
        try:
            trim_w = float(row['trim_w_in'])
            trim_h = float(row['trim_h_in'])
        except (TypeError, ValueError, KeyError):
            failures.append(f'{sku}: trim size is not numeric')
            continue
        if vendor == 'gelato':
            product = gelato.get(ref)
            if product is None:
                failures.append(f'{sku}: Gelato UID not in fixture')
                continue
            if not product.get('activated'):
                failures.append(f'{sku}: Gelato product is not activated')
            if not product.get('isPrintable'):
                failures.append(f'{sku}: Gelato product is not printable')
            dw = abs(trim_w * MM_PER_IN - product['widthMm']) / product['widthMm']
            dh = abs(trim_h * MM_PER_IN - product['heightMm']) / product['heightMm']
            delta = max(dw, dh)
            if delta > METRIC_CUT_FAIL:
                failures.append(f'{sku}: nominal trim is {delta * 100:.2f}% off the Gelato sheet')
            elif delta > METRIC_CUT_WARN:
                warnings.append(
                    f'{sku}: metric-cut {delta * 100:.2f}% under the nominal inch label'
                )
        else:
            try:
                variant_id = int(ref)
            except ValueError:
                failures.append(f'{sku}: Printful product_ref is not an integer')
                continue
            variant = printful.get(variant_id)
            if variant is None:
                failures.append(f'{sku}: Printful variant {variant_id} not in fixture')
                continue
            if not variant.get('inStockUs'):
                failures.append(f'{sku}: Printful variant {variant_id} is not in US stock')
            if abs(trim_w - float(variant['printWidthIn'])) > 0.01 or abs(trim_h - float(variant['printHeightIn'])) > 0.01:
                failures.append(
                    f'{sku}: trim {trim_w}x{trim_h} != print area '
                    f'{variant["printWidthIn"]}x{variant["printHeightIn"]}'
                )
        # Bleed column is required to exist. Posters carry 0. Canvas/frames may be blank.
        if 'bleed_mm' not in row:
            failures.append(f'{sku}: missing bleed_mm column')

    if design == 'B' and set(enabled) != DESIGN_B:
        failures.append(
            f'design B enabled set is {sorted(enabled)}, expected {sorted(DESIGN_B)}'
        )
    return failures, warnings, enabled


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Offline catalogue validator (no vendor calls).')
    parser.add_argument('--csv', type=Path, default=None)
    parser.add_argument('--fixture', type=Path, default=None)
    parser.add_argument('--design', default='B')
    parser.add_argument('--live', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--quote', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.live or args.quote:
        sys.stderr.write(
            'refusing live vendor calls; this validator is offline-only '
            '(no Gelato or Printful requests).\n'
        )
        return 2

    root = Path(__file__).resolve().parents[1]
    csv_path = args.csv or (root / 'data' / 'catalogue-skus.csv')
    fixture_path = args.fixture or (root / 'fixtures' / 'vendor-catalogue.json')
    rows = load_rows(csv_path)
    fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
    design = args.design.strip().upper() or 'B'
    failures, warnings, enabled = check(rows, fixture, design)
    print(f'{len(rows)} SKUs, design {design}: {len(enabled)} enabled, {len(failures)} FAIL, {len(warnings)} WARN')
    for w in warnings:
        print(f'WARN {w}')
    for f in failures:
        print(f'FAIL {f}')
    if failures:
        return 1
    print('PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
