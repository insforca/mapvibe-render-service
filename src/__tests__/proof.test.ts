import express from 'express';
import Module from 'node:module';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { stillExtent } from '../print-parity.js';
import * as renderDims from '../render-dims.js';
import * as printPng from '../print-png.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { put } from '@vercel/blob';
import { fulfillGelato } from '../gelato.js';
import { fulfillPrintful } from '../printful.js';
import { planFulfillment } from '../fulfill-plan.js';
import { rejectHeldFulfillment } from '../fulfill-dispatch.js';
import { notifyFulfillFail, notifyFulfillHeld } from '../alerting.js';
import { notifyRejectedFulfillRoute } from '../style-fail.js';

vi.mock('@vercel/blob', () => ({ put: vi.fn() }));
vi.mock('../gelato.js', () => ({ fulfillGelato: vi.fn() }));
vi.mock('../printful.js', () => ({ fulfillPrintful: vi.fn() }));
vi.mock('../fulfill-plan.js', () => ({ planFulfillment: vi.fn() }));
vi.mock('../fulfill-dispatch.js', () => ({ rejectHeldFulfillment: vi.fn() }));
vi.mock('../alerting.js', () => ({ notifyFulfillFail: vi.fn(), notifyFulfillHeld: vi.fn() }));
vi.mock('../style-fail.js', () => ({ notifyRejectedFulfillRoute: vi.fn() }));
// Exercise the real DPI selection and stitched path at fixture scale.
vi.mock('../render-dims.js', async importOriginal => ({
  ...await importOriginal<typeof import('../render-dims.js')>(),
  PRODUCTION_RENDER_CAPS: { targetDpi: 400, minSinglePassDpi: 300, maxEdgePx: 400, maxPx: 160_000 },
}));

const key = 'offline-proof-test';
const snapshot = {
  center: [0, 0], zoom: 8, widthCm: 1.27, heightCm: 2.54,
  displayCity: 'Private city label', showPosterText: false, includeCredits: false,
  styleJson: { version: 8, sources: { base: { type: 'vector', url: '/tiles' } },
    glyphs: 'https://api.maptiler.com/fonts/{fontstack}/{range}.pbf', sprite: '/sprite',
    layers: [{ id: 'background', type: 'background' },
      { id: 'road-secondary', type: 'line', source: 'base', 'source-layer': 'transportation', layout: { visibility: 'none' } }] },
};
const loadStyle = vi.fn();
const viewport = vi.fn();
type Draw = (err: Error | null, pixels?: Buffer) => void;
const renderFrame = vi.fn((width: number, height: number, done: Draw) => done(null, Buffer.alloc(width * height * 4)));
let server: Server;
let time = Date.UTC(2030, 0, 1);

