# MapVibe Render Service

Headless map rendering service for MapVibe Studio print export. Also dispatches Print-on-Demand fulfillment to Printful or Gelato.

## Endpoints

### `POST /render`

Auth: `x-api-key` (or `Authorization: Bearer ...`) matching `RENDER_API_SECRET`.

Body:
```json
{
  "styleJson": { /* MapLibre GL style object */ },
  "center": [-73.9857, 40.7484],
  "zoom": 12,
  "width": 2400,
  "height": 2400
}
```
Response: `image/png`. Max single-axis 14,400 px; tiled internally above.

Optional poster field (also persisted at the top level of design config snapshots):
`lockupFont: "space-plex" | "roboto"`. New designs should explicitly save
`"space-plex"`: Space Grotesk Bold 700 city, IBM Plex Mono Light 300 country,
IBM Plex Mono Regular 400 coordinates and credits, served from bundled TTFs.
Missing fields remain Roboto for existing-order parity; unknown values warn and
fall back to Roboto. The legacy `fontFamily` picker override still works on the
Roboto path; an explicit `space-plex` selects the fixed families above.
The render service cannot infer whether an unversioned request is a new design;
the studio must persist the id when it creates new designs.

Typography parity: the 900px font sheet records `NEW YORK` at 306.4287px
in browser canvas versus 305.4277px in Pango. Pango kerns across spaces
(`W `: −0.375px, ` Y`: −0.625px); measuring separate words reproduces the
browser canvas advance within 0.5px. The sheet's DOM inline width minus
eight trailing-inclusive spacing gaps gives 305.4409px, matching Pango.
No artificial 1px correction is applied. Country advance matches within
0.006px. Offline tests retain the browser measurements from
`scripts/font-sheet/out/metrics.json` in a small fixture and check actual
canvas advances, file hashes, and distinct Plex Light/Regular raster density.
The new baseline factors are 0.921em (city) and 0.950em (country/coordinates),
using hhea metrics and explicit 1.15em line boxes. Legacy Roboto retains
its historical 0.916796875em baseline for existing-order parity.

All nine picker families are bundled offline with per-weight aliases, pinned
source hashes and OFL licences in `assets/fonts/picker/SOURCES.md`. Noto Sans JP
uses official static CFF OTFs (300/400/700); the other picker faces use static
TTFs. All faces register at startup for single and tiled renders; unknown values
warn and use Roboto. Picker overrides also take precedence over `space-plex`.
Matching editor assets and browser parity remain separate work.

Optional fields on `/render` and the top level of fulfilment config snapshots
(including internally tiled renders):

| Field | Behaviour |
| --- | --- |
| `lockupLayout: "v2"` | Ivan's option A Small. Absent preserves legacy layout; unknown values warn and use legacy. Independent of `lockupFont` and the picker `fontFamily`. |
| `showCity`, `showCountry`, `showCoords` | Booleans, each defaulting to true. Non-booleans warn and are ignored. Hidden lines consume no height or margins. |
| `showPosterText: false` | Hides all three lines and their divider, overriding the individual toggles. Attribution remains governed by the existing credit behaviour. |

The studio must persist `lockupLayout: "v2"` for new designs that use Small;
an existing snapshot must never be implicitly upgraded. With explicit toggles,
the divider requires a visible city and at least one visible line below it.
Unmodified legacy requests retain their historical divider behaviour.

Exact v2 constants to mirror (exported as `LOCKUP_V2` in `src/poster-text.ts`):

| Setting | Value |
| --- | --- |
| City / country / coordinates size | `.055 / .025 / .021 × min(width, height)` |
| Tracking, respectively | `.12 / .14 / .04 em` |
| Reference short side | `482.390625 px` |
| Strip padding, top / sides / bottom | `6 / 38.59125 / 14` reference px |
| City / divider / country bottom margin | `3 / 4 / 3` reference px |
| Coordinates top and bottom margin | `.4 em` each |
| Divider height / width | `1` reference px / `20%` of strip content width |
| Line height | `1.15 em`, with adjacent vertical margins collapsed by `max` |
| All three lines' maximum inline width | `.84 × poster width`, including trailing tracking |
| Centred line anchor correction | `−tracking × fitted size / 2`, for each line |
| Text colour / alpha | `theme.ui.text`; fallback white below land luma `.5`, otherwise `#111111`. City and country alpha `1`; coordinates `.7` (multiplies any colour alpha). |
| Space/Plex faces | Space Grotesk Bold `700`; IBM Plex Mono **Light `300`**; IBM Plex Mono Regular `400` |
| Space/Plex baseline from line-box top | `.921 / .950 / .950 em` |

