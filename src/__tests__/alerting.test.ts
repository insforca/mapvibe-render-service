/**
 * src/__tests__/alerting.test.ts
 *
 * Unit tests for notifyFulfillFail.
 * Mocks global fetch (webhook path) and the Resend SDK (email path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Resend SDK mock ───────────────────────────────────────────────────────────
const mockEmailsSend = vi.fn().mockResolvedValue({ data: { id: 're_mock' }, error: null });
vi.mock('resend', () => ({
  // Must be constructable (`new Resend(key)`) — an arrow-function mock throws
  // "is not a constructor". A plain function returning the stub works with `new`.
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send: mockEmailsSend } };
  }),
}));

import { notifyFulfillFail, notifyFulfillHeld } from '../alerting.js';

describe('notifyFulfillFail', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    mockEmailsSend.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.ALERT_WEBHOOK_URL;
    delete process.env.ALERT_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_FROM_EMAIL;
  });

  it('logs [FULFILL-FAIL] for an unmapped SKU and can POST the alert hook', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/sku';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notifyFulfillFail('order-sku', 'sku-unmapped', 'SKU MVS-100x150-SOLO is not in the catalogue');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('sku-unmapped'));
    await vi.runAllTimersAsync();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.event.reason).toBe('sku-unmapped');
    expect(body.event.externalId).toBe('order-sku');
    spy.mockRestore();
  });

  it('logs [FULFILL-FAIL] tag always', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notifyFulfillFail('order-001', 'gelato-api', 'timeout');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[FULFILL-FAIL]'),
    );
    spy.mockRestore();
  });

  it('does not call fetch when ALERT_WEBHOOK_URL is unset', async () => {
    notifyFulfillFail('order-002', 'printful-api', '500');
    await vi.runAllTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to ALERT_WEBHOOK_URL when set', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/test';
    notifyFulfillFail('order-003', 'gelato-api', '503');
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/test',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('webhook body contains externalId and reason', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/test';
    notifyFulfillFail('order-004', 'config-render', 'missing field');
    await vi.runAllTimersAsync();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.event.externalId).toBe('order-004');
    expect(body.event.reason).toBe('config-render');
  });

  it('does not send email when ALERT_EMAIL or RESEND_API_KEY is unset', async () => {
    notifyFulfillFail('order-005', 'gelato-api', 'error');
    await vi.runAllTimersAsync();
    expect(mockEmailsSend).not.toHaveBeenCalled();
  });

  it('sends email via Resend SDK when ALERT_EMAIL and RESEND_API_KEY are set', async () => {
    // Lazy client reads env at call time — no resetModules/dynamic import needed.
    process.env.ALERT_EMAIL    = 'hi@mapvibestudio.com';
    process.env.RESEND_API_KEY = 're_test_key';
    notifyFulfillFail('order-006', 'gelato-api', 'api error');
    await vi.runAllTimersAsync();
    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      ['hi@mapvibestudio.com'],
        subject: expect.stringContaining('[FULFILL-FAIL]'),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('idempotency key is deterministic for same externalId + reason', async () => {
    process.env.ALERT_EMAIL    = 'hi@mapvibestudio.com';
    process.env.RESEND_API_KEY = 're_test_key';
    notifyFulfillFail('order-007', 'printful-api', 'err1');
    notifyFulfillFail('order-007', 'printful-api', 'err2');  // same id+reason, different detail
    await vi.runAllTimersAsync();
    const keys = mockEmailsSend.mock.calls.map(
      (c: unknown[]) => (c[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);  // same id+reason → same key
  });

  it('truncates detail to 400 chars', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notifyFulfillFail('order-008', 'gelato-uncaught', 'x'.repeat(500));
    const logged = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(logged.replace('[FULFILL-FAIL] ', ''));
    expect(parsed.detail.length).toBe(400);
    spy.mockRestore();
  });

  it('sends identifier-only held alerts through both transports, with a key per order line', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/test';
    process.env.ALERT_EMAIL = 'alerts@example.test';
    process.env.RESEND_API_KEY = 'offline-test';
    notifyFulfillHeld('order-1', 'line-1');
    notifyFulfillHeld('order-1', 'line-2');
    notifyFulfillHeld('order-1', 'line-1');
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockEmailsSend).toHaveBeenCalledTimes(3);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toEqual({
      externalId: 'order-1', lineItem: 'line-1', reason: 'dispatch-held',
      detail: 'Order was NOT sent to the vendor. Re-trigger this order line after FULFILL_DRY_RUN is set back to false.',
      at: expect.any(String),
    });
    const mail = mockEmailsSend.mock.calls[0][0];
    expect(mail.subject).toBe('[dispatch-held] Order order-1, line line-1: NOT sent to vendor; re-trigger after FULFILL_DRY_RUN=false');
    expect(body.text).toContain(mail.subject);
    expect(mail.html).toContain(body.event.detail);
    expect(mail.html).toContain('line-1');
    const keys = mockEmailsSend.mock.calls.map(call => call[1].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
  });
});
