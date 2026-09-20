// ---------------------------------------------------------------------------
// Observability bootstrap — Sentry (errors + traces) and PostHog (product
// analytics + session replay + flags). Wired once from main.tsx before
// React renders, so even crashes during the first paint get captured.
//
// Both SDKs are no-ops when their respective DSN/key env vars are missing,
// so local dev without keys still boots cleanly.
//
// Privacy posture:
//   - PostHog has TWO collectors that read the DOM, and each has its own
//     switches — one does not cover the other (this comment used to claim
//     `mask_all_text` masked replays; it never did):
//       * Autocapture (click/submit events): `mask_all_text` stops it sending
//         an element's textContent, `mask_all_element_attributes` stops it
//         sending attributes — without it a click on `<a href={privateFeedUrl}>`
//         ships the member's feed URL verbatim as `attr__href`.
//       * Session replay (rrweb): `session_recording.maskTextSelector: '*'`
//         masks ALL rendered text, `maskAllInputs` masks input values. There is
//         no per-element "unmask" attribute; to reveal something you would have
//         to narrow the selector, deliberately.
//     An element with the `ph-no-capture` class (or `data-ph-block`) is skipped
//     by BOTH: autocapture drops the event, replay swaps the subtree for a
//     placeholder, attributes included. FeedSetup uses it around anything that
//     renders or links a private feed URL.
//     Replay never runs at all on /account* and /admin* — see
//     pauseReplayIfSensitive below. Stripe Elements render in a cross-origin
//     iframe so they're naturally outside replay scope.
//   - Bearer credentials in URLs (`?mt=`, `?token=`, `?lt=` …) are kept out of
//     BOTH vendors three ways: main.tsx lifts them out of the address bar before
//     either SDK initialises (stashUrlCredentials), PostHog properties pass
//     through redactSensitiveQuery, and every Sentry breadcrumb / event /
//     transaction passes through scrubSentryPayload.
//   - Emails sent to PostHog are SHA-256-hashed in the browser — INCLUDING the
//     distinct_id, which is the hash itself rather than the address. Sentry
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
// `lt` is the same thing for lifecycle emails (/api/auth/email-login?lt=…).
// `email` is not a credential but it is plaintext PII that we promise PostHog
// never sees, and it rides in fetch URLs (/api/gift/status?id=…&email=…) that
// Sentry records as breadcrumbs and http.client spans.
const SENSITIVE_QUERY_KEYS = ['mt', 'token', 'lt', 'session_id', 'code', 'state', 'email']

// Matches `?key=value` / `&key=value` for the sensitive keys anywhere inside a
// longer string, so it also works on the shapes `new URL()` can't parse: a
// relative URL (Sentry's navigation breadcrumbs carry `from: '/redeem?mt=…'`),
// a bare query string (`http.query`), or a span description ("GET /api/…?…").
const SENSITIVE_QUERY_PATTERN = new RegExp(
  `([?&](?:${SENSITIVE_QUERY_KEYS.join('|')})=)[^&#\\s]*`,
  'gi',
)

// Replace the value of any sensitive query param with a placeholder, preserving
// the rest of the URL so funnels still work. Non-string input is passed through
// untouched; a string that isn't an absolute URL gets the in-text pattern.
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
    return raw.replace(SENSITIVE_QUERY_PATTERN, '$1redacted')
  }
}

// Sentry scrubber: walk a breadcrumb / event / transaction and redact sensitive
// query values in EVERY string it holds. Deliberately shape-agnostic rather
// than a list of known fields — the URL turns up as `request.url`, the Referer
// header, `breadcrumb.data.{from,to,url}`, `contexts.trace.data['url.full']`,
// each span's `description` and `data['http.url' | 'url.full' | 'http.query']`,
// and the SDK adds attribute names between minors. A missed field here is a
// live gift token in a third-party dashboard, so don't enumerate.
//
// Mutates in place and returns the same object (Sentry's hooks hand us objects
// it is about to serialise). Depth-capped and cycle-safe; only plain objects
// and arrays are descended into.
const SCRUB_MAX_DEPTH = 8

export function scrubSentryPayload<T>(payload: T): T {
  const seen = new WeakSet<object>()
  const scrubString = (value: string) => value.replace(SENSITIVE_QUERY_PATTERN, '$1redacted')
  const walk = (node: unknown, depth: number): void => {
    if (typeof node !== 'object' || node === null || depth > SCRUB_MAX_DEPTH) return
    if (seen.has(node)) return
    seen.add(node)
    const proto: unknown = Object.getPrototypeOf(node)
    if (!Array.isArray(node) && proto !== Object.prototype && proto !== null) return
    const bag = node as Record<string, unknown>
    for (const key of Object.keys(bag)) {
      const value = bag[key]
      if (typeof value === 'string') bag[key] = scrubString(value)
      else walk(value, depth + 1)
    }
  }
  walk(payload, 0)
  return payload
}

// ---------------------------------------------------------------------------
// Landing credentials — lifted out of the URL before anything can record it.
//
// Redaction hooks are a net, not a guarantee: Sentry's browserTracingIntegration
// reads `location.href` synchronously inside Sentry.init() (the pageload span's
// `url.full`, the request context), long before React mounts and /redeem gets a
// chance to tidy its own address bar — and the `history.replaceState` that tidy
// used was itself recorded as a navigation breadcrumb with
// `from: '/redeem?mt=…'`. So main.tsx calls stashUrlCredentials() BEFORE
// initObservability(): by the time either SDK looks, the URL is already clean,
// and /redeem reads the values from here instead.
//
//   mt    — memory only. One-click claim, no sign-in round trip; a reload loses
//           it and the recipient re-opens the email link (same as before).
//   token — the legacy claim token needs a signed-in session, so a guest leaves
//           for Auth0 and comes back to /redeem. `returnTo` is built from the
//           (now clean) address bar, so the token has to survive that trip
//           somewhere else: sessionStorage — per-tab, gone when the tab closes,
//           cleared on a finished claim. If sessionStorage is unavailable the
//           token is left in the URL: a working gift beats a tidy URL, and the
//           redaction hooks above still cover it.
// ---------------------------------------------------------------------------