beforeAll(async () => {
  vi.stubEnv('RENDER_API_SECRET', key);
  vi.stubEnv('GELATO_API_KEY', 'offline');
  vi.stubEnv('MAX_CONCURRENT', '1');
  vi.stubEnv('VERCEL_APP_ORIGIN', 'https://sprite.invalid');
  const requireModule = Module.prototype.require;
  const native = vi.spyOn(Module.prototype, 'require').mockImplementation(function (id) {
    if (id !== '@maplibre/maplibre-gl-native') return requireModule.call(this, id);
    return { Map: class {
      constructor(private options: { ratio: number }) {}
      load = loadStyle;
      release() {}
      render({ width, height }: { width: number; height: number }, done: Draw) {
        viewport(width, height);
        renderFrame(stillExtent(width, this.options.ratio), stillExtent(height, this.options.ratio), done);
      }
    } };
  });
  // Use the actual Express routes and parser on an ephemeral loopback port.
  vi.spyOn(express.application, 'listen').mockImplementationOnce(function () {
    server = createServer(this).listen(0, '127.0.0.1');
    return server;
  });
  try {
    await import('../server.js');
    if (!server.listening) await once(server, 'listening');
  } finally {
    native.mockRestore();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  time += 60_001;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function post(body: unknown, headers: Record<string, string> = { 'x-api-key': key }, path = '/proof') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; png: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path,
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, png: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const orderEffects = [put, fulfillGelato, fulfillPrintful, planFulfillment, rejectHeldFulfillment,
  notifyFulfillFail, notifyFulfillHeld, notifyRejectedFulfillRoute];
function expectNoOrderEffects() {
  for (const effect of [...orderEffects, fetch]) expect(effect).not.toHaveBeenCalled();
}

describe('POST /proof', () => {
  // Includes rejection, busy, rate-limited, corrupt render and success paths.
  // fetch also guards Shopify lookups and any outbound HTTP bypassing these boundaries.
  afterEach(expectNoOrderEffects);

  it('authenticates before parsing or rendering', async () => {
    expect((await post('{', {})).status).toBe(401);
    expect((await post({ snapshot }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect(renderFrame).not.toHaveBeenCalled();
  });

  it.each(['{', {}, { snapshot: {} }, { snapshot: { ...snapshot, styleJson: null } },
    { snapshot: { ...snapshot, engine: 'osm' } }, { snapshot, widthCm: -1 }, { snapshot, maxHeight: 0.5 },
    { snapshot, detailedRoads: 'true' }, { snapshot: { ...snapshot, zoom: -1e308 } },
    { snapshot, sku: 123 }, { snapshot, sku: ' ' }, { snapshot, sku: 'MVS-UNKNOWN' },
    { snapshot: { ...snapshot, zoom: 25 } }])('rejects invalid request %#', async body => {
    expect((await post(body)).status).toBe(400);
    expect(renderFrame).not.toHaveBeenCalled();
  });

  // First native canvas/ICC encode can cold-start alongside the font fixture suites.
  it('uses print dimensions and patched sources before downscaling', { timeout: 30_000 }, async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await post({ snapshot, maxHeight: 80 }, { authorization: 'Bearer ' + key });
    expect(result.status).toBe(200);
    expect(renderFrame.mock.calls[0].slice(0, 2)).toEqual([200, 400]);
    expect(loadStyle.mock.calls[0][0]).toMatchObject({
      sources: { base: { url: 'https://tiles.openfreemap.org/planet' } },
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sprite: 'https://sprite.invalid/sprite',
    });
    expect(result.headers).toMatchObject({ 'content-type': 'image/png', 'x-proof-width': '40', 'x-proof-height': '80',
      'x-proof-dpi': '400', 'x-proof-engine': 'maplibre', 'x-proof-mode': 'full-downscaled',
      'x-proof-tile-host': 'tiles.openfreemap.org', 'x-proof-glyph-host': 'tiles.openfreemap.org' });
    expect(await sharp(result.png).metadata()).toMatchObject({ format: 'png', width: 40, height: 80, density: 400, hasProfile: true });
    expect(log.mock.calls).toEqual([[expect.stringMatching(/^\[proof\] status=200 elapsedMs=\d+$/)]]);
  });

  it.each([false])('uses the catalogue sheet and preserves the poster face (tiled=%s)', { timeout: 30_000 }, async tiled => {
    // Keep physical sheet/face geometry exact at 12 px/in, with two strips
    // for the stitched case. All type, compositing and PNG encoding are real.
    const compute = renderDims.computeRenderDims;
    vi.spyOn(renderDims, 'computeRenderDims').mockImplementation((w, h, bounds) =>
      compute(w, h, bounds, { targetDpi: 12, minSinglePassDpi: 12, maxEdgePx: 400, maxPx: tiled ? 48_000 : 160_000 }));
    const face = { ...snapshot, lockupLayout: 'v2', showPosterText: true, includeCredits: true,
      displayCity: 'Lisbon', displayCountry: 'Portugal', mapWidth: 216, mapHeight: 288,
      bounds: { west: -0.3, east: 0.3, north: 0.4, south: -0.4 } };
    // Same 18x24 face and the same 12 mm frame inset as the white-frame canvas.
    const poster = await post({ snapshot: face, sku: 'MVS-F-1824-BK' });
    expect(poster.status).toBe(200);
    expect(await sharp(poster.png).metadata()).toMatchObject({ width: 216, height: 288 });
    const expected = await sharp(poster.png).raw().toBuffer();
    for (const dimensionsArePrintArea of [false, true]) {
      viewport.mockClear();
      const canvas = await post({ snapshot: { ...face, dimensionsArePrintArea }, sku: 'MVS-C-1824-W',
        widthCm: 1, heightCm: 1 });
      expect(canvas.status).toBe(200);
      expect(await sharp(canvas.png).metadata()).toMatchObject({ width: 252, height: 324 });
      if (tiled) expect(viewport).toHaveBeenCalledTimes(2);
      else expect(viewport).toHaveBeenCalledWith(...(dimensionsArePrintArea ? [216, 288] : [252, 324]));
      const crop = await sharp(canvas.png).extract({ left: 18, top: 18, width: 216, height: 288 }).raw().toBuffer();
      // Cairo rounds a few gradient samples one level differently after translation.
      expect(crop.length).toBe(expected.length);
      expect(crop.every((channel, i) => Math.abs(channel - expected[i]) <= 1)).toBe(true);
    }
  });

  it('refuses a wrapped canvas sheet that would need tiling', async () => {
    const compute = renderDims.computeRenderDims;
    vi.spyOn(renderDims, 'computeRenderDims').mockImplementation((w, h, bounds) =>
      compute(w, h, bounds, { targetDpi: 12, minSinglePassDpi: 12, maxEdgePx: 400, maxPx: 48_000 }));
    const face = { ...snapshot, mapWidth: 216, mapHeight: 288, bounds: { west: -0.3, east: 0.3, north: 0.4, south: -0.4 } };
    const res = await post({ snapshot: face, sku: 'MVS-C-1824-W' });
    expect(res.status).toBe(500);
    expect(renderFrame).not.toHaveBeenCalled();
  });

  it('uses the tiled pipeline for a sheet above the single-pass ceiling', async () => {
    const result = await post({ snapshot: { ...snapshot, bounds: { west: -1, east: 1, south: -2, north: 2 } },
      widthCm: 2.54, heightCm: 5.08, detailedRoads: true, maxHeight: 80 });
    expect(result.status).toBe(200);
    expect(renderFrame).toHaveBeenCalledTimes(2);
    expect(loadStyle.mock.calls[0][0].layers[1].layout.visibility).toBe('visible');
    expect(await sharp(result.png).metadata()).toMatchObject({ width: 40, height: 80 });
  });

  it('reports the inline tile host and honours a single size override without enlarging', async () => {
    const result = await post({ snapshot: { ...snapshot, styleJson: { ...snapshot.styleJson,
      sources: {
        unused: { type: 'vector', url: '/unused' },
        base: { type: 'vector', tiles: ['https://basemaps.cartocdn.com/{z}/{x}/{y}.pbf'] },
      } } },
      heightCm: 1.27, maxHeight: 2400 });
    expect(result.status).toBe(200);
    expect(result.headers['x-proof-tile-host']).toBe('basemaps.cartocdn.com');
    expect(await sharp(result.png).metadata()).toMatchObject({ width: 200, height: 200 });
  });

  it('releases its slot after a native failure without exposing snapshot text', async () => {
    renderFrame.mockImplementationOnce((_w, _h, cb) => cb(new Error(snapshot.displayCity)));
    const failed = await post({ snapshot });
    expect(failed.status).toBe(500);
    expect(failed.png.toString()).not.toContain(snapshot.displayCity);
    expect((await post({ snapshot })).status).toBe(200);
  });

  it('rejects invalid PNG output before sending image headers', async () => {
    vi.spyOn(printPng, 'encodePrintPng').mockResolvedValueOnce(Buffer.from('invalid PNG'));
    const result = await post({ snapshot, maxHeight: 80 });
    expect(result.status).toBe(500);
    expect(result.headers['x-proof-mode']).toBeUndefined();
  });

  it('declines competing proofs while a render holds the slot', async () => {
    let finish!: () => void;
    const started = new Promise<void>(resolve => renderFrame.mockImplementationOnce((w, h, cb) => {
      finish = () => cb(null, Buffer.alloc(w * h * 4));
      resolve();
    }));
    const first = post({ snapshot });
    await started;
    try {
      expect((await post({ snapshot })).status).toBe(503);
      expect(renderFrame).toHaveBeenCalledTimes(1);
    } finally { finish(); }
    expect((await first).status).toBe(200);
  });

  it('limits authenticated requests to six per rolling minute', async () => {
    for (let i = 0; i < 6; i++) expect((await post({})).status).toBe(400);
    const limited = await post({ snapshot });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    time += 60_000;
    expect((await post({ snapshot })).status).toBe(200);
  });
});

it('returns the same full PNG bytes that a config order uploads', async () => {
  const proof = await post({ snapshot });
  expect(proof.status).toBe(200);
  expectNoOrderEffects();
  let deliverConfig!: (response: Response) => void;
  const configDownload = new Promise<Response>(resolve => { deliverConfig = resolve; });
  vi.mocked(fetch).mockReturnValueOnce(configDownload);
  vi.mocked(planFulfillment).mockResolvedValueOnce({ kind: 'accept', mode: 'legacy', needsRender: true, sku: null,
    callerProvider: 'gelato', resolvedProvider: 'gelato', gelatoProductUid: 'fixture', printfulVariantId: 1 });
  vi.mocked(put).mockResolvedValueOnce({ url: 'https://blob.invalid/poster.png' } as Awaited<ReturnType<typeof put>>);
  const ack = await post({ externalId: 'offline', recipient: {}, label: 'fixture', quantity: 1,
    configUrl: 'https://blob.invalid/snapshot.json' }, { 'x-api-key': key }, '/fulfill');
  expect(ack.status).toBe(202);
  try {
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await post({ snapshot })).status).toBe(503);
  } finally {
    deliverConfig(new Response(JSON.stringify({ snapshot })));
  }
  await vi.waitFor(() => expect(fulfillGelato).toHaveBeenCalledTimes(1));
  expect(vi.mocked(put).mock.calls[0][1]).toEqual(proof.png);
});
