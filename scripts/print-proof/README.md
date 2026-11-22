# Print proof (editor vs print), run 2026-11-22

This compares what the customer sees in the editor's preview step with the print file that the render code produces from the real order snapshot. Everything runs locally; there are no production or vendor calls.

## Setup
- **Editor:** a local build of studio `main` (`b771745`) with one line added and never committed: in `BottomBar.tsx`, `useEffect(() => { window.__mvsProofStoreConfig = storeConfig }, [storeConfig])`. It is served on `http://localhost:4173` through Playwright routes. `/api/store-config` is intercepted, so the captured body is exactly the order snapshot. `/api/tilejson` serves the OpenFreeMap TileJSON. Every other `/api` call is aborted.
- **Print:** this repo at `main` (`3ab12b9`), run with `node dist/server.js`.
  - Environment: a random local `RENDER_API_SECRET`, `FULFILL_DRY_RUN=true`, and no vendor variables.
  - **On Windows also set `PANGOCAIRO_BACKEND=fc` and a `FONTCONFIG_FILE` that points at `assets/fonts`.** Without them Pango silently falls back to a generic font. This affects Windows only; production runs on Linux.
  - The proof sends the snapshot to `/render` with the same parameters `renderConfigToBlobUrl` uses (the source and glyph patch, `printMode`, the `fadeStyle` mapping), without the Blob upload.
- `print-proof.mjs` captures the designs, `proof_analyse.py` measures framing and global difference, and `proof_lockup.py` measures the text ink inside each text box.

## Results, 8 designs
All 8 pass. Each design was also checked visually side by side.

| Check | Result | Threshold |
|---|---|---|
| Framing scale | 0.9975–1.0000 | ≤ 1% |
| Framing shift | 0.00% | ≤ 1% |
| Lockup ink top/bottom | ≤ 0.46% of poster height | ≤ 0.5% |
| Full size vs proof size (18×24 at 5400×7200) | NCC 0.9994, mean abs diff 0.2/255 | — |

The horizontal lockup deltas above 0.5% are detector noise: roads in the same colour as the text. The visual check shows identical glyphs.

## Differences found
1. **Tile source (production).** The live editor loads tiles from `api.maptiler.com`, because `/api/tilejson` uses MapTiler when a key is set. `/fulfill` rewrites the snapshot source to OpenFreeMap. Customers therefore see MapTiler data but print OpenFreeMap data. This is also the licence issue in mapvibe-context#8. `tile-hosts.mjs` records hostnames only.
2. **Credits.** The print draws "created with mapvibestudio.com" and "© OpenStreetMap contributors" in the bottom corners. The editor preview does not show them.
