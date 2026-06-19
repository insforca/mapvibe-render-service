#!/usr/bin/env python3
"""
upload_pbfs_to_r2.py — One-time Geofabrik PBF seeder for Phase 2
=================================================================
Downloads all Geofabrik regional PBFs listed in python/geofabrik_regions.json
and uploads them to the mapvibe-graph-cache R2 bucket under the pbf/ prefix.

Run this LOCALLY (not on Railway) — total download is ~55 GB.
Progress is saved to upload_state.json so interrupted runs resume cleanly.

Usage:
    python scripts/upload_pbfs_to_r2.py [--priority 1] [--dry-run] [--resume]

    --priority N    Only upload regions with priority <= N (default: all)
    --dry-run       Print what would be uploaded, skip actual transfer
    --resume        Skip regions already present in R2 (default: True)
    --workers N     Parallel upload workers (default: 3)

Required env vars:
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    R2_BUCKET_NAME  (optional, default: mapvibe-graph-cache)
"""

import os
import sys
import json
import time
import hashlib
import argparse
import threading
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import boto3
    import requests
except ImportError:
    print("Missing deps. Run: pip install boto3 requests")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).parent
REPO_ROOT    = SCRIPT_DIR.parent
REGIONS_FILE = REPO_ROOT / 'python' / 'geofabrik_regions.json'
STATE_FILE   = SCRIPT_DIR / 'upload_state.json'
TMP_DIR      = Path(tempfile.gettempdir()) / 'mapvibe_pbf_upload'
TMP_DIR.mkdir(exist_ok=True)

R2_ACCOUNT_ID        = os.environ['R2_ACCOUNT_ID']
R2_ACCESS_KEY_ID     = os.environ['R2_ACCESS_KEY_ID']
R2_SECRET_ACCESS_KEY = os.environ['R2_SECRET_ACCESS_KEY']
R2_BUCKET_NAME       = os.environ.get('R2_BUCKET_NAME', 'mapvibe-graph-cache')

CHUNK_SIZE   = 16 * 1024 * 1024   # 16 MB download chunks
PART_SIZE    = 64 * 1024 * 1024   # 64 MB R2 multipart parts

_print_lock = threading.Lock()

def log(msg: str):
    with _print_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── R2 client ─────────────────────────────────────────────────────────────────
def get_r2_client():
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    )


def r2_key_exists(client, bucket: str, key: str) -> bool:
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


