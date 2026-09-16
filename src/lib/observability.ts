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
//   - Emails sent to PostHog are SHA-256-hashed in the browser — INCLUDING the
//     distinct_id, which is the hash itself rather than the address. (It was
//     previously the plaintext email, which quietly contradicted the paragraph
//     above and made every PostHog person record a piece of PII.) Sentry
//     continues to receive the real email because it's the support-debugging
//     channel and stays in a per-org backend, not a public dashboard.
//   - The same `email_sha256` is what the server-side revenue events key on
//     (server/lib/analytics-server.ts), so browser intent and server outcome
//     land on ONE person. It is also the universal join key across Beehiiv /
//     Circle / Stripe in the warehouse (BI plan §2.6).
//     Note it is pseudonymous, not anonymous — still an identifier.
//   - Tier is sent as a person property so funnels can segment subscriber
//     vs free without sending tier on every event.
//   - Acquisition attribution (src/lib/attribution.ts) is registered here as
//     super-properties, and set on the person at identify time: first-touch
//     with $set_once so it can never be overwritten, last-touch with $set.
// ---------------------------------------------------------------------------

import * as Sentry from '@sentry/react'
import posthog from 'posthog-js'
import { captureAttribution, getAttribution } from './attribution'
import { FIRST_TOUCH_KEYS, type Attribution } from '../../shared/attribution'

let posthogReady = false

// Query params that carry a bearer credential rather than navigation state.
// `mt` is the gift magic link: presenting it logs the holder in AS the recipient
// and redeems the gift, so a captured $current_url is an account takeover, not
// just a privacy leak.
const SENSITIVE_QUERY_KEYS = ['mt', 'token', 'session_id', 'code', 'state']

// Replace the value of any sensitive query param with a placeholder, preserving
// the rest of the URL so funnels still work. Non-string / unparseable input is
// passed through untouched.
export function redactSensitiveQuery(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const url = new URL(raw)
    let redacted = false
    for (const key of SENSITIVE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, 'redacted')
        redacted = true
      }
    }
    return redacted ? url.toString() : raw
  } catch {
    return raw
  }
}

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
      // Masking covers replay DOM text, NOT event properties — $current_url is
      // sent verbatim on every pageview. Some of our URLs carry bearer
      // credentials (see SENSITIVE_QUERY_KEYS), so redact before anything leaves
      // the browser rather than trusting a third party to hold them safely.
      sanitize_properties: (props) => ({
        ...props,
        $current_url: redactSensitiveQuery(props.$current_url),
        $referrer: redactSensitiveQuery(props.$referrer),
      }),
    })
    posthogReady = true
  }

  // Capture acquisition attribution regardless of whether PostHog is
  // configured — the checkout modals forward it into Stripe metadata, which is
  // how server-side revenue events get attributed, and that path must work even
  // in a build with no PostHog key.
  const captured = captureAttribution()
  if (captured) {
    superProperties = {
      ...captured.attribution,
      entry_page: captured.entryPage,
      is_returning: captured.isReturning,
    }
    registerSuperProperties()
  }
}

// The attribution super-properties, held here because posthog.reset() wipes the
// registered set and we have to put them back — see resetIdentity().
let superProperties: Record<string, unknown> | null = null

function registerSuperProperties() {
  if (posthogReady && superProperties) posthog.register(superProperties)
}

// SHA-256 hex digest. PostHog gets the hash, never the plaintext email.
async function hashEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Split captured attribution into the two PostHog person-property buckets:
// first-touch must never change once written ($set_once), last-touch always
// reflects the most recent session ($set).
function splitTouchProperties(attribution: Attribution): {
  set: Record<string, unknown>
  setOnce: Record<string, unknown>
} {
  const firstTouch: ReadonlySet<string> = new Set<string>(FIRST_TOUCH_KEYS)
  const set: Record<string, unknown> = {}
  const setOnce: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attribution)) {
    if (firstTouch.has(key)) setOnce[key] = value
    else set[key] = value
  }
  return { set, setOnce }
}

export function identifyUser(opts: {
  email: string
  // The member's SKU tier, widened to the three-tier vocabulary so funnels can
  // segment Ark+ vs Circle vs Bundle vs free.
  tier?: 'ark-plus' | 'circle' | 'bundle' | 'free'
}) {
  // Sentry keeps the real address on purpose — it's the support-debugging
  // channel, and a hash there would make a bug report untraceable to a member.
  Sentry.setUser({ id: opts.email, email: opts.email })
  if (!posthogReady) return
  const { set, setOnce } = splitTouchProperties(getAttribution())
  // The hash is async and IS the distinct_id, so there is nothing to identify
  // with until it resolves — unlike the previous version, which identified
  // immediately on the plaintext email and patched the hash in afterwards.
  void hashEmail(opts.email).then((hash) => {
    posthog.identify(
      hash,
      { ...set, tier: opts.tier ?? 'free', email_sha256: hash },
      setOnce,
    )
    if (opts.tier) posthog.group('tier', opts.tier)
  })
}

export function resetIdentity() {
  Sentry.setUser(null)
  if (!posthogReady) return
  posthog.reset()
  // posthog.reset() clears ALL registered super-properties, not just identity.
  // This runs on every guest page load (the auth provider calls it as soon as
  // the session resolves to "not signed in"), so without re-registering here the
  // attribution properties are wiped microseconds after init — and wiped for
  // exactly the population that matters most: the logged-out first-time visitor
  // who just arrived from a campaign. Verified in-browser; the properties were
  // absent from persistence and `$last_posthog_reset` was stamped at page load.
  registerSuperProperties()
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (posthogReady) posthog.capture(event, properties)
}
