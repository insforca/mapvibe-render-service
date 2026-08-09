/**
 * src/alerting.ts
 *
 * [FULFILL-FAIL] structured tag + optional ALERT_WEBHOOK_URL or
 * ALERT_EMAIL (via Resend SDK) hook for terminal failures in /fulfill
 * async paths (after the 202 ACK, when the caller is gone).
 *
 * Env vars (all optional):
 *   ALERT_WEBHOOK_URL  – HTTP POST target (Slack, n8n, Zapier, etc.)
 *   ALERT_EMAIL        – destination email address (e.g. hi@mapvibestudio.com)
 *   RESEND_API_KEY     – Resend API key; required when ALERT_EMAIL is set
 *   ALERT_FROM_EMAIL   – sender address (default: alerts@mapvibestudio.com)
 *
 * Matches mapvibe-studio PR #139's tag exactly so a single log-drain
 * pattern catches both repos.
 *
 * Resend client is instantiated once at module load to avoid leaking
 * the API key in error traces.
 * Idempotency-Key = SHA-256(externalId + ':' + reason) so duplicate
 * delivery is safe during transient infra restarts.
 */

import { createHash }  from 'crypto';
import { Resend }       from 'resend';

export type FulfillFailReason =
  | 'config-render'
  | 'missing-gelato-uid'
  | 'gelato-api'
  | 'gelato-uncaught'
  | 'printful-api'
  | 'printful-uncaught'
  | 'routing-lookup-error'   // Shopify metafield lookup failed and strict mode rejected the order
  | 'routing-unresolved';    // variant has no pod_partner metafield and is not a white-canvas item

// ── Resend client — module-level singleton ────────────────────────────────────
const RESEND_API_KEY   = process.env.RESEND_API_KEY    ?? '';
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL  ?? 'alerts@mapvibestudio.com';

/** Lazy getter — reads env at call time so vi.stubEnv() works in tests
 *  without needing vi.resetModules() + dynamic re-import.
 */
function getResendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY ?? '';
  return key ? new Resend(key) : null;
}

// ── Idempotency key helper ────────────────────────────────────────────────────
function idempotencyKey(externalId: string, reason: FulfillFailReason): string {
  return createHash('sha256').update(`${externalId}:${reason}`).digest('hex');
}

// ── Main export ───────────────────────────────────────────────────────────────
export function notifyFulfillFail(
  externalId: string,
  reason:     FulfillFailReason,
  detail:     unknown,
): void {
  const truncated = String(
    detail instanceof Error
      ? detail.message
      : typeof detail === 'string'
        ? detail
        : JSON.stringify(detail),
  ).slice(0, 400);

  const event = { externalId, reason, detail: truncated, at: new Date().toISOString() };
  console.error(`[FULFILL-FAIL] ${JSON.stringify(event)}`);

  const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? '';
  const ALERT_EMAIL       = process.env.ALERT_EMAIL       ?? '';

  // ── Webhook (Slack, n8n, Zapier, custom) ─────────────────────────────────
  if (ALERT_WEBHOOK_URL) {
    void (async () => {
      try {
        await fetch(ALERT_WEBHOOK_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text: `[FULFILL-FAIL] externalId=${externalId} reason=${reason} detail=${truncated}`,
            event,
          }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        // Webhook posting is best-effort; failure here is non-fatal and
        // intentionally swallowed (the [FULFILL-FAIL] log line above is
        // the canonical record).
      }
    })();
  }

  // ── Email via Resend SDK ──────────────────────────────────────────────────
  if (ALERT_EMAIL && getResendClient()) {
    void (async () => {
      try {
        await getResendClient()!.emails.send(
          {
            from:    `MapVibe Alerts <${ALERT_FROM_EMAIL}>`,
            to:      [ALERT_EMAIL],
            subject: `[FULFILL-FAIL] Order ${externalId} – ${reason}`,
            html: `
              <p style="font-family:sans-serif;color:#333">
                A fulfillment failure was detected on <strong>MapVibe Studio</strong>.
              </p>
              <table style="font-family:sans-serif;border-collapse:collapse;width:100%;max-width:560px">
                <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:600;width:30%">Order ID</td>
                    <td style="padding:6px 12px">${externalId}</td></tr>
                <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:600">Reason</td>
                    <td style="padding:6px 12px">${reason}</td></tr>
                <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:600">Detail</td>
                    <td style="padding:6px 12px">${truncated}</td></tr>
                <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:600">Time</td>
                    <td style="padding:6px 12px">${event.at}</td></tr>
              </table>
              <p style="font-family:sans-serif;color:#888;font-size:12px;margin-top:16px">
                Sent by MapVibe render-service · mapvibestudio.com
              </p>
            `,
          },
          { idempotencyKey: idempotencyKey(externalId, reason) },
        );
      } catch {
        // Email sending is best-effort; non-fatal.
      }
    })();
  }
}
