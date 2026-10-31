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
- `detailedRoads` — staff reprint override for the editor road-detail mode.

### `GET /health`

Public. Returns `{ "status": "ok", "version": "3.6.0", "commit": "<git sha or null>", "build": "3.6.0" or "3.6.0@<sha>", "capabilities": ["dryRun", "catalogueSku"], "queue": {...}, "uptime": ... }`. No API key. The studio webhook treats this build as dry-run capable when `capabilities` contains both `dryRun` and `catalogueSku`. `commit` is only a hex git SHA (`RAILWAY_GIT_COMMIT_SHA`, else `GIT_COMMIT` or `SOURCE_VERSION`); anything else is omitted.

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

`FULFILL_DRY_RUN` still only changes Gelato `orderType` to `draft` on a real vendor call. A request `dryRun` never gets that far. `PRINTFUL_AUTO_CONFIRM` is unchanged.

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
| `FULFILL_DRY_RUN`       | No      | `"true"` sends Gelato `orderType: "draft"` (never charged). Default is a real Gelato order. Printful is unaffected. |
| `CATALOGUE_DESIGN`      | No      | Design letter matched against `in_designs` (default `B`) |
| `CATALOGUE_ENABLE_OPTIONAL` | No | `"true"` also routes the disabled premium rows |
| `LEGACY_SKU_PASSTHROUGH` | No | Default on. The literal `false` makes a missing SKU or a legacy form return 422 instead of the metafield path. |
| `ALERT_WEBHOOK_URL`     | No      | Optional Slack/Discord/Sentry-Webhook URL. When set, `/fulfill` terminal failures POST a `{ text, event }` JSON payload there in addition to the `[FULFILL-FAIL]` log line. Best-effort; webhook errors are swallowed. |
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
- `config-render` — config snapshot failed to download (502, before 202) or the render returned null after 202
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

Connect this repo to Railway — it auto-detects the Dockerfile. Container healthcheck targets `/health`.
