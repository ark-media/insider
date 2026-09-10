// ---------------------------------------------------------------------------
// Server-side product analytics — deliberately NOT a revenue reporting layer.
//
// **Stripe Billing is the system of record for revenue.** MRR, the
// new/expansion/contraction/churned bridge, renewals, refunds, ARPU, cohort
// retention, dunning performance and the voluntary-vs-involuntary churn split
// (via `cancellation_details.reason`) all exist there already, reconciled to
// the ledger. Re-deriving any of it here would produce a second set of numbers
// that disagrees with the first and gets nobody to trust either. An earlier
// draft of this module emitted eleven events; the eight that duplicated Stripe
// were removed. Do not add them back — point revenue dashboards at Stripe.
//
// Acquisition channel is queryable in Stripe too: the browser's `first_touch_*`
// is stamped onto the subscription's metadata at checkout (shared/attribution.ts),
// so revenue-by-channel is a Sigma query that reconciles to the ledger by
// construction.
//
// What is left here is the residue Stripe genuinely cannot see:
//
//   1. A trustworthy BOTTOM for the browser funnel. The top of the funnel —
//      pricing_viewed, checkout_opened, drop-off by stage — exists only in the
//      browser, and browser `checkout_succeeded` is undercounted by ad blockers
//      and inflated by double-submits. Conversion rate needs a reliable
//      numerator in the same system as its denominator.
//   2. Whether a member who paid actually GOT ACCESS. Stripe cannot know
//      whether Beehiiv, Circle and Auth0 provisioning succeeded; a
//      payment succeeds, the member gets nothing, and Stripe shows a perfectly
//      happy customer.
//   3. Whether a gift was CLAIMED. Redemption happens in Neon, and the
//      magic-link path redeems server-side with no browser event at all.
//
// Transport: a direct POST to PostHog's single-event capture endpoint rather
// than the `posthog-node` SDK. Three reasons, in order of weight:
//   1. Flush semantics. The SDK batches in the background; a Vercel function
//      can be frozen the instant the webhook responds, dropping queued events
//      unless every path remembers to await a shutdown. An awaited fetch has
//      no such failure mode — the event is delivered before we ack Stripe.
//   2. House convention. email (Resend), circle and beehiiv-sync all speak
//      raw fetch to their upstreams; the existing test harness asserts against
//      a global fetch mock, so these events are testable with no new machinery.
//   3. Bundle weight in the single Vercel function that serves the whole API.
//
// Soft-fail by design, exactly like lib/email.ts: every caller invokes this
// AFTER the entitlement work has committed. An analytics failure must never
// throw, because throwing here would 500 the webhook and put Stripe into a
// retry loop over a metrics problem.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { FIRST_TOUCH_KEYS, LAST_TOUCH_KEYS, type Attribution } from '../../shared/attribution.js'
import { fetchWithTimeout } from './http.js'

type Env = Record<string, string>

const DEFAULT_HOST = 'https://us.i.posthog.com'

// Three events, one per gap listed above. Names are a public contract the same
// way the client EventMap is: once a funnel references one, add a new event
// rather than renaming it.
//
// Before adding a fourth, check whether Stripe or Neon already answers the
// question. If it does, query that instead.
type ServerEventMap = {
  // Gap 1 — the funnel's trustworthy bottom. `customer.subscription.created`.
  // NOT for counting revenue (that's Stripe); for being the honest numerator
  // over the browser-only denominator in a conversion funnel.
  subscription_started_confirmed: SubscriptionProps
  // Gap 2 — "paid" vs "actually got access". Emitted only after the Beehiiv /
  // Circle / Auth0 fan-out has completed. `axes` is what the tier actually granted.
  member_provisioned: SubscriptionProps & { axes: string }
  // Gap 3 — a gift was claimed. Keyed on the RECIPIENT, so the follow-on
  // question ("does a gift recipient convert to paid?") is answerable by
  // joining to their own later subscription_started_confirmed.
  gift_redeemed_confirmed: {
    tier: string
    plan: string | null
    applied: string
  }
}

