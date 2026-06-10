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
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockEmailsSend },
  })),
}));

import { notifyFulfillFail } from '../alerting.js';

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
    process.env.ALERT_EMAIL     = 'hi@mapvibestudio.com';
    process.env.RESEND_API_KEY  = 're_test_key';
    // Re-import to pick up new env (Resend client is module-level)
    vi.resetModules();
    const { notifyFulfillFail: notify2 } = await import('../alerting.js?v=2');
    notify2('order-006', 'gelato-api', 'api error');
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
    process.env.ALERT_EMAIL     = 'hi@mapvibestudio.com';
    process.env.RESEND_API_KEY  = 're_test_key';
    vi.resetModules();
    const { notifyFulfillFail: n } = await import('../alerting.js?v=3');
    n('order-007', 'printful-api', 'err1');
    n('order-007', 'printful-api', 'err2');  // same id+reason, different detail
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
})';