Reference px scale by `min(width,height) / 482.390625`. Start at proportional
sizes and fit measured glyph advances, with no size floors or city heuristic
pre-shrink. Measure and draw tracked text glyph by glyph with kerning disabled;
keep every line `white-space: nowrap`. Picker fonts still win family selection;
v2 uses the selected face's actual hhea/head baseline metrics (Roboto v2 uses
`.963427734375 em`; legacy retains `.916796875 em`).

For the v2 fade (fadeStyle `fullbleed`/`default`), draw an elliptical radial
gradient around the visible lockup lines (`lockupFadeEllipse`, constants in
`LOCKUP_V2_OVAL`). Over the visible lines (city, country, coordinates with text):
`top = min(y - ascent)`, `bottom = max(y + descent)`, `halfW = max(width) / 2`,
`s` = the first visible line's size. Centre: the divider x for the centered
layout, otherwise the widest line's centre; `cy = (top + bottom) / 2`.
Radii: `rx = (halfW + 1.2 s) * 1.35`, `ry = ((bottom - top) / 2 + .9 s) * 1.35`.
Alpha stops by normalised radius:

```text
[0, .85], [.5, .85], [.62, .78], [.72, .62], [.8, .44],
[.87, .27], [.93, .12], [.97, .04], [1, 0]
```

The studio uses the same numbers for its canvas and for the editor CSS
`radial-gradient(ellipse rx ry at cx cy, ...)`; `check-lockup-parity.cjs`
compares all three. No visible lines means no fade. Legacy `EDITOR_BOTTOM_FADE_STOPS` and its environment override
remain unchanged; the override does not affect v2.
The `none` and special `text` fade modes retain their previous behaviour.
Both v2 render paths use `theme.map.overlayBg ?? theme.ui.bg ?? "#f5f5f0"` as
the fade colour.

The offline canvas fixture `src/__tests__/fixtures/lockup-canvas.cjs` emits
`v2.ink` per line for studio matching. It renders white text on transparent
900×1200 canvases (NEW YORK / UNITED STATES / 33.8688° S / 151.2093° E), with
credits excluded. `meanAlpha` is `sum(alpha/255) / count(alpha>0)`;
`alphaArea` and bitmap `coverage` also quantify weight. Fontconfig reference
means are city `0.849483`, country `0.530948`, coordinates `0.354931`.
The suite checks these line diagnostics, exact faces, colour and alpha, and
separately verifies Plex Regular has greater raster density than Light.
Use the same dimensions, strings and transparent backing in the studio check;
antialiasing can vary by platform. On Windows set `PANGOCAIRO_BACKEND=fc` and
`FONTCONFIG_FILE` to a config containing the absolute `assets/fonts` directory
before starting Node, as the test does. No browser or network is needed.

`styleJson` must be a MapLibre style with at least one layer. `engine: "osm"`, a missing `styleJson`, or a style with no layers returns **400** and does not render. There is no Python/OSM fallback, and this endpoint does not send the failure email (`/render` is also used for image tests). `osmTheme`, `osmDist`, and `themeJson` are ignored. `RENDER_ENGINE` is not an engine switch.

### `POST /fulfill`

Auth: same as `/render`.

An explicit Design B SKU is routed from the catalogue. With `LEGACY_SKU_PASSTHROUGH` left at its default (on), a request with no `sku` — which is what the live studio webhook sends — or an old SKU form keeps the previous metafield path and the canvas-label rule. Set the flag to the literal `false` and those legacy requests return 422. A SKU that is neither a catalogue row nor a legacy form is 422 in both flag states. A disabled optional row is 422 `sku-disabled` even when the legacy flag is on.

`sku` is read only from the `sku` field or, if that is empty, from a single `lineItems[].sku`. `externalId` is `shopify-<id>-<sku>` truncated to 32 characters by the webhook, so it is never parsed. A label is not a SKU either.

`dryRun: true`, or a `tags` string/array containing `mv-canary`, runs that same validation and returns **200** with `dryRun: true` plus the resolved vendor, product UID or variant id, print area, centimetres, and DPI. It does not render a PNG and it does not call Gelato or Printful. A routing rejection on a dry run is still the same 422, with `dryRun: true` on the body.

Otherwise a catalogue hit returns `202` and the pixel render plus the vendor call run after that ack. A config snapshot that cannot be downloaded returns **502** before the 202.

Body (catalogue):
```json
{
  "externalId": "shopify-1234-MVS-P-1824",
  "sku":        "MVS-P-1824",
  "recipient":  { /* shipping address */ },
  "label":      "18×24 Poster",
  "quantity":   1,
  "configUrl":  "https://....public.blob.vercel-storage.com/...json"
}
```

