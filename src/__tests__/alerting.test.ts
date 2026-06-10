import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyFulfillFail } from '../alerting.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notifyFulfillFail — log tag', () => {
  it('emits a [FULFILL-FAIL] line with JSON event payload', () => {
    notifyFulfillFail('mvb-1234', 'gelato-api', { http: 502 });
    expect(console.error).toHaveBeenCalled();
    const call = (console.error as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^\[FULFILL-FAIL\] /);
    const json = JSON.parse(call.replace('[FULFILL-FAIL] ', ''));
    expect(json.externalId).toBe('mvb-1234');
    expect(json.reason).toBe('gelato-api');
    expect(json.detail).toMatch(/502/);
    expect(typeof json.at).toBe('string');
  });

  it('truncates detail strings to 400 chars', () => {
    const big = 'x'.repeat(2000);
    notifyFulfillFail('mvb-truncate', 'printful-api', big);
    const call = (console.error as any).mock.calls[0][0] as string;
    const json = JSON.parse(call.replace('[FULFILL-FAIL] ', ''));
    expect(json.detail.length).toBe(400);
  });

  it('handles Error instances by reading .message', () => {
    notifyFulfillFail('mvb-err', 'gelato-uncaught', new Error('boom'));
    const call = (console.error as any).mock.calls[0][0] as string;
    expect(call).toMatch(/"detail":"boom"/);
  });
});

describe('notifyFulfillFail — ALERT_WEBHOOK_URL hook', () => {
  it('does NOT call fetch when ALERT_WEBHOOK_URL is unset (default-safe)', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    notifyFulfillFail('mvb-no-webhook', 'config-render', 'render returned null');
    // Give the void IIFE a tick to schedule
    await new Promise(r => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs { text, event } to ALERT_WEBHOOK_URL when set', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://example.test/hook');
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    notifyFulfillFail('mvb-webhook', 'missing-gelato-uid', 'No UID');
    await new Promise(r => setImmediate(r));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const url  = call[0];
    const init = call[1];
    expect(url).toBe('https://example.test/hook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.text).toMatch(/^\[FULFILL-FAIL\]/);
    expect(body.text).toMatch(/missing-gelato-uid/);
    expect(body.event.externalId).toBe('mvb-webhook');
  });

  it('swallows webhook errors (fire-and-forget)', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://example.test/hook');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));

    // Must not throw — webhook failure is non-fatal
    expect(() => notifyFulfillFail('mvb-x', 'printful-uncaught', 'x')).not.toThrow();
    await new Promise(r => setImmediate(r));
  });
});
