// ---------------------------------------------------------------------------
// Acquisition attribution capture (BI plan §4.1).
//
// Not an event — a capture layer. On every page load we resolve the current
// "touch" (which channel brought this pageview) from the URL's campaign
// parameters and the referrer, then:
//
//   - persist FIRST touch in localStorage, written exactly once per browser
//   - persist LAST touch in sessionStorage, refreshed per session
//   - hand both to observability.ts, which registers them as PostHog
//     super-properties (so every subsequent event carries the channel) and as
//     person properties at identify time
//   - hand first-touch to the checkout modals, which forward it into Stripe
//     Checkout metadata so the server-side revenue events (§4.2) are attributed
//     without needing to rejoin to a browser session
//
// This module deliberately performs no PostHog calls of its own — observability.ts
// is the single place that touches the SDK, and the dependency runs one way
// (observability → attribution) so the two can't form an import cycle.
//
// Storage is best-effort throughout: Safari private mode and hardened browser
// settings make localStorage throw on write, and losing attribution must never
// break the page.
// ---------------------------------------------------------------------------

import {
  toFirstTouch,
  toLastTouch,
  type Attribution,
  type Touch,
} from '../../shared/attribution'

const FIRST_TOUCH_STORAGE_KEY = 'ark_first_touch'
const LAST_TOUCH_STORAGE_KEY = 'ark_last_touch'

// Enough to split "organic search" out of the referral bucket. Not exhaustive
// by design — an unrecognized search engine lands in `referral` with its host
// as the source, which is still legible in a dashboard.
const SEARCH_ENGINE_HOSTS = [
  'google.',
  'bing.',
  'duckduckgo.',
  'search.yahoo.',
  'ecosia.',
  'search.brave.',
  'startpage.',
]

// Click identifiers that imply a paid channel even with no utm_* present.
const CLICK_ID_SOURCES: ReadonlyArray<[param: string, source: string]> = [
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['fbclid', 'facebook'],
  ['msclkid', 'bing'],
  ['ttclid', 'tiktok'],
  ['li_fat_id', 'linkedin'],
]

/**
 * Resolve the touch for the current pageview. Precedence, highest first:
 *   1. explicit `utm_source` — the campaign told us, believe it
 *   2. a paid click identifier (gclid/fbclid/…) — implies source + cpc
 *   3. `?ref=` — our own outbound-link tagging (show notes, newsletter footers)
 *   4. the referrer host — organic search vs referral
 *   5. direct
 */
export function resolveTouch(
  search: string,
  referrer: string,
  selfHost: string,
  landingPath: string,
  now: string,
): Touch {
  const params = new URLSearchParams(search)
  const get = (key: string) => params.get(key)?.trim() || undefined

  const referrerHost = externalReferrerHost(referrer, selfHost)
  const campaign = get('utm_campaign') ?? get('ref')
  const content = get('utm_content') ?? get('utm_term')

  const base = {
    campaign,
    content,
    referrerHost,
    landingPath,
    at: now,
  }

  const utmSource = get('utm_source')
  if (utmSource) {
    return { ...base, source: utmSource, medium: get('utm_medium') ?? 'referral' }
  }

  for (const [param, source] of CLICK_ID_SOURCES) {
    if (get(param)) return { ...base, source, medium: get('utm_medium') ?? 'cpc' }
  }

  const ref = get('ref')
  if (ref) return { ...base, source: ref, medium: get('utm_medium') ?? 'referral' }

  if (referrerHost) {
    const isSearch = SEARCH_ENGINE_HOSTS.some((h) => referrerHost.startsWith(h))
    return {
      ...base,
      source: referrerHost,
      medium: isSearch ? 'organic' : 'referral',
    }
  }

  return { ...base, source: 'direct', medium: 'none' }
}

/**
 * Whether this touch carries a deliberate channel signal, as opposed to being a
 * plain direct hit. Only a signal-bearing touch overwrites last-touch, so
 * navigating to a bookmark mid-session doesn't erase the campaign that closed
 * the sale.
 */
