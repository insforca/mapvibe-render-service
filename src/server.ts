/**
 * MapVibe Render Service — server.ts v3.0.0
 *
 * v3.0.0: Replace Playwright/SwiftShader browser pipeline with
 *   @maplibre/maplibre-gl-native (native OpenGL/EGL, no browser).
 *   Resolves vector-tile blank-map bug at zoom >= 13 in headless containers.
 *   Compositing (applyFades, drawPosterText) now runs via node-canvas
 *   using the identical Canvas 2D API — zero logic changes to poster rendering.
 *
 * Base image changed: mcr.microsoft.com/playwright → node:20-bookworm-slim
 *   (smaller image, explicit GL/EGL deps instead of bundled Chromium)
 *
 * Env vars (unchanged from v2.x):
 *   RENDER_API_SECRET        — required; auth for /render and /fulfill
 *   PRINTFUL_API_KEY         — Printful OAuth token
 *   PRINTFUL_STORE_ID        — Printful store ID (default: 17897492)
 *   BLOB_READ_WRITE_TOKEN    — Vercel Blob write token
 *   MAPTILER_API_KEY         — MapTiler API key (optional; used for glyph CDN)
 *   SITE_ORIGIN              — Site origin (default: https://mapvibestudio.com)
 *   VERCEL_APP_ORIGIN        — Vercel app origin for sprite absolutization
 */