// ---------------------------------------------------------------------------
// Typed product-analytics event layer. A thin, compile-time-checked wrapper
// over PostHog's capture() (via track() in ./observability). The point is a
// single source of truth for event NAMES and their PROPERTY SHAPES so 20+
// call sites can't drift into `checkout_succeeded` vs `checkoutSuccess` or
// send mismatched props that quietly break a funnel.
//
// Rules of the road:
//   - Event names are the public contract with PostHog dashboards/funnels.
//     Once a name ships and a funnel references it, treat it as stable — add
//     a new event rather than renaming.
//   - Never put PII (raw email, full name) in props. Identity is handled by
//     identifyUser() in ./observability, which hashes the email. Props are
//     for segmentation (plan, amount, failure stage), not identification.
//   - track() is a no-op when PostHog isn't configured, so call sites never
//     need to guard.
//
// Currently scoped to Tier 1 — the revenue funnel (pricing → checkout → paid).
// Add later tiers (churn, newsletters, content) by extending EventMap.
// ---------------------------------------------------------------------------

import { track } from './observability'
import type { OfferKind } from '../../shared/retention'
import type { RetainedProduct } from '../../shared/cancellation'

type Plan = 'monthly' | 'yearly'

// The tier-aware cancel/debundle flow (A–E) an event belongs to, so churn and
// save outcomes are legible per flow in PostHog.
type Flow = 'A' | 'B' | 'C' | 'D' | 'E'

// The SKU dimension on the revenue funnel, so PostHog can break checkout down by
// Ark+ vs Circle vs Bundle. Optional on each event — a call site that predates
// the three-tier split still compiles and just omits it.
type Tier = 'ark-plus' | 'circle' | 'bundle'

// Where a checkout attempt died, so `checkout_failed` is one event you can
// break down by stage in PostHog instead of three near-duplicate events.
type CheckoutFailureStage =
  | 'create_session' // server couldn't create the Stripe Checkout Session
  | 'payment' // Stripe rejected/declined the payment on confirm
  | 'provisioning' // paid, but activation didn't confirm in the poll window

// The contract. Key = event name, value = its required props (`void` = none).
interface EventMap {
  // --- Tier 1: revenue funnel ---
  pricing_viewed: void
  plan_selected: { plan: Plan }
  custom_amount_entered: {
    plan: Plan
    amount: number
    currency: string
    valid: boolean
  }
  checkout_opened: {
    plan: Plan
    tier?: Tier
    amount: number | null
    is_custom_amount: boolean
  }
  checkout_email_submitted: { plan: Plan; tier?: Tier; is_custom_amount: boolean }
  checkout_payment_submitted: { plan: Plan; tier?: Tier }
  checkout_succeeded: { plan: Plan; tier?: Tier; is_custom_amount: boolean }
  checkout_failed: {
    plan: Plan
    tier?: Tier
    stage: CheckoutFailureStage
    reason?: string
  }

  // --- Tier 2: churn / retention (tier-aware flows A–E) ---
  // Fired at the entry of every cancel/debundle flow, tagged with which flow
  // and the member's current tier.
  cancel_initiated: { flow: Flow; tier: Tier }
  // Save-offer funnel per flow + offer kind (annual_switch, supporter_coupon,
  // affordability_coupon, circle_free_months, monthly_switch, perpetual_discount).
  save_offer_shown: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  save_offer_accepted: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  save_offer_declined: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  cancellation_reason_submitted: { reason: string; flow: Flow }
  // Terminal full cancel (Flows A / B / E full cancel). retained_product is
  // always 'full-exit' here — carried for a uniform churn breakdown with debundles.
  subscription_cancelled: {
    reason: string
    offer_outcome: 'declined' | 'not_offered'
    flow: Flow
    retained_product: RetainedProduct
  }
  // Terminal debundle (Flows C / D, and Flow E keep-just-one): kept one product,
  // dropped the other. Never a full exit.
  subscription_debundled: {
    flow: Flow
    retained_product: Exclude<RetainedProduct, 'full-exit'>
  }
  subscription_reactivated: void

  // --- Tier 3: secondary conversions & activation ---
  newsletter_subscribed: { slug: string; result: 'ok' | 'error' }
  login_initiated: { intent: 'login' | 'signup' }
  // Gift checkout mirrors the Tier 1 funnel shape (opened → payment → result).
  gift_checkout_opened: { term: string }
  gift_payment_submitted: { term: string }
  gift_checkout_succeeded: { term: string }
  gift_checkout_failed: { term: string; stage: 'create_session' | 'payment'; reason?: string }
  // Recipient side of the gift funnel: the claim landed and access was granted
  // (a new/extended membership term) or applied as account credit.
  gift_redeemed: { applied: 'membership' | 'credit' }
  // Private-feed activation: which app a member picks, and the terminal
  // hand-off action (open deep link / copy URL / text themselves the link).
  feed_app_selected: { app: string }
  feed_activated: { app: string; method: 'open' | 'copy' | 'sms' }
  // The one-click path: linking Spotify once follows every private feed in the
  // network. `feed_count` is how many feeds that link covers.
  feed_spotify_linked: { feed_count: number }
  // Hand-off to Circle's own paid signup — the last thing we can measure before
  // the funnel leaves our domain.
  circle_join_clicked: void

  // --- Tier 4: content engagement (high-value subset) ---
  episode_play_clicked: { show: string; episode: string }
  listen_link_clicked: { platform: string }
}

// Single typed entry point. The conditional tuple makes props REQUIRED for
// events that declare them and FORBIDDEN for `void` events, all inferred from
// the event name:
//   trackEvent('pricing_viewed')                  ✓
//   trackEvent('plan_selected', { plan: 'yearly' }) ✓
//   trackEvent('plan_selected')                    ✗ missing props
//   trackEvent('pricing_viewed', { plan: 'x' })    ✗ unexpected props
export function trackEvent<E extends keyof EventMap>(
  ...args: EventMap[E] extends void ? [event: E] : [event: E, props: EventMap[E]]
): void {
  const [event, props] = args
  track(event, props as Record<string, unknown> | undefined)
}