On a catalogue SKU, `provider`, `variantId`, and `gelatoProductUid` do not override the table. On the legacy path they do, which is the previous contract: `variantId` and `catalogVariantId` are required, and a missing metafield is Printful only when the label matches `/canvas/i`.

Optional:
- `pngUrl` — already-rendered PNG. Catalogue posters and frames may use it. Catalogue canvas SKUs require `configUrl` so the service renders the print area (21×27 or 27×39). Legacy orders still accept `pngUrl` or `configUrl` and do not expand a print area.
- `configUrl` — config snapshot.
- `dimensionsArePrintArea` — also read from the snapshot. When true, canvas bounds are already the print sheet and the wrap is not applied again. The file is still rendered at the catalogue print-area centimetres. When the flag is absent, bounds are the visible face and the wrap is applied once. The service previously ignored this flag and always expanded.
- `lineItems` — `{ "sku": "MVS-P-1824" }`. One distinct SKU. Two distinct SKUs is 422.
- `dryRun` / `tags` — see above.
- `detailedRoads` — staff reprint override for the editor road-detail mode. Clean and Detailed both replay the editor `styleJson` through MapLibre. A snapshot with no usable style, or `engine: "osm"`, fails instead of drawing the old Python map.

`POST /preview` and `POST /warm` return **410**. They only existed to spawn the Python renderer.

### `GET /health`

Public. Returns `{ "status": "ok", "version": "3.6.0", "commit": "<git sha or null>", "build": "3.6.0" or "3.6.0@<sha>", "capabilities": ["dryRun", "catalogueSku"], "dryRun": false, "printfulAutoConfirm": false, "queue": {...}, "uptime": ... }`. No API key. The studio webhook treats this build as dry-run capable when `capabilities` contains both `dryRun` and `catalogueSku`. `commit` is only a hex git SHA (`RAILWAY_GIT_COMMIT_SHA`, else `GIT_COMMIT` or `SOURCE_VERSION`); anything else is omitted.

## Vendor routing (catalogue table)

`/fulfill` loads `data/catalogue-skus.csv` at call time. Each row is SKU → vendor (`gelato` or `printful`) → product UID or Printful variant id → trim size, pixel size, and bleed. Design B (10 variants) is enabled by default:

| SKU | Vendor | What is rendered |
|---|---|---|
| MVS-P-1824, MVS-P-2436 | Gelato giclée | nominal inches, single-pass 400 DPI |
| MVS-P-2840 | Gelato 700×1000 mm | the existing 70×100 cm single-pass size (~365 DPI, 10059×14370) |
| MVS-P-A0 | Gelato A0 giclée (841×1189 mm) | single-pass at the sheet (~307 DPI, 10165×14371), not the rounded 33.1×46.8 in label |
| MVS-F-1824-BK, MVS-F-2436-BK | Printful framed poster (variants 3 and 4) | same pixels as the poster |
| MVS-F-1824-BR, MVS-F-2436-BR | Gelato dark-wood framed poster | same pixels as the poster. The order item is the existing Gelato v4 shape: product UID plus one `default` print file |
| MVS-C-1824-W, MVS-C-2436-W | Printful framed canvas (15699, 15700) | print area 21×27 in and 27×39 in, single-pass. The editor bounds stay in the centre; the margin is wrap |

Optional rows (16×20 poster, natural-oak frames, gallery canvas including 30×40) are in the file and stay disabled until `CATALOGUE_ENABLE_OPTIONAL=true`.

An explicit SKU that is not a row, a disabled row, or a size that would not render single-pass at ≥ 300 DPI returns **422** plus `[FULFILL-FAIL]`. A catalogue file that cannot be loaded returns 500 for those explicit SKUs. Nothing is sent to a vendor. A config snapshot that cannot be downloaded returns **502** before the 202.

Legacy forms are not in the table. While `LEGACY_SKU_PASSTHROUGH` is on they use Shopify metafields (`custom.pod_partner`, `custom.gelato_uid`) and the old rule that a missing metafield is Printful only when the label contains "canvas". 100×150 cm is not added back to the catalogue. The legacy path does not grow a new size rejection the previous handler lacked. Orders that reach `/fulfill` today have no `sku` field; that absence is the legacy path, so a deploy with the flag left on does not change them.

`dimensionsArePrintArea` was ignored before this change, and canvas rows always expanded the editor bounds from the visible size (18×24 / 24×36) to the print area (21×27 / 27×39). The editor sets the flag when the snapshot bounds are already that print sheet. The service now skips the second expansion when the flag is on the body or the snapshot. A full poster PNG was not rendered; the geometry test checks one expansion versus two.

