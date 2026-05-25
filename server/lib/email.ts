// Transactional email via Resend's HTTP API. Raw fetch keeps this consistent
// with the other server-side third-party clients (sc-client, auth0) and avoids
// pulling in an SDK.
//
// Soft-fail by design: every caller invokes this *after* the entitlement is
// already granted, so a missing key or a Resend outage must never throw or
// abort activation. Returns whether the send went out so callers can log a
// "no email sent" warning for manual follow-up.

type Env = Record<string, string>

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

// Default sender. The domain must be verified in Resend; override per-env with
// EMAIL_FROM (e.g. "Ark+ <hello@ark-plus.xyz>").
const DEFAULT_FROM = 'Ark+ <hello@ark-plus.xyz>'

export async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; html: string },
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY unset — skipping send to', msg.to)
    return false
  }

  const from = env.EMAIL_FROM || DEFAULT_FROM
  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
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
