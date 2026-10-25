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

Auth: same as `/render`. A catalogue miss, a disabled SKU, or a config snapshot that cannot be downloaded returns a non-2xx status and does not call a vendor. Otherwise the route returns `202` and the pixel render plus the vendor call run after that ack.

Body (minimum):
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

`sku` may be omitted when `externalId` or `label` already contains a catalogue SKU (`MVS-P-1824`, `MVS-F-1824-BK`, `MVS-C-1824-W`, …). Vendor, Gelato UID / Printful variant id, and print size come from `data/catalogue-skus.csv`. A caller-supplied `provider`, `variantId`, or `gelatoProductUid` does not override the table.

Optional:
- `pngUrl` — already-rendered PNG. Posters and frames may use it. Canvas SKUs require `configUrl` so the service renders the print area (21×27 or 27×39), not an 18×24 file.
- `configUrl` — config snapshot. Rendered at the catalogue size before the vendor call.
- `detailedRoads` — staff reprint override for the editor road-detail mode.

### `GET /health`

Public. Returns `{ "status": "ok", "version": "...", "queue": {...}, "uptime": ... }`.

## Vendor routing (catalogue table)

`/fulfill` loads `data/catalogue-skus.csv` at call time. Each row is SKU → vendor (`gelato` or `printful`) → product UID or Printful variant id → trim size, pixel size, and bleed. Design B (7 variants) is enabled by default:

| SKU | Vendor | What is rendered |
|---|---|---|
| MVS-P-1824, MVS-P-2436 | Gelato giclée | nominal inches, single-pass 400 DPI |
| MVS-P-2840 | Gelato 700×1000 mm | the existing 70×100 cm single-pass size (~365 DPI, 10059×14370) |
| MVS-F-1824-BK, MVS-F-2436-BK | Printful framed poster (variants 3 and 4) | same pixels as the poster |
| MVS-C-1824-W, MVS-C-2436-W | Printful framed canvas (15699, 15700) | print area 21×27 in and 27×39 in, single-pass. The editor bounds stay in the centre; the margin is wrap |

Optional rows (16×20 poster, natural-oak frames, gallery canvas including 30×40) are in the file and stay disabled until `CATALOGUE_ENABLE_OPTIONAL=true`.

An unknown SKU, a disabled SKU, or a size that would not render single-pass at ≥ 300 DPI returns **422** (catalogue load failure returns 500) plus `[FULFILL-FAIL]` / `ALERT_WEBHOOK_URL`. Nothing is sent to a vendor. A config snapshot that cannot be downloaded returns **502** before the 202, so the caller can make Shopify retry. Legacy metric SKUs, `MVS_CITY_*`, 16×20 Printful ids, and 100×150 cm are not in the table.

`FULFILL_DRY_RUN` still only changes Gelato `orderType` to `draft`. `PRINTFUL_AUTO_CONFIRM` is unchanged.

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

- `sku-unmapped` — SKU is not in the catalogue (422, no vendor call)
- `sku-disabled` — SKU is an optional row and `CATALOGUE_ENABLE_OPTIONAL` is not `true` (422)
- `sku-unrenderable` — size is not single-pass ≥ 300 DPI, or a canvas SKU arrived without `configUrl` (422)
- `catalogue-unavailable` — the CSV could not be loaded (500)
- `config-render` — config snapshot failed to download (502, before 202) or the render returned null after 202
- `missing-gelato-uid` — catalogue row was Gelato but had no product UID
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
