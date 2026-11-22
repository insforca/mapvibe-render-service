# Print proof

`POST /proof` returns the print PNG for a studio config snapshot. Send the same snapshot object used by `/api/store-config`. The endpoint accepts the render service's usual `x-api-key` or Bearer credential.

With the local service running, use this command to render `snapshot.json` and save the image and headers locally.

```sh
jq '{snapshot: ., maxHeight: 2400}' snapshot.json |
  curl --silent --show-error --fail http://localhost:3000/proof \
    -H "Authorization: Bearer $RENDER_API_SECRET" \
    -H 'Content-Type: application/json' \
    --data-binary @- --dump-header proof.headers --output proof.png
```

`widthCm` and `heightCm` independently override the snapshot dimensions. For a catalogue order, use the order's print-sheet dimensions. A proof uses the supplied sheet as the visible window. Wrapped catalogue canvases also require a SKU-specific visible window during fulfilment. The optional boolean `detailedRoads` has the same meaning as the fulfilment override.

**Proof mode.** `X-Proof-Mode: full-downscaled` means the service renders and validates the full print first. Omitting `maxHeight` returns those exact bytes. A smaller positive integer resizes the finished PNG proportionally, keeping its sRGB profile. This exercises the full-size camera, fonts, compositing and tiled path even for a small response.

`X-Proof-Width` and `X-Proof-Height` describe the returned image in pixels. `X-Proof-Dpi` reports the full print DPI, also retained in the PNG density tag. `X-Proof-Engine` identifies the renderer. `X-Proof-Tile-Host` reports the patched source hostname for the first layer referencing a tile source, or `none` for a background-only map. `X-Proof-Glyph-Host` reports the patched OpenFreeMap font hostname.

Each process admits up to six authenticated proof requests per rolling minute. A rate-limited request receives 429 and `Retry-After`. An active or waiting render causes an immediate 503. Each admitted proof holds one render slot through PNG resizing. A paid order arriving on a single-slot worker can wait for the current proof to finish. Further proofs cannot queue ahead of it. The existing memory sampler tracks the job as `proof`.
