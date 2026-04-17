# MapVibe Render Service

Headless map rendering service for MapVibe Studio print export.

## Endpoint

### `POST /render`

**Body:**
```json
{
  "styleJson": { /* MapLibre GL style object */ },
  "center": [-73.9857, 40.7484],
  "zoom": 12,
  "width": 2400,
  "height": 2400
}
```
**Response:** `image/png`

### `GET /health`
Returns `{ "status": "ok" }`.

## Env Vars

| Variable | Description |
|---|---|
| `PORT` | Auto-set by Railway |
| `RENDER_API_SECRET` | Optional API key auth |

## Deploy
Connect this repo to Railway — it auto-detects the Dockerfile.