type SubscriptionProps = {
  tier: string
  plan: string | null
  amount_cents: number | null
  currency: string | null
}

export type ServerEvent = keyof ServerEventMap

/**
 * Emit one server-side event.
 *
 * `distinctId` MUST be the member's `email_sha256` — the same value
 * src/lib/observability.ts identifies the browser with — so a person's checkout
 * intent and their confirmed revenue land on ONE PostHog person rather than two.
 * Use `emailDistinctId()` to derive it. (The BI plan proposed keying on
 * `auth0_sub`; that would have produced a second, disjoint person, because the
 * browser has never identified on auth0_sub.)
 *
 * Never throws. Returns whether the event was accepted, for tests and for the
 * one-line warning a caller may want to log.
 */
export async function captureServerEvent<E extends ServerEvent>(
  env: Env,
  args: {
    event: E
    distinctId: string
    properties: ServerEventMap[E]
    /** Attribution read back off Stripe metadata; merged into properties. */
    attribution?: Attribution
  },
): Promise<boolean> {
  // Falls back to the browser SDK's variable on purpose. PostHog uses ONE
  // project API key for both the browser and server capture APIs, so requiring
  // a second variable would mean the server half sits silently dark the day
  // someone sets only `VITE_POSTHOG_KEY` in Vercel — precisely the failure this
  // whole workstream exists to fix. Set `POSTHOG_API_KEY` explicitly only if
  // you want server events going to a different project.
  const apiKey = env.POSTHOG_API_KEY || env.VITE_POSTHOG_KEY
  if (!apiKey) return false
  if (!args.distinctId) {
    console.warn(`[analytics] ${args.event} has no distinct_id — skipping`)
    return false
  }

  const host = (env.POSTHOG_HOST || env.VITE_POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '')
  try {
    const res = await fetchWithTimeout(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: args.event,
        distinct_id: args.distinctId,
        properties: {
          ...args.properties,
          ...pickAttribution(args.attribution),
          // Marks the event as server-emitted so a dashboard can tell the
          // trustworthy `subscription_started_confirmed` apart from the
          // browser's optimistic `checkout_succeeded` at a glance.
          source: 'server',
          // Distinguishes test-mode Stripe traffic from real revenue without
          // needing a separate PostHog project.
          environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
          // Lets the warehouse stitch this person across Beehiiv / Circle /
          // Stripe on the same key (BI plan §2.6).
          email_sha256: args.distinctId,
        },
        timestamp: new Date().toISOString(),
      }),
    })
    if (!res.ok) {
      console.error('[analytics] posthog capture failed:', args.event, res.status)
      return false
    }
    return true
  } catch (err) {
    console.error('[analytics] posthog capture threw:', args.event, err)
    return false
  }
}

/**
 * The distinct_id for an email address: lowercase-trimmed SHA-256 hex. Must
 * match the browser's hashEmail() byte for byte or the two identities won't
 * merge. Returns '' for a missing email, which captureServerEvent treats as
 * "can't attribute this — skip".
 */
export function emailDistinctId(email: string | null | undefined): string {
  if (!email) return ''
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/**
 * Read attribution back off a Stripe metadata bag. The browser stamped it at
 * checkout (shared/attribution.ts), so a renewal event fired a year later still
 * knows which channel produced the member.
 */
export function attributionFromMetadata(
  metadata: Record<string, string> | null | undefined,
): Attribution {
  if (!metadata) return {}
  const out: Attribution = {}
  for (const key of [...FIRST_TOUCH_KEYS, ...LAST_TOUCH_KEYS]) {
    const value = metadata[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

function pickAttribution(attribution: Attribution | undefined): Record<string, string> {
  return attribution && Object.keys(attribution).length > 0 ? { ...attribution } : {}
}