type LandingCredentialKey = 'mt' | 'token'

const GIFT_TOKEN_STORAGE_KEY = 'ark_gift_claim_token'
const landingCredentials: Partial<Record<LandingCredentialKey, string>> = {}

function persistGiftToken(token: string): boolean {
  try {
    window.sessionStorage.setItem(GIFT_TOKEN_STORAGE_KEY, token)
    return true
  } catch {
    return false
  }
}

// Only /redeem takes these params. `token` in particular is too generic a name
// to strip site-wide.
export function stashUrlCredentials(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname !== '/redeem') return
  const url = new URL(window.location.href)
  let changed = false

  const mt = url.searchParams.get('mt')
  if (mt) {
    landingCredentials.mt = mt
    url.searchParams.delete('mt')
    changed = true
  }

  const token = url.searchParams.get('token')
  if (token) {
    landingCredentials.token = token
    if (persistGiftToken(token)) {
      url.searchParams.delete('token')
      changed = true
    }
  }

  if (changed) {
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }
}

export function getLandingCredential(key: LandingCredentialKey): string | undefined {
  const held = landingCredentials[key]
  if (held || key !== 'token') return held
  try {
    return window.sessionStorage.getItem(GIFT_TOKEN_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

// Called once a claim has reached an outcome retrying can't change, so a spent
// credential doesn't resurface the claim UI on a later visit to /redeem.
export function clearLandingCredentials(): void {
  delete landingCredentials.mt
  delete landingCredentials.token
  try {
    window.sessionStorage.removeItem(GIFT_TOKEN_STORAGE_KEY)
  } catch {
    // Nothing was stored there either, then.
  }
}

// ---------------------------------------------------------------------------
// Session replay is OFF on the most sensitive surfaces. Masking hides text, but
// a replay of /account still shows the shape of someone's billing, and /admin
// shows member records — neither is worth having in a third-party tool at all.
//
// Driven by router events from main.tsx, in two halves on purpose:
//   - pause on `onBeforeLoad`, i.e. BEFORE the sensitive route renders;
//   - resume on `onRendered`, i.e. only once the NEXT page has replaced it.
//     TanStack pushes the new URL first and renders after (possibly after a
//     lazy chunk loads), and rrweb opens every recording with a full snapshot
//     of whatever is on screen — resuming on the URL change would snapshot the
//     /account DOM we just left.
// ---------------------------------------------------------------------------

const REPLAY_BLOCKED_PREFIXES = ['/account', '/admin']

export function isReplayBlockedPath(pathname: string): boolean {
  return REPLAY_BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

let replayPaused = false

export function pauseReplayIfSensitive(pathname: string): void {
  if (!posthogReady || replayPaused || !isReplayBlockedPath(pathname)) return
  posthog.stopSessionRecording()
  replayPaused = true
}

export function resumeReplayIfSafe(pathname: string): void {
  if (!posthogReady || !replayPaused || isReplayBlockedPath(pathname)) return
  // No override argument: sampling / triggers configured in the PostHog project
  // still decide whether this session records at all.
  posthog.startSessionRecording()
  replayPaused = false
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
      integrations: [
        Sentry.browserTracingIntegration({
          // Span names are pathnames today, but the attributes aren't ours to
          // predict — scrub at creation too, so a credential never sits on a
          // live span waiting for the send-time hooks below.
          beforeStartSpan: (options) => scrubSentryPayload(options),
        }),
      ],
      // Don't capture noise from extensions / cross-origin scripts.
      ignoreErrors: ['ResizeObserver loop limit exceeded', 'Non-Error promise rejection captured'],
      // Sentry has no equivalent of PostHog's sanitize_properties, so every exit
      // is hooked: breadcrumbs as they're recorded (navigation from/to, fetch/xhr
      // urls), then errors and transactions as they're sent (request.url, the
      // Referer header, trace data, every span). See scrubSentryPayload.
      beforeBreadcrumb: (breadcrumb) => scrubSentryPayload(breadcrumb),
      beforeSend: (event) => scrubSentryPayload(event),
      beforeSendTransaction: (event) => scrubSentryPayload(event),
    })
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY
  const posthogHost = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'
  if (posthogKey) {
    replayPaused = typeof window !== 'undefined' && isReplayBlockedPath(window.location.pathname)
    posthog.init(posthogKey, {
      api_host: posthogHost,
      capture_pageview: 'history_change',
      person_profiles: 'identified_only',
      // Autocapture: no textContent, no element attributes (href, value, …).
      mask_all_text: true,
      mask_all_element_attributes: true,
      // Replay: every text node and every input value masked; `ph-no-capture`
      // (the SDK's default blockClass) or `data-ph-block` removes a subtree
      // from the recording entirely. Options set here win over the project's
      // "Privacy and masking" settings in the PostHog UI.
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
        blockSelector: '[data-ph-block]',
      },
      // A session that STARTS on /account or /admin never begins recording;
      // main.tsx's router hooks handle arriving there later.
      disable_session_recording: replayPaused,
      // Masking covers the DOM, NOT event properties — $current_url is
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
  // with until it resolves.
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
