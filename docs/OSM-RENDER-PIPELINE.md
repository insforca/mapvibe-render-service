# OSM render pipeline (Railway side)

Companion to `mapvibe-studio/docs/PREVIEW-RENDER-PIPELINE.md`. That doc covers
the studio → Vercel half of the flow; this one covers the Railway → matplotlib
half. Read both before touching the perf-sensitive parts of `mapvibe_render.py`
or `server.ts` — they're tightly coupled and getting either side wrong silently
disables the cache.

## What runs in this repo

```
POST /render                                           (server.ts)
   ↓ HMAC auth · queue admission · res.on('close') wires Vercel timeout
   ↓ renderOsmPython({ … }, signal)                    (server.ts)
   ↓ child_process.spawn('python3', ['mapvibe_render.py'])
mapvibe_render.py
   ↓ load_theme / theme_json override
   ↓ Graph cache lookup × {streets, water, parks}
   ↓   MISS — parallel Overpass fetch (3-worker pool)
   ↓   HIT  — pickle read from /tmp/mapvibe-osm-cache/
   ↓ ox.project_graph → matplotlib draw → PNG encode
   ↓ return PNG bytes to server.ts
   ↓
res.end(png)
```

## Performance ledger

What `[render]` log line confirms each layer is doing its job:

| Layer | Healthy log signal | What it costs |
|---|---|---|
| Graph cache cold | `Fetch phase 4-6s — streets=miss,water=miss,parks=miss (qdist=…)` | Real Overpass time, parallelised |
| Graph cache warm | `Fetch phase 0.1-0.3s — streets=HIT,water=HIT,parks=HIT (qdist=…)` | Disk read only |
| LRU eviction | `Graph cache LRU evicted N entries (now M MB)` | Periodic, expected |
| Render finished | `[osm] render done in Xs — N bytes (96 DPI, …)` | Matplotlib + PNG encode |
| Client gave up mid-render | `[render] Client disconnected before response — aborting OSM render` + `[osm] aborted at Xs — killing Python subprocess` | Wasted up to X seconds of Python |

**If you don't see the `Fetch phase` line on every render** the deployed
container is running pre-0024 code. Don't accept "the patch merged" as proof —
verify the line.

## Graph cache contract

The cache is byte-stupid — it pickles whatever OSMnx returns and hands it back
on a hit. Three rules keep it correct:

### 1. Quantize key AND fetch at the quantized values

```python
qlat, qlng, qdist = _graph_cache_quantize(point[0], point[1], comp_dist)
# … then fetch at qpoint=(qlat, qlng), dist=qdist — NOT at the raw values.
```

The whole point: a future request with a slightly different raw `comp_dist`
that maps to the same `qdist` bucket gets served from the cached fetch. That's
only safe if the cached fetch covered the *bucket's* radius, not the original
request's. Quantize-key-only-don't-quantize-fetch loses this guarantee.

### 2. Round comp_dist UP, never down

```python
qdist = int(((comp_dist + 999.0) // 1000.0) * 1000.0)
```

Ceiling, not nearest. A 4500 m request served from a 5000 m cached fetch is
fine (matplotlib crops); a 5500 m request served from a 5000 m fetch
under-fetches the edges of the requested area. Always over-fetch within a
bucket; never under-fetch.

### 3. Mirror the studio's quantization or invalidate the upstream cache

The studio (`api/render-and-upload.ts`, `perf/quantized-preview-dedupe`) uses
the same 4-dp lat/lng + 1-km dist buckets so its Blob-level dedupe and our
graph cache hit on the same shape of "close enough." Tightening one side
without the other creates "studio cache miss → graph cache hit" or vice
versa: worst of both worlds. If you change `_graph_cache_quantize` here,
change the studio's `Q4` / `QK` together in the same release.

## Concurrency and abort semantics

### `spawn`, NOT `spawnSync`

`spawnSync` blocks the Node event loop for the full Python runtime. Any abort
signal (Vercel-disconnects-at-60-s, queue-cancels-stale-task) can't run while
the loop is blocked. Production regression that shipped once
(`fix/abort-on-client-disconnect` PR #53/#54 introduced it, PR #55 fixed it):
we converted back to async `spawn`, and the abort signal now propagates as
SIGTERM (with a 2 s SIGKILL fallback) to the Python child.

### Listen on `res.on('close')`, NOT `req.on('close')`

`req` reaches EOF when `express.json()` consumes the body — which is *before*
the route handler runs. A `req.on('close')` listener fires microseconds after
we attach it and aborts every render at 0 s. Production regression that
shipped once; see `mapvibe-studio/docs/PREVIEW-RENDER-PIPELINE.md` for the
log signature of the failure mode.

`res.writableEnded` discriminates "normal completion" from "real disconnect"
without false positives.

### Parallel fetches release the GIL

`ox.graph_from_point` / `ox.features_from_point` end up in `requests`, which
releases the GIL during socket I/O. The 3-worker `ThreadPoolExecutor` in
`mapvibe_render.py` genuinely overlaps the three Overpass round trips — render
time becomes `max(streets, water, parks)` instead of `sum`. Do not raise
`max_workers` past 3 without changing the fetch shape; Overpass's per-IP
concurrency limits will start tarpitting individual requests and the parallel
win disappears.

## Don't-touch-without-thinking

- **`_GRAPH_CACHE_MAX_BYTES = 512 MB`** is calibrated for Railway containers
  with ~1 GB of writable `/tmp`. Going higher risks ENOSPC at upload time
  (Vercel Blob write also uses `/tmp` for buffering).
- **`_GRAPH_CACHE_TTL_S = 7 days`** trades against OSM update frequency. OSM
  base data updates daily but a city centre is insensitive to a sidewalk
  added yesterday. Don't drop below 24 h or the cache hit rate collapses;
  don't go above 30 d or you accumulate genuinely-stale street networks.
- **Cache files use `os.replace` for atomic writes.** Torn writes from an
  interrupted process leave a `.tmp` file but not a partial `.pkl`. Do not
  remove the `.tmp` suffix or atomic semantics — `graph_cache_get` would
  start returning half-written pickles that explode at unpickle time.
- **Geocode cache (`cache_get` / `cache_set`) is intentionally TTL-less.**
  City/country name lookups don't expire on any human timescale; those
  helpers are not the graph-cache ones and shouldn't be unified.

## How to verify a deploy actually shipped this

```
1. curl -fsSL https://<railway>/health        — service is up
2. Open the print preview from the studio.
3. Tail Railway logs and look for the FIRST render's lines:
     [render] Queued — size=0 pending=0 …
     Fetching streets + water + parks (parallel, cache-aware)...
     [render] Fetch phase 4-6s — streets=miss,water=miss,parks=miss (qdist=…)
     [osm] render done in Xs — N bytes (…)
4. Reopen the preview WITHOUT changing anything:
     [render] Fetch phase 0.1-0.3s — streets=HIT,water=HIT,parks=HIT (qdist=…)
     [osm] render done in 1-3s — N bytes (…)
```

If step 4 doesn't show `streets=HIT`, the cache isn't actually persisting —
likely `CACHE_DIR` is misconfigured or `/tmp` is mounted read-only on whatever
Railway image you're running. Inspect `_cache_path()` output and verify writes
are reaching disk.
