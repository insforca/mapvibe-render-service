/**
 * Fulfill-path failure: a rejected route must call notifyFulfillFail.
 * Email stays best-effort. The detail must name the order, the place,
 * and the old route, and must not carry the style payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEmailsSend = vi.fn().mockResolvedValue({ data: { id: 're_mock' }, error: null });
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send: mockEmailsSend } };
  }),
}));

import { resolveFulfillRoute } from '../detail-routing.js';
import { notifyRejectedFulfillRoute } from '../style-fail.js';

const BOUNDS = { west: -9.2, south: 38.7, east: -9.1, north: 38.8 };

describe('notifyRejectedFulfillRoute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockEmailsSend.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ALERT_WEBHOOK_URL;
    delete process.env.ALERT_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_FROM_EMAIL;
  });

  it('logs [FULFILL-FAIL] missing-style with city, style state, and the old route', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const route = resolveFulfillRoute(
      {
        styleJson: { layers: [], token: 'sk_live_should_not_appear' },
        minorRoads: true,
        bounds: BOUNDS,
      },
      undefined,
    );
    expect(route.engine).toBe('rejected');
    if (route.engine !== 'rejected') return;

    notifyRejectedFulfillRoute(route, {
      externalId: 'shopify-1086-MVS-P-1824',
      city: 'Lisbon',
      country: 'Portugal',
    });

    const logged = String(spy.mock.calls[0][0]);
    expect(logged.startsWith('[FULFILL-FAIL] ')).toBe(true);
    const event = JSON.parse(logged.slice('[FULFILL-FAIL] '.length)) as { reason: string; detail: string };
    const detail = JSON.parse(event.detail) as Record<string, string>;
    expect(event.reason).toBe('missing-style');
    expect(detail.externalId).toBe('shopify-1086-MVS-P-1824');
    expect(detail.city).toBe('Lisbon');
    expect(detail.country).toBe('Portugal');
    expect(detail.formerRoute).toBe('detailed-osm-no-style');
    expect(detail.styleState).toBe('empty');
    expect(JSON.stringify(detail)).not.toContain('sk_live_should_not_appear');
    spy.mockRestore();
  });

  it('emails via Resend when ALERT_EMAIL and RESEND_API_KEY are set', async () => {
    process.env.ALERT_EMAIL = 'hi@mapvibestudio.com';
    process.env.RESEND_API_KEY = 're_test_key';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const route = resolveFulfillRoute({ engine: 'osm', styleJson: { layers: [{ id: 'bg' }] } }, undefined);
    expect(route.engine).toBe('rejected');
    if (route.engine !== 'rejected') return;

    notifyRejectedFulfillRoute(route, { externalId: 'order-osm', city: 'Austin' });
    await vi.runAllTimersAsync();

    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['hi@mapvibestudio.com'],
        subject: expect.stringContaining('osm-engine-retired'),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    const html = String(mockEmailsSend.mock.calls[0][0].html);
    expect(html).toContain('order-osm');
    expect(html).toContain('cfg-engine-osm');
    expect(html).toContain('Austin');
    expect(html).not.toContain('re_test_key');
    spy.mockRestore();
  });

  it('still records the failure when email env is missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const route = resolveFulfillRoute({ minorRoads: true, bounds: BOUNDS }, 'osm');
    expect(route.engine).toBe('rejected');
    if (route.engine !== 'rejected') return;

    notifyRejectedFulfillRoute(route, { externalId: 'order-no-email' });
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('missing-style'));
    expect(spy.mock.calls[0][0]).toContain('env-osm-legacy-config');
    expect(mockEmailsSend).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
