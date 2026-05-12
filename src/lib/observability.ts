// ---------------------------------------------------------------------------
// Observability bootstrap — Sentry (errors + traces) and PostHog (product
// analytics + session replay + flags). Wired once from main.tsx before
// React renders, so even crashes during the first paint get captured.
//
// Both SDKs are no-ops when their respective DSN/key env vars are missing,
// so local dev without keys still boots cleanly.
//
// Privacy posture:
//   - PostHog session replay defaults to ALL text and inputs masked. Reveal
//     specific elements with `data-ph-mask="false"` (or remove `mask_all_text`
//     globally if you decide the trade-off later). Stripe Elements render in
//     a cross-origin iframe so they're naturally outside replay scope.
//   - Emails sent to PostHog are SHA-256-hashed in the browser. PostHog
//     never sees the plaintext address. Sentry continues to receive the
//     real email because it's the support-debugging channel and stays in
//     a per-org backend, not a public dashboard.
//   - Tier is sent as a person property so funnels can segment subscriber
//     vs free without sending tier on every event.
// ---------------------------------------------------------------------------

import * as Sentry from '@sentry/react'
import posthog from 'posthog-js'

let posthogReady = false

export function initObservability() {
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
      replaysSessionSampleRate: 0, // PostHog handles replay; avoid double-recording
      replaysOnErrorSampleRate: 0,
      integrations: [Sentry.browserTracingIntegration()],
      // Don't capture noise from extensions / cross-origin scripts.
      ignoreErrors: ['ResizeObserver loop limit exceeded', 'Non-Error promise rejection captured'],
    })
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY
  const posthogHost = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'
  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      capture_pageview: 'history_change',
      person_profiles: 'identified_only',
      // mask_all_text + maskAllInputs is the safe default. Reveal specific
      // elements by setting `data-ph-mask="false"` on the node.
      mask_all_text: true,
      session_recording: { maskAllInputs: true },
    })
    posthogReady = true
  }
}

// SHA-256 hex digest. PostHog gets the hash, never the plaintext email.
async function hashEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function identifyUser(opts: {
  id: string
  email?: string
  tier?: 'subscriber' | 'free'
}) {
  Sentry.setUser({ id: opts.id, email: opts.email })
  if (!posthogReady) return
  const properties: Record<string, unknown> = { tier: opts.tier ?? 'free' }
  if (opts.email) {
    // Hash is async; identify with id+tier immediately, then patch in the
    // hashed email as a person property when ready. PostHog merges by
    // distinct_id so the second call is a no-op-with-update.
    void hashEmail(opts.email).then((hash) => {
      posthog.identify(opts.id, { ...properties, email_sha256: hash })
    })
  } else {
    posthog.identify(opts.id, properties)
  }
  if (opts.tier) posthog.group('tier', opts.tier)
}

export function resetIdentity() {
  Sentry.setUser(null)
  if (posthogReady) posthog.reset()
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (posthogReady) posthog.capture(event, properties)
}