`FULFILL_DRY_RUN=true` pauses **all Gelato and Printful HTTP calls**, including catalog/discovery GETs, creation, update, cancellation, confirmation, suffix retries, and v1 fallback. It is read from the running process environment immediately before every vendor request, rather than cached at startup. This no longer creates Gelato drafts. With dispatch allowed, Gelato creates real orders and `PRINTFUL_AUTO_CONFIRM` still only selects Printful confirm versus draft (the per-request `confirm` override still takes precedence). A request `dryRun` retains its routing-preview behavior.

When the pause is already active, an otherwise accepted `/fulfill` returns **503** with `status: "held"`, `shipped: false`, `retryable: true`, `success: false`, and `accepted: false`. No rendering or vendor dispatch follows. A pause during an already accepted request stops the next vendor call; clients return a held result and logs contain `[DRY-RUN] held` with order and line-item identifiers only. Startup logs a WARN while paused. `/health` exposes the current `dryRun` and `printfulAutoConfirm` booleans publicly.

There is **no durable fulfillment job store or automatic resume queue** in this service: accepted fulfillment runs in memory after the 202. A hold does not delete existing vendor orders or local assets. Retain the upstream order/line request and replay it after clearing the pause; a 503 makes the hold visible to the caller but does not guarantee that the upstream system retries. Work paused after a 202 also requires upstream/manual replay. Updating the running process environment is reflected on the next call; changing a hosting-platform variable may still restart the process according to that platform's behavior.

### Already not fulfilled, before this change

- Metric SKUs, `MVS_CITY_*`, and the 50×70 / 70×100 / 100×150 masters are not in the studio `SKU_MAP`, so the webhook already answers "Unknown SKU" and does not call this service. Passthrough only matters for a direct `/fulfill` that still uses the old body.
- The 100×150 Gelato product is deactivated and the master file is not available. The new table omits it. The legacy handler never had a special 100×150 rejection, and this change does not add one.
- Truncating `externalId` to 32 characters can still make two lines of one order share an id (Printful `external_id`, Gelato duplicate check). That is in the webhook. This service no longer reads a SKU out of that truncated string, which had been able to alias `MVS-C-1824-W` onto the disabled gallery row `MVS-C-1824`.
- The studio config-path webhook can return 200 when every line is unknown, so Shopify does not retry. That is the other repository.
- A catalogue canvas line that arrives with only `pngUrl` is still 422. Legacy canvas orders that fulfil today send `pngUrl` or `configUrl` and caller centimetres, and they stay on that path.

## Env Vars

