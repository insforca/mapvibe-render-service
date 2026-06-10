/**
 * src/alerting.ts
 *
 * [FULFILL-FAIL] structured tag + optional ALERT_WEBHOOK_URL or
 * ALERT_EMAIL (via Resend) hook for terminal failures in /fulfill
 * async paths (after the 202 ACK, when the caller is gone).
 *
 * Env vars (all optional):
 *   ALERT_WEBHOOK_URL  — HTTP POST target (Slack, n8n, Zapier, etc.)
 *   ALERT_EMAIL        — destination email address (e.g. hi@mapvibestudio.com)
 *   RESEND_API_KEY     — Resend API key; required when ALERT_EMAIL is set
 *   ALERT_FROM_EMAIL   — sender address (default: alerts@mapvibestudio.com)
 *
 * Matches mapvibe-studio PR #139's tag exactly so a single log-drain
 * pattern catches both repos.
 */

export type FulfillFailReason =
  | 'config-render'
  | 'missing-gelato-uid'
  | 'gelato-api'
  | 'gelato-uncaught'
  | 'printful-api'
  | 'printful-uncaught';

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
  const ALERT_EMAIL        = process.env.ALERT_EMAIL        ?? '';
  const RESEND_API_KEY     = process.env.RESEND_API_KEY     ?? '';
  const ALERT_FROM_EMAIL   = process.env.ALERT_FROM_EMAIL   ?? 'alerts@mapvibestudio.com';

  // ── Webhook (Slack, n8n, Zapier, custom) ──────────────────────────────────
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

  // ── Email via Resend ───────────────────────────────────────────────────────
  if (ALERT_EMAIL && RESEND_API_KEY) {
    void (async () => {
      try {
        await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from:    `MapVibe Alerts <${ALERT_FROM_EMAIL}>`,
            to:      [ALERT_EMAIL],
            subject: `[FULFILL-FAIL] Order ${externalId} — ${reason}`,
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
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Email sending is best-effort; non-fatal.
      }
    })();
  }
}