# ── Download + upload ─────────────────────────────────────────────────────────
def download_and_upload(region: dict, client, dry_run: bool) -> dict:
    region_key = region['region_key']
    url        = region['url']
    r2_key     = f"pbf/{region_key}.osm.pbf"
    size_mb    = region.get('size_mb', '?')

    log(f"▶  {region_key}  ({size_mb} MB)  →  {r2_key}")

    if dry_run:
        return {'region_key': region_key, 'status': 'dry_run'}

    # Download to temp file
    tmp_path = TMP_DIR / f"{region_key.replace('/', '_')}.osm.pbf"
    tmp_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        t0 = time.time()
        with requests.get(url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            total_bytes = int(resp.headers.get('content-length', 0))
            downloaded  = 0
            with open(tmp_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                    f.write(chunk)
                    downloaded += len(chunk)
            dl_secs = time.time() - t0
            dl_mb   = downloaded / 1024 / 1024
            log(f"   ↓ {region_key}: {dl_mb:.0f} MB in {dl_secs:.0f}s ({dl_mb/dl_secs:.1f} MB/s)")

        # Multipart upload to R2
        file_size = tmp_path.stat().st_size
        t1 = time.time()
        if file_size > PART_SIZE:
            # Multipart
            mpu = client.create_multipart_upload(
                Bucket=R2_BUCKET_NAME, Key=r2_key,
                ContentType='application/octet-stream',
            )
            upload_id = mpu['UploadId']
            parts = []
            part_num = 1
            with open(tmp_path, 'rb') as f:
                while True:
                    data = f.read(PART_SIZE)
                    if not data:
                        break
                    resp = client.upload_part(
                        Bucket=R2_BUCKET_NAME, Key=r2_key,
                        UploadId=upload_id, PartNumber=part_num, Body=data,
                    )
                    parts.append({'PartNumber': part_num, 'ETag': resp['ETag']})
                    part_num += 1
            client.complete_multipart_upload(
                Bucket=R2_BUCKET_NAME, Key=r2_key,
                UploadId=upload_id,
                MultipartUpload={'Parts': parts},
            )
        else:
            # Single-part
            with open(tmp_path, 'rb') as f:
                client.put_object(
                    Bucket=R2_BUCKET_NAME, Key=r2_key,
                    Body=f, ContentType='application/octet-stream',
                )
        ul_secs  = time.time() - t1
        file_mb  = file_size / 1024 / 1024
        log(f"   ↑ {region_key}: {file_mb:.0f} MB → R2 in {ul_secs:.0f}s ({file_mb/ul_secs:.1f} MB/s)")

        # Cleanup
        tmp_path.unlink(missing_ok=True)
        return {'region_key': region_key, 'status': 'ok', 'size_mb': file_mb}

    except Exception as e:
        log(f"   ✗  {region_key}: {e}")
        tmp_path.unlink(missing_ok=True)
        return {'region_key': region_key, 'status': 'error', 'error': str(e)}


# ── State persistence ─────────────────────────────────────────────────────────
def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {'completed': [], 'failed': []}


def save_state(state: dict):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Upload Geofabrik PBFs to R2')
    parser.add_argument('--priority', type=int, default=99, help='Max priority level to upload')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-resume', action='store_true', help='Re-upload even if key exists in R2')
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument(
        '--keys', nargs='+', metavar='REGION_KEY',
        help='Force-upload specific region keys regardless of R2 status (for repairs).'
             ' Example: --keys central-america/dominican-republic central-america/haiti',
    )
    args = parser.parse_args()

    regions = json.loads(REGIONS_FILE.read_text())
    regions = [r for r in regions if r.get('priority', 99) <= args.priority]
    regions.sort(key=lambda r: r.get('priority', 99))

    # --keys: restrict to specific region keys (force-upload, ignore R2 presence)
    if args.keys:
        key_set = set(args.keys)
        regions = [r for r in regions if r['region_key'] in key_set]
        missing = key_set - {r['region_key'] for r in regions}
        if missing:
            log(f"WARNING: unknown keys ignored: {missing}")
        # Force re-upload by enabling no_resume for targeted repairs
        args.no_resume = True
        log(f"Targeted repair mode: {len(regions)} region(s) → {[r['region_key'] for r in regions]}")
    log(f"Regions to process: {len(regions)} (priority <= {args.priority})")
    log(f"Total est. size: {sum(r.get('size_mb', 0) for r in regions) / 1024:.1f} GB")

    if args.dry_run:
        for r in regions:
            log(f"  [dry-run] {r['region_key']} ({r.get('size_mb')} MB)")
        return

    client = get_r2_client()
    state  = load_state()

    # Filter already completed
    todo = []
    for r in regions:
        if r['region_key'] in state['completed']:
            log(f"  ✓ skip (completed): {r['region_key']}")
            continue
        r2_key = f"pbf/{r['region_key']}.osm.pbf"
        if not args.no_resume and r2_key_exists(client, R2_BUCKET_NAME, r2_key):
            log(f"  ✓ skip (in R2): {r['region_key']}")
            state['completed'].append(r['region_key'])
            continue
        todo.append(r)

    log(f"Uploading {len(todo)} regions with {args.workers} workers...")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download_and_upload, r, client, False): r for r in todo}
        for fut in as_completed(futures):
            result = fut.result()
            if result['status'] == 'ok':
                state['completed'].append(result['region_key'])
            else:
                state['failed'].append(result)
            save_state(state)

    log(f"\nDone. {len(state['completed'])} completed, {len(state['failed'])} failed.")
    if state['failed']:
        log("Failed:")
        for f in state['failed']:
            log(f"  ✗ {f['region_key']}: {f.get('error', '?')}")


if __name__ == '__main__':
    main()
