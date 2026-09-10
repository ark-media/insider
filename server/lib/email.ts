// Transactional email via Resend's HTTP API. Raw fetch keeps this consistent
// with the other server-side third-party clients (beehiiv, circle, auth0) and avoids
// pulling in an SDK.
//
// Soft-fail by design: every caller invokes this *after* the entitlement is
// already granted, so a missing key or a Resend outage must never throw or
// abort activation. Returns whether the send went out so callers can log a
// "no email sent" warning for manual follow-up.

type Env = Record<string, string>

import { fetchWithTimeout } from './http.js'
import { redactEmail } from "../../shared/validation.js"

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

// Default sender. The domain must be verified in Resend; override per-env with
// EMAIL_FROM (e.g. "Ark+ <hello@ark-plus.xyz>").
const DEFAULT_FROM = 'Ark+ <hello@ark-plus.xyz>'

export async function sendEmail(
  env: Env,
  msg: {
    to: string
    subject: string
    html: string
    replyTo?: string
    // A stable key for a logical send (e.g. `welcome_<subId>`). Passed to Resend
    // as `Idempotency-Key` so two racing callers on different instances — or a
    // webhook retry — collapse to a single delivery for ~24h, rather than each
    // sending its own copy.
    idempotencyKey?: string
  },
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY unset — skipping send to', redactEmail(msg.to))
    return false
  }

  const from = env.EMAIL_FROM || DEFAULT_FROM
  try {
    const r = await fetchWithTimeout(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        // Lets the team reply straight to the original sender (e.g. a contact
        // form submitter) instead of to the verified `from` address.
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    })
    if (!r.ok) {
      console.error('[email] resend send failed:', r.status, await r.text())
      return false
    }
    return true
  } catch (err) {
    console.error('[email] resend send threw:', err)
    return false
  }
}
