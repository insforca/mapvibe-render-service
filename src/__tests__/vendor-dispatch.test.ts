import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fulfillGelato } from '../gelato.js';
import {
  _clearCatalogCacheForTests, findExistingPrintfulOrder, fulfillPrintful,
  resolveCatalogPlacement, resolveExternalId, tryUpdateExistingOrder,
} from '../printful.js';
import { DispatchHeldError, warnIfDispatchHeld } from '../vendor-dispatch.js';
import { rejectHeldFulfillment } from '../fulfill-dispatch.js';
import type { Response as ExpressResponse } from 'express';

// Exercise the actual alert path with only its transport replaced.
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn().mockResolvedValue({}) }));
vi.mock('resend', () => ({ Resend: vi.fn().mockImplementation(function () {
  return { emails: { send: sendEmail } };
}) }));
const headers = { Authorization: 'Bearer offline-test' };
const context = { vendor: 'printful' as const, orderId: 'order-1', lineItem: '999' };
const held = { status: 'held', shipped: false, retryable: true };
const recipient = { name: 'PRIVATE NAME', address1: 'PRIVATE ADDRESS', email: 'PRIVATE EMAIL' };
const run = (confirm = false) => fulfillPrintful('order-1', recipient, 999, 1,
  'PRIVATE LABEL', 'https://blob.test/file.png', confirm, headers);
const existing = (status: string, external_id = 'order-1') =>
  ({ data: [{ id: 123, external_id, status }] });
type Step = { path: string; method?: string; body?: unknown; status?: number };
const lookup: Step = { path: '/orders?external_id=order-1', body: { data: [] } };
const catalog: Step[] = [
  { path: '/v2/catalog-variants/999', body: { data: { catalog_product_id: 1 } } },
  { path: '/v2/catalog-products/1', body: { data: { placements: [{ placement: 'front', technique: 'PRINTING' }] } } },
];
const scenarios: { name: string; steps: Step[]; confirm?: boolean }[] = [
  { name: 'create v2 / v1 fallback / duplicate-race lookup', steps: [lookup, lookup, ...catalog,
    { path: '/v2/orders', method: 'POST', status: 400 },
    { path: '/orders', method: 'POST', status: 400, body: { error: { message: 'duplicate' } } }, lookup] },
  { name: 'existing draft update and confirm', confirm: true, steps: [
    { ...lookup, body: existing('draft') }, { path: '/orders/123', method: 'PUT' },
    { path: '/orders/123/confirm', method: 'POST' }] },
  { name: 'failed pending update and cancellation', steps: [
    { ...lookup, body: existing('pending') }, { path: '/orders/123', method: 'PUT', status: 400 },
    { path: '/orders/123', method: 'DELETE' }, { ...lookup, body: existing('pending') }] },
  { name: 'terminal suffix retry', steps: [
    { ...lookup, body: existing('canceled') }, { ...lookup, body: existing('canceled') },
    { path: '/orders?external_id=order-1-r2', body: { data: [] } }, ...catalog,
    { path: '/v2/orders', method: 'POST', body: { data: { id: 456 } } }] },
];