| Variable | Required | Description |
|---|---|---|
| `PORT`                  | Auto    | Set by Railway |
| `RENDER_API_SECRET`     | **Yes** | x-api-key value for `/render` and `/fulfill` |
| `PRINTFUL_API_KEY`      | **Yes** | Printful API token |
| `PRINTFUL_STORE_ID`     | No      | Printful store ID (defaults to known value) |
| `PRINTFUL_AUTO_CONFIRM` | No      | `"true"` to auto-confirm orders |
| `GELATO_API_KEY`        | If routing to Gelato | Gelato API token |
| `GELATO_STORE_ID`       | No      | Gelato store ID (defaults to known value) |
| `FULFILL_DRY_RUN`       | No      | `"true"` (case-insensitive) holds every Gelato and Printful HTTP call. Default false. Held work requires upstream retry/replay; see above. |
| `CATALOGUE_DESIGN`      | No      | Design letter matched against `in_designs` (default `B`) |
| `CATALOGUE_ENABLE_OPTIONAL` | No | `"true"` also routes the disabled premium rows |
| `LEGACY_SKU_PASSTHROUGH` | No | Default on. The literal `false` makes a missing SKU or a legacy form return 422 instead of the metafield path. |
| `ALERT_WEBHOOK_URL`     | No      | Optional Slack/Discord/Sentry-Webhook URL. When set, `/fulfill` terminal failures POST a `{ text, event }` JSON payload there in addition to the `[FULFILL-FAIL]` log line. Best-effort; webhook errors are swallowed. |
| `ALERT_EMAIL`           | No      | Destination for the same failures via Resend (set this to Ivan's address). Best-effort: a missing address still fails the order and still logs `[FULFILL-FAIL]`. |
| `RESEND_API_KEY`        | With `ALERT_EMAIL` | Resend API key. Already the production email path; no new variable. |
| `ALERT_FROM_EMAIL`      | No      | Sender. Defaults to `alerts@mapvibestudio.com`. |
| `BLOB_READ_WRITE_TOKEN` | If using `configUrl` path | Vercel Blob token for uploads |
| `MAPTILER_API_KEY`      | No      | Tile fallback when style references MapTiler |
| `MAX_CONCURRENT`        | No      | Concurrent renders (default 4) |
| `MAX_QUEUE_SIZE`        | No      | Pending renders before 503 (default 20) |

## Fulfillment failure signal

Unknown SKUs, disabled SKUs, and a config snapshot that fails to download are rejected **before** 202, with `[FULFILL-FAIL]` as well. After Railway ACKs `/fulfill` with 202, a later render or vendor error is invisible to Shopify. The service emits a structured `[FULFILL-FAIL] {json}` log line on every terminal failure:

```
[FULFILL-FAIL] {"externalId":"mapvibe-1234-MVS-18x24-BLACK","reason":"printful-api","detail":"...","at":"2026-..."}
```

Reasons:

- `sku-unmapped` — explicit SKU is not a catalogue row, or (only when `LEGACY_SKU_PASSTHROUGH=false`) the SKU is absent or a legacy form (422, no vendor call)
- `sku-disabled` — SKU is an optional row and `CATALOGUE_ENABLE_OPTIONAL` is not `true` (422). The legacy flag does not route these.
- `sku-unrenderable` — size is not single-pass ≥ 300 DPI, or a catalogue canvas SKU arrived without `configUrl` (422)
- `catalogue-unavailable` — the CSV could not be loaded and the SKU is not a legacy passthrough (500)
- `routing-lookup-error` — legacy path, Shopify metafield lookup failed, strict mode (422)
- `routing-unresolved` — legacy path, no `pod_partner` metafield and the label is not canvas (422)
- `config-render` — config snapshot failed to download (502, before 202) or the MapLibre render returned no PNG after 202
- `missing-style` — the snapshot has no usable `styleJson` (missing, or no layers). The order is not printed. Catalogue orders, which already downloaded the snapshot, return **422** before the 202 and email. Legacy orders (no `sku`, the live webhook shape) still ack **202** so the Shopify webhook is not held open, then fail in the async path with the same alert and do not call Gelato or Printful. Detail includes `styleState` (`missing` or `empty`), `city` when the snapshot has one, and `formerRoute` (the Python route that used to run, such as `detailed-osm-no-style` or `env-osm-legacy-config`)
- `osm-engine-retired` — the snapshot set `engine` to `osm`. Not printed, even when a style is present. Same 422-vs-async split as `missing-style`
- `missing-gelato-uid` — Gelato was selected but no product UID was available
- `gelato-api` — Gelato v4 returned non-2xx
- `gelato-uncaught` — exception thrown inside the Gelato fetch
- `printful-api` — Printful v2/v1 returned a non-success body
- `printful-uncaught` — exception thrown inside the Printful path

The same `[FULFILL-FAIL]` tag is used by `mapvibe-studio`'s `shopify-order-webhook.ts` so a single log-drain pattern catches both repos. Set `ALERT_WEBHOOK_URL` to additionally POST each event to Slack/Discord/Sentry-Webhook — both accept `{ text }` and the JSON `event` payload is available for richer alerting.

## Security model

- HMAC-`timingSafeEqual` auth on every protected route.
- Recursive style-JSON URL walk + allowlist + private-IP regex (SSRF defence).
- Hard pixel caps (14,400 single axis / 150M total) with auto-downscale and tiled rendering for >14,400 px posters.
- 2 MB JSON body cap, 55 s render timeout, queue 503 at 20 pending.
- `/render` 500 responses do NOT include `err.message` (no internal-path leakage).

## Deploy

Production deploys come from Railway's GitHub integration, with **Wait for CI** on. A push to `main` is built and deployed by Railway after the GitHub Actions checks on that commit succeed (`test` and `npm audit`). Railway auto-detects the Dockerfile. The container healthcheck targets `/health`.

Service variables are configured on the Railway service and stay there across deploys. MapLibre prints from OpenFreeMap tiles (`tiles.openfreemap.org`), not from the Python PMTiles/PBF cache. `USE_PMTILES` is no longer read; leaving it set is harmless. `RENDER_ENGINE=osm` is not an engine switch. It only labels the old route when a snapshot has no `styleJson` (`env-osm-legacy-config`). A usable style is still MapLibre. `RESEND_API_KEY` and `ALERT_EMAIL` must already be set for Ivan to get the failure email; the order still fails if they are absent.

Do not add an Actions workflow that runs `railway up` on push to `main`. A failing job on the same commit makes Railway skip its native deployment of that commit.
