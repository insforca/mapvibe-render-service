/**
 * src/alerting.ts
 *
 * [FULFILL-FAIL] structured tag + optional ALERT_WEBHOOK_URL hook for
 * terminal failures in /fulfill async paths (after the 202 ACK, when
 * the caller is gone).
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
  if (!ALERT_WEBHOOK_URL) return;

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