function hasChannelSignal(touch: Touch): boolean {
  return touch.source !== 'direct'
}

// The referrer's host, or undefined when the referrer is absent or is us
// (in-app navigation and our own cross-host hand-offs are not acquisition).
function externalReferrerHost(referrer: string, selfHost: string): string | undefined {
  if (!referrer) return undefined
  let host: string
  try {
    host = new URL(referrer).hostname.toLowerCase()
  } catch {
    return undefined
  }
  const bare = stripWww(host)
  const self = stripWww(selfHost.toLowerCase())
  // Treat our own apex and any subdomain of it as internal.
  if (bare === self || bare.endsWith(`.${self}`) || self.endsWith(`.${bare}`)) return undefined
  return bare
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host
}

// --- storage -------------------------------------------------------------

function readStored(storage: Storage | null, key: string): Attribution | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Attribution)
      : null
  } catch {
    return null
  }
}

function writeStored(storage: Storage | null, key: string, value: Attribution): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — attribution is best-effort */
  }
}

function safeStorage(get: () => Storage): Storage | null {
  try {
    return get()
  } catch {
    return null
  }
}

// Cached in module scope so getAttribution() stays synchronous and cheap for the
// checkout call sites, and so a mid-session storage failure can't lose what we
// already captured on load.
let captured: Attribution = {}

/** What a capture yields, for observability.ts to register with PostHog. */
export type CapturedAttribution = {
  attribution: Attribution
  entryPage: string
  isReturning: boolean
}

/**
 * Capture attribution for this pageview. Called once from initObservability(),
 * after posthog.init() so the resulting super-properties land before the first
 * autocaptured pageview.
 */
export function captureAttribution(): CapturedAttribution | null {
  if (typeof window === 'undefined') return null

  const local = safeStorage(() => window.localStorage)
  const session = safeStorage(() => window.sessionStorage)

  const touch = resolveTouch(
    window.location.search,
    document.referrer,
    window.location.hostname,
    window.location.pathname,
    new Date().toISOString(),
  )

  // First touch: write once. An existing record is authoritative forever — this
  // is what makes "which channel introduced this member" answerable months
  // after the fact.
  const storedFirst = readStored(local, FIRST_TOUCH_STORAGE_KEY)
  const isReturning = storedFirst !== null
  const firstTouch = storedFirst ?? toFirstTouch(touch)
  if (!storedFirst) writeStored(local, FIRST_TOUCH_STORAGE_KEY, firstTouch)

  // Last touch: refresh when this visit carries a real channel signal, or when
  // the session has none yet.
  const storedLast = readStored(session, LAST_TOUCH_STORAGE_KEY)
  const lastTouch = !storedLast || hasChannelSignal(touch) ? toLastTouch(touch) : storedLast
  if (lastTouch !== storedLast) writeStored(session, LAST_TOUCH_STORAGE_KEY, lastTouch)

  captured = { ...firstTouch, ...lastTouch }

  return {
    attribution: captured,
    entryPage: window.location.pathname,
    isReturning,
  }
}

/**
 * The captured attribution, for the checkout modals to forward into Stripe
 * metadata. Falls back to reading storage directly if capture hasn't run (a
 * deep link straight into checkout on a build where PostHog is disabled still
 * gets attributed — storage is written regardless of PostHog).
 */
export function getAttribution(): Attribution {
  if (Object.keys(captured).length > 0) return captured
  const local = safeStorage(() => window.localStorage)
  const session = safeStorage(() => window.sessionStorage)
  return {
    ...(readStored(local, FIRST_TOUCH_STORAGE_KEY) ?? {}),
    ...(readStored(session, LAST_TOUCH_STORAGE_KEY) ?? {}),
  }
}

/** Test seam — resets the module-scope cache between cases. */
export function __resetAttributionCache(): void {
  captured = {}
}
