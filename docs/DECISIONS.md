# Decisions

Keep this file updated in every pull request that changes behaviour. The owner (Ivan) approves merges.

Dated log of Ivan's decisions. Newest first. One entry per decision. A "why" is included only when he gave one. Nothing in this file was inferred from the code. If a later change disagrees with an entry, add a `check:` note and do not rewrite the decision to match the code.

## 2026-11-09

**Print standards.** Single-pass at 300 DPI or higher, 400 DPI target, max edge 14,400 px, 150 million px. SKUs below that are refused.

Sizes:

- 18×24 at 400 DPI (7200×9600)
- 24×36 at 400 DPI (9600×14400)
- 28×40 as Gelato 70×100 cm at 365 DPI (10059×14370)
- A0 as ISO 841×1189 mm at 307 DPI (10165×14371)
- White canvas 18×24, print area 21×27, at 400 DPI (8400×10800)
- White canvas 24×36, print area 27×39, at 369 DPI (9963×14391)

**Maps without a usable style fail loudly and are not printed.** `/fulfill` sends a Resend email alert. The Python/OSM renderer no longer prints maps. `/render` returns 400 for a missing style or `engine=osm`. `/preview` and `/warm` return 410. (PR #98.)

**Print PNGs are 8-bit RGB** with a pHYs DPI tag and the official ICC sRGB2014 profile embedded (3024 bytes, SHA-256 `384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a`), vendored in `assets/color`. A missing or invalid profile fails startup. (PR #99.)

Why: this is not the v4 preference profile, because that profile shifted saturated colours.

## 2026-11-07

**Clean print must match the editor** on road thickness, zoom, and fades. **Detailed must match the editor** on roads, contours, rivers, buildings, and colours. Print text uses Roboto, like the editor. (PRs #93–#97.)

## 2026-10-31

**The product is size × finish options.** Any city or area on earth is a potential product via the editor. Shopify city products are only entry points.

**Design B shared variants.** 18×24 and 24×36 posters and frames, 28×40, A0 poster (Gelato giclée 33×47 in, SKU `MVS-P-A0`, about $119.99), white framed canvas 18×24 and 24×36 (Printful), black and brown (Gelato dark-wood) frames at the same price ($129.99 / $219.99). 28×40 stays alongside A0. The 727 metric variants were deleted. 100×150 cm was deactivated at Gelato.

**Store and agent copy must not mention** Canada, 16×20, 20×28, metric sizes, or "from $34.99".

**Direct purchases by AI agents of variants without the editor are temporarily disabled.** This is a recommendation, not a permanent rule.

Why: such orders can be paid with no map design and get rejected by the webhook. Re-enable once the webhook can email the customer a link to design the map.

**Editor, first step.** The first editor step shows the maximum map area (full width within layout limits) with no product frame. The frame with the final product proportions appears only after size and finish selection. The editor lives in the mapvibe-studio repo, not here.

## 2026-10-25

**The Amazon framing affiliate link is also used for the oversized premium tier**, which has no vendor frames.

Why: buyers of the oversized sizes will likely want to frame them, so Ivan expects the best affiliate commission there.

Note: the Amazon affiliate needs three sales by about 2026-12-02, otherwise a new code is needed.

## 2026-10-24

**Simple catalogue.** Standard US sizes plus a few oversized/premium options, priced near the market.

Why: easy selling and print quality come before margin. A 50% net margin is not a hard rule, only a sensible minimum margin per option.

**No budget for physical print samples.** Quality is proven from file facts.

## Recorded without a date

**Railway (this service).** `USE_PMTILES=true`, 7 GB / 2 vCPU memory limit, `MAX_CONCURRENT=2`, Wait for CI on. Fulfilment is live (`FULFILL_DRY_RUN=false`, `PRINTFUL_AUTO_CONFIRM=true`).

check: this repo does not read `USE_PMTILES`. The README says leaving it set is harmless. MapLibre prints from OpenFreeMap tiles (`tiles.openfreemap.org`).

check: `src/server.ts` defaults `MAX_CONCURRENT` to 4 when the variable is unset. The value 2 is Ivan's Railway setting and is not stored in this repo.

check: `railway.json` does not set memory or CPU. 7 GB / 2 vCPU is the claimed Railway plan only.

**Working rules.**

- Pull requests are opened and not merged. Merge only after Ivan says yes. Nothing goes live without his go. Always note a rollback point.
- Tests never call `/fulfill`, webhooks, Gelato, Printful, or Shopify order routes. Render verification is image-only (`POST /render` and `/health`). Never print secrets.

## Editor

The editor is the mapvibe-studio repo, based on Terraink (https://github.com/yousifamanuel/terraink). Poster text there uses Roboto. Orders send the full `map.getStyle()` (the MapLibre style) with the snapshot. The dated editor decision is the 2026-10-31 entry above.

## Still open

Not decided:

- Identical SKUs across cities
- Finish option naming
- Gelato 28×40 US paper acceptance
- Printful prices
