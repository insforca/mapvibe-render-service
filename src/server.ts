/**
 * MapVibe Render Service — server.ts v3.5.0
 *
 * v3.0.0: Replace Playwright/SwiftShader browser pipeline with
 *   @maplibre/maplibre-gl-native (native OpenGL/EGL, no browser).
 *   Resolves vector-tile blank-map bug at zoom >= 13 in headless containers.
 *   Compositing (applyFades, drawPosterText) now runs via node-canvas
 *   using the identical Canvas 2D API — zero logic changes to poster rendering.