// Acquisition attribution — the shared contract between the browser capture
// layer (src/lib/attribution.ts) and the server, which forwards it onto Stripe
// metadata so the webhook's revenue events carry the channel that produced the
// sale without having to rejoin to a browser session.
//
// Two touches, deliberately:
//   first_touch_*  the channel that introduced this person. Written once, never
//                  overwritten — it survives in localStorage across sessions and
//                  is the number you report "where did our members come from" on.
//   last_touch_*   the channel that produced *this* session. Overwritten per
//                  session, so it answers "what closed the sale."
//
// Key names are a public contract exactly like event names (analytics.ts §3):
// once a PostHog person property or a Stripe metadata key ships, funnels and
// warehouse queries reference it. Add, don't rename.

/** Written once per browser, on the first visit we ever see. */
export const FIRST_TOUCH_KEYS = [
  'first_touch_source',
  'first_touch_medium',
  'first_touch_campaign',
  'first_touch_content',
  'first_touch_referrer_host',
  'first_touch_landing_path',
  'first_touch_at',
] as const

/** Refreshed per session. */
export const LAST_TOUCH_KEYS = [
  'last_touch_source',
  'last_touch_medium',
  'last_touch_campaign',
] as const

// Internal to this module: consumers work with the `Attribution` bag and the
// two key arrays, never with the individual key unions.
type FirstTouchKey = (typeof FIRST_TOUCH_KEYS)[number]
type LastTouchKey = (typeof LAST_TOUCH_KEYS)[number]
type AttributionKey = FirstTouchKey | LastTouchKey

const ALL_KEYS: readonly AttributionKey[] = [...FIRST_TOUCH_KEYS, ...LAST_TOUCH_KEYS]
const ALL_KEY_SET: ReadonlySet<string> = new Set(ALL_KEYS)

/** A captured touch, before it is namespaced into first_/last_ keys. */
export type Touch = {
  source: string
  medium: string
  campaign?: string
  content?: string
  referrerHost?: string
  landingPath?: string
  at?: string
}

export type Attribution = Partial<Record<AttributionKey, string>>

// Stripe caps metadata values at 500 chars and keys at 40. Nothing we capture
// should come close, but a hostile `?utm_campaign=<10kb>` shouldn't be able to
// make session creation fail — so every value is clamped well below the limit.
export const MAX_ATTRIBUTION_VALUE_LEN = 200

/**
 * Narrow arbitrary client-supplied input down to the known attribution keys,
 * as trimmed, length-capped strings. Empty values are dropped rather than sent
 * as `""`, so a partially-attributed checkout doesn't stamp noise onto Stripe.
 *
 * The browser is the only source of this data, so it is untrusted by
 * definition: this is the allowlist that keeps a crafted checkout body from
 * writing arbitrary keys into Stripe metadata.
 */
export function sanitizeAttribution(input: unknown): Attribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Attribution = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALL_KEY_SET.has(key)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim().slice(0, MAX_ATTRIBUTION_VALUE_LEN)
    if (trimmed) out[key as AttributionKey] = trimmed
  }
  return out
}

/** Namespace a captured touch into its `first_touch_*` keys. */
export function toFirstTouch(touch: Touch): Attribution {
  return dropEmpty({
    first_touch_source: touch.source,
    first_touch_medium: touch.medium,
    first_touch_campaign: touch.campaign,
    first_touch_content: touch.content,
    first_touch_referrer_host: touch.referrerHost,
    first_touch_landing_path: touch.landingPath,
    first_touch_at: touch.at,
  })
}

/** Namespace a captured touch into its `last_touch_*` keys. */
export function toLastTouch(touch: Touch): Attribution {
  return dropEmpty({
    last_touch_source: touch.source,
    last_touch_medium: touch.medium,
    last_touch_campaign: touch.campaign,
  })
}

function dropEmpty(record: Partial<Record<AttributionKey, string | undefined>>): Attribution {
  const out: Attribution = {}
  for (const [key, value] of Object.entries(record)) {
    const trimmed = value?.trim().slice(0, MAX_ATTRIBUTION_VALUE_LEN)
    if (trimmed) out[key as AttributionKey] = trimmed
  }
  return out
}
