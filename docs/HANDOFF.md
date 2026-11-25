# Handoff

Keep this file updated in every pull request that changes behaviour. The owner (Ivan) approves merges.

Current state of mapvibe-render-service on 2026-11-10. There is no CHANGELOG in this repo; history is the git log. Where the notes and the code disagree, the line is marked `check:`.

## Done

- Live on Railway: deployment `e7c27ac5`, commit `6328fba` (PR #99), service version 3.6.0.
  - check: `6328fba` is `HEAD` of `main` (`Embed a vendored sRGB ICC profile in print PNGs (#99)`). `e7c27ac5` is not a git object in this repo. Treat it as the Railway deployment id from Ivan's notes.
  - check: `GET /health` reports `3.6.0` from `SERVICE_VERSION` in `src/health-info.ts`. `package.json` and `package-lock.json` still say `3.1.0`.
- Verified with image-only renders: Lisbon `vintage_noir`, Clean and Detailed, 900×1200, each in under 2 seconds, pixel-identical to #98, ICC profile embedded.
- The vendored profile matches the 2026-11-09 decision: `assets/color/sRGB2014.icc` is 3024 bytes, SHA-256 `384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a`. `src/srgb-icc.ts` refuses to start if that file is missing or not an ICC profile.
- Catalogue pixels match the 2026-11-09 size list (`data/catalogue-skus.csv`, and the 18×24 / 24×36 / 70×100 cm cases in `src/__tests__/render-dims.test.ts`): 7200×9600, 9600×14400, 10059×14370, 10165×14371, 8400×10800, 9963×14391. Caps in `src/render-dims.ts` are target 400 DPI, floor 300 DPI, max edge 14,400 px, max 150 million px.
- `POST /render` returns 400 for a missing style or `engine=osm`. `POST /preview` and `POST /warm` return 410. The Python/OSM renderer no longer prints maps.
- Railway settings from Ivan's notes: `USE_PMTILES=true`, 7 GB / 2 vCPU, `MAX_CONCURRENT=2`, Wait for CI on. Fulfilment is live (`FULFILL_DRY_RUN=false`, `PRINTFUL_AUTO_CONFIRM=true`).
  - check: this repo does not read `USE_PMTILES`. The README says leaving it set is harmless.
  - check: `src/server.ts` defaults `MAX_CONCURRENT` to 4 when unset. The value 2 is not in the repo.
  - check: `railway.json` does not set memory or CPU.
  - The README also says Wait for CI is on. `FULFILL_DRY_RUN` and `PRINTFUL_AUTO_CONFIRM` are service variables, not committed files. The code sends a real Gelato order unless `FULFILL_DRY_RUN` is the string `true`.

## In progress

None recorded on 2026-11-10.

## Next (not approved)

Not started. Ivan has not approved these:

- Studio cleanup of leftover `osmTheme` / `osmDist` fields (mapvibe-studio, not this repo). The README in this repo already says `/render` ignores `osmTheme`, `osmDist`, and `themeJson`.
- An end-to-end order test.
- Detailed text spacing.

## Not verified

- An end-to-end order through `/fulfill` to a vendor.
- A paper print.
- A real editor screenshot next to a Detailed print.

## Rollback point

`11bb028d`, recorded as commit `6fe44c0` / PR #98.

check: `11bb028d` is not a git object in this repo. `git checkout 11bb028d` will fail. The parent of `6328fba` is `6fe44c046bdb65043caa8148e533f76a70306496` (`Fail maps with no editor style instead of printing the Python OSM fallback (#98)`, 2026-11-09). Use `6fe44c0` as the git rollback. Treat `11bb028d` as the Railway deployment id from Ivan's notes.

## How to verify

Image-only. Never print secrets. Never call `/fulfill`, webhooks, Gelato, Printful, or Shopify order routes.

1. `GET /health` is public. Read `version`, `commit`, and `build`. `commit` is the git SHA (`RAILWAY_GIT_COMMIT_SHA`, else `GIT_COMMIT` or `SOURCE_VERSION`). A value that is not a hex SHA is omitted.
2. `POST /render` with the header `x-api-key` set from the environment (`RENDER_API_SECRET` in this repo). Body needs a MapLibre `styleJson` with at least one layer, plus centre, zoom, width, and height. The response is `image/png`. Do not echo the key, the header, or the environment.
3. A missing `styleJson` or `engine` set to `osm` must return 400 and must not render. That 400 does not send the failure email. The email path is `/fulfill` only, and `/fulfill` is out of bounds for verification.