beforeEach(() => {
  sendEmail.mockClear();
  vi.stubEnv('ALERT_WEBHOOK_URL', '');
  vi.stubEnv('ALERT_EMAIL', 'alerts@example.test');
  vi.stubEnv('RESEND_API_KEY', 'offline-test');
  vi.stubEnv('ALERT_FROM_EMAIL', 'sender@example.test');
  vi.stubEnv('FULFILL_DRY_RUN', 'false');
  vi.stubEnv('GELATO_API_KEY', 'offline-test');
  _clearCatalogCacheForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Fail closed even if a test forgets to install its adapter.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected HTTP in offline test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('all public vendor entry paths are held', () => {
  it('rechecks Gelato immediately before HTTP if the flag changes during payload construction', async () => {
    const adapter = vi.fn();
    vi.stubGlobal('fetch', adapter);
    const address = {
      get name() {
        vi.stubEnv('FULFILL_DRY_RUN', 'true');
        return 'PRIVATE NAME';
      },
      address1: 'PRIVATE ADDRESS',
    };
    expect(await fulfillGelato('order-1', address, 'uid', 1, 'PRIVATE LABEL', 'https://blob.test/file.png'))
      .toEqual(held);
    expect(adapter).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain('dispatch-held');
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE');
  });

  it('holds Gelato, then resumes on the same import with a real order type', async () => {
    const adapter = vi.fn(async () => new Response('{"id":"test"}'));
    vi.stubGlobal('fetch', adapter);
    vi.stubEnv('FULFILL_DRY_RUN', 'TRUE');
    expect(await fulfillGelato('order-1', recipient, 'uid', 1, 'PRIVATE LABEL', 'https://blob.test/file.png')).toEqual(held);
    expect(adapter).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[DRY-RUN] held'));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE');
    vi.stubEnv('FULFILL_DRY_RUN', 'false');
    expect(await fulfillGelato('order-1', recipient, 'uid', 1, 'label', 'https://blob.test/file.png')).toEqual({ status: 'submitted' });
    expect(sendEmail).toHaveBeenCalledTimes(1); // Resume adds no held alert.
    expect(JSON.parse(String((adapter.mock.calls[0] as unknown as [string, RequestInit])[1].body)).orderType).toBe('order');
  });

  it.each([
    ['catalog', () => resolveCatalogPlacement(999, headers, context)],
    ['discovery', () => findExistingPrintfulOrder('order-1', '999')],
    ['suffix retries', () => resolveExternalId('order-1', '999')],
    ['existing update', () => tryUpdateExistingOrder('order-1', 'https://blob.test/file.png', 999, 1, 'PRIVATE LABEL', true, headers)],
  ] as const)('holds standalone %s without swallowing the signal', async (_name, call) => {
    vi.stubEnv('FULFILL_DRY_RUN', 'true');
    await expect(call()).rejects.toMatchObject({ name: 'DispatchHeldError', result: held });
    expect(fetch).not.toHaveBeenCalled();
  });
});

for (const scenario of scenarios) {
  describe(scenario.name, () => {
    it('preserves the full HTTP sequence with the pause disabled', async () => {
      const adapter = vi.fn(async (url: string, init?: RequestInit) => {
        const step = scenario.steps[adapter.mock.calls.length - 1];
        expect(new URL(url).pathname + new URL(url).search).toBe(step.path);
        expect(init?.method ?? 'GET').toBe(step.method ?? 'GET');
        return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
      });
      vi.stubGlobal('fetch', adapter);
      const expected = scenario.name.startsWith('create') ? 'failed'
        : scenario.name.startsWith('existing') ? 'updated'
        : scenario.name.startsWith('failed') ? 'skipped' : 'submitted';
      expect(await run(scenario.confirm)).toEqual({ status: expected });
      expect(adapter).toHaveBeenCalledTimes(scenario.steps.length);
      expect(sendEmail.mock.calls.filter(([mail]) => mail.subject.includes('dispatch-held'))).toHaveLength(0);
    });
    // Pause before EACH HTTP boundary, including after an earlier request completed.
    it.each(scenario.steps.map((step, index) => [index, step.path] as const))(
      'stops before request %i %s, with zero HTTP calls after pause', async (stopBefore) => {
        if (stopBefore === 0) vi.stubEnv('FULFILL_DRY_RUN', 'true');
        const adapter = vi.fn(async (url: string, init?: RequestInit) => {
          const index = adapter.mock.calls.length - 1;
          const step = scenario.steps[index];
          expect(new URL(url).pathname + new URL(url).search).toBe(step.path);
          expect(init?.method ?? 'GET').toBe(step.method ?? 'GET');
          if (index + 1 === stopBefore) vi.stubEnv('FULFILL_DRY_RUN', 'true');
          return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
        });
        vi.stubGlobal('fetch', adapter);
        expect(await run(scenario.confirm)).toEqual(held);
        expect(adapter).toHaveBeenCalledTimes(stopBefore);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].subject).toContain('Order order-1, line 999');
        expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('PRIVATE');
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls.filter(c => String(c[0]).includes('[DRY-RUN]')))).not.toContain('PRIVATE');
      },
    );
  });
}

