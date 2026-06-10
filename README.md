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

Auth: same as `/render`. Returns `202` immediately, fulfillment runs async.

Body (minimum):
```json
{
  "externalId":       "mapvibe-1234-MVS-18x24-BLACK",
  "recipient":        { /* shipping address */ },
  "variantId":        12345,
  "catalogVariantId": 12345,
  "label":            "18×24 Black Frame",
  "quantity":         1,
  "pngUrl":           "https://....public.blob.vercel-storage.com/...png"
}
```

Optional:
- `configUrl` — config snapshot URL (renders before fulfilling)
- `provider`  — `printful` (default) or `gelato`
- `shopifyVariantId` — Shopify numeric variant ID; enables metafield-driven routing (see below)
- `gelatoProductUid` — Gelato product UID, only required when routing to Gelato manually

### `GET /health`

Public. Returns `{ "status": "ok", "version": "...", "queue": {...}, "uptime": ... }`.

## Vendor routing (Printful + Gelato)

Two vendors, one of three modes:

1. **Explicit** — caller passes `provider: "printful" | "gelato"`. Honored as-is.
2. **Metafield-driven** — caller omits `provider` and passes `shopifyVariantId`. The service queries the Shopify Admin API for `custom.pod_partner` and `custom.gelato_uid` on that variant. Results are cached per variant (10-min TTL).
   - `pod_partner = "gelato"` → routes to Gelato using `custom.gelato_uid`
   - `pod_partner = "printful"` or any other value → routes to Printful
   - **No `pod_partner` set (legacy)** → defaults to Printful (quiet)
   - **Metafield lookup fails** (network, missing admin token, non-2xx, 3s timeout) → behaviour controlled by `STRICT_ROUTING_LOOKUP`:
     - **default (off)** → falls back to Printful (today's behaviour), but logs at ERROR level so misrouted Gelato variants surface in Railway logs.
     - **set to `"true"`** → returns `422` so the caller can retry or specify `provider` explicitly. Only flip on once n8n + the editor's `shopify-order-webhook` handle `422` cleanly.
3. **Default** — neither explicit nor metafield-driven → Printful.

Both vendors receive the same PNG at the same DPI. There is no per-vendor bleed/profile branch.

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
| `SHOPIFY_ADMIN_TOKEN`   | If using metafield routing | Shopify Admin REST token |
| `SHOPIFY_SHOP`          | No      | `your-store.myshopify.com` (defaults to known value) |
| `STRICT_ROUTING_LOOKUP` | No      | `"true"` to return 422 on metafield-lookup failure; default off (log + silent Printful default) — see "Vendor routing" above |
| `ALERT_WEBHOOK_URL`     | No      | Optional Slack/Discord/Sentry-Webhook URL. When set, `/fulfill` terminal failures POST a `{ text, event }` JSON payload there in addition to the `[FULFILL-FAIL]` log line. Best-effort; webhook errors are swallowed. |
| `BLOB_READ_WRITE_TOKEN` | If using `configUrl` path | Vercel Blob token for uploads |
| `MAPTILER_API_KEY`      | No      | Tile fallback when style references MapTiler |
| `MAX_CONCURRENT`        | No      | Concurrent renders (default 4) |
| `MAX_QUEUE_SIZE`        | No      | Pending renders before 503 (default 20) |

## Fulfillment failure signal

After Railway ACKs `/fulfill` with 202, downstream errors are invisible to the caller. The service emits a structured `[FULFILL-FAIL] {json}` log line on every terminal failure:

```
[FULFILL-FAIL] {"externalId":"mapvibe-1234-MVS-18x24-BLACK","reason":"printful-api","detail":"...","at":"2026-..."}
```

Reasons:

- `config-render` — `configUrl` was given but `renderConfigToBlobUrl` returned null
- `missing-gelato-uid` — routed to Gelato but no `gelatoProductUid` available (not in request, not in metafields)
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
