# AGENTS.md: mapvibe-render-service

Read by every agent that works or reviews here: Claude Code (through `CLAUDE.md`), Codex, Copilot CLI and Gemini CLI. Team process, roles and the current state live in the `insforca/mapvibe-context` repo (`RULES.md`, `ORCHESTRATION.md`, `STATE.md`); this file holds what you need inside this repo.

## What this is
The print renderer and fulfilment dispatcher (Node + TypeScript, maplibre-gl-native, Pango/Cairo), on Railway. It renders the final poster PNG from the editor's design, uploads it, and sends the order line to Gelato, Printful or Prodigi, chosen by SKU (`data/catalogue-skus.csv`, `src/catalogue.ts`).

## Commands (all must pass before a PR is called done)
- `npm run build` (tsc)
- `npm test` (vitest)
- `npm run catalogue:validate`: any change to SKUs, vendors or the catalogue fixture.
- Print proof: only `POST /render` or `/proof` on a server started with `FULFILL_DRY_RUN=true`. On this Windows PC the local GL render draws a blank map, so map proofs run on Railway, started by the owner.

## Hard rules
- **Fulfilment is live** (`FULFILL_DRY_RUN=false`, `PRINTFUL_AUTO_CONFIRM=true` in production). Never call `/fulfill`, order webhooks, or any vendor order endpoint (Gelato, Printful, Prodigi `POST /orders`), not even in a sandbox, unless the owner asks for that exact call.
- **Every vendor HTTP call goes through `vendorFetch`** (`src/vendor-dispatch.ts`), so the dry-run brake holds it. A direct `fetch` to a vendor is a defect.
- **No duplicate orders.** Vendor orders carry a stable idempotency key or reference derived from the Shopify line; keep it stable.
- **Never write a secret value** in code, tests, logs, PR text or review output. Env var names only. No customer data.
- **Native GL guard:** a framebuffer above 16384 px per edge aborts the process (incident 2026-11-23). Validate sizes before the native call.
- **PRs only.** Never push to `main`, never merge, never delete a branch. The owner, Ivan, approves every merge and deploy.

## How to review here (Copilot, Gemini, Codex)
- You are read-only: do not edit files, run installs, push or call network services.
- Report real defects only, each with file, line, the concrete failure and a fix. Say plainly when you find none.
- Check first: a vendor call that bypasses `vendorFetch`, a path that can create a second order, a secret in output, an editor/print mismatch.
- Tests that pass while the feature is broken count as a defect.