it('does not cache a catalog fallback caused by a hold; clearing the flag permits retry', async () => {
  vi.stubEnv('FULFILL_DRY_RUN', 'true');
  await expect(resolveCatalogPlacement(999, headers, context)).rejects.toBeInstanceOf(DispatchHeldError);
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv('FULFILL_DRY_RUN', 'false');
  const adapter = vi.fn(async () => new Response(JSON.stringify(catalog[adapter.mock.calls.length - 1].body)));
  vi.stubGlobal('fetch', adapter);
  expect(await resolveCatalogPlacement(999, headers, context)).toEqual({ placement: 'front', technique: 'PRINTING' });
  expect(adapter).toHaveBeenCalledTimes(2);
});

it.each([false, true])('preserves confirm=%s in both create payloads when dispatch allowed', async (confirm) => {
  const steps = [lookup, lookup, ...catalog,
    { path: '/v2/orders', status: 400 }, { path: '/orders', body: { result: { id: 456 } } }];
  const adapter = vi.fn(async () => {
    const step = steps[adapter.mock.calls.length - 1];
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
  });
  vi.stubGlobal('fetch', adapter);
  expect(await run(confirm)).toEqual({ status: 'submitted' });
  expect(adapter).toHaveBeenCalledTimes(6);
  for (const index of [4, 5]) {
    const [url, init] = adapter.mock.calls[index] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe(index === 4 ? '/v2/orders' : '/orders');
    expect(JSON.parse(String(init.body)).confirm).toBe(confirm);
  }
});

it('warns at startup only while dispatch is held', () => {
  warnIfDispatchHeld();
  expect(console.warn).not.toHaveBeenCalled();
  vi.stubEnv('FULFILL_DRY_RUN', 'true');
  warnIfDispatchHeld();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
});

it.each([true, false])('sync ingress pause=%s alerts once with 503 or continues without alert', (paused) => {
  vi.stubEnv('FULFILL_DRY_RUN', String(paused));
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  expect(rejectHeldFulfillment(context, res as unknown as ExpressResponse)).toBe(paused);
  expect(sendEmail).toHaveBeenCalledTimes(paused ? 1 : 0);
  expect(fetch).not.toHaveBeenCalled();
  if (paused) {
    expect(res.status).toHaveBeenCalledExactlyOnceWith(503);
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ ...held, success: false, accepted: false, externalId: 'order-1' });
  } else {
    expect(res.status).not.toHaveBeenCalled();
  }
});

it('does not alert for an unpaused Gelato dispatch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"test"}')));
  expect(await fulfillGelato('order-1', recipient, 'uid', 1, 'PRIVATE LABEL', 'https://blob.test/file.png'))
    .toEqual({ status: 'submitted' });
  expect(sendEmail).not.toHaveBeenCalled();
});

it('keeps vendor HTTP confined to the shared boundary and rejects held ingress before 202', () => {
  for (const name of ['gelato.ts', 'printful.ts']) {
    const source = readFileSync(join(__dirname, '..', name), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toContain('vendorFetch(');
  }
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  expect(server).not.toMatch(/PRINTFUL_API_V[12]|GELATO_API_V4|api\.printful\.com|gelatoapis\.com/);
  const route = server.slice(server.indexOf("app.post('/fulfill'"));
  expect(route.indexOf('rejectHeldFulfillment(')).toBeGreaterThanOrEqual(0);
  expect(route.indexOf('rejectHeldFulfillment(')).toBeLessThan(route.indexOf('res.status(202)'));
  expect(route).toContain('}, res)) return;');
  expect(server).toContain('warnIfDispatchHeld();');
  expect(new DispatchHeldError().result).toEqual(held);
});
