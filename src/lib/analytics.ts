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
  // affordability_coupon, monthly_switch).
  save_offer_shown: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  save_offer_accepted: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  save_offer_declined: { flow: Flow; tier: Tier; offer_kind: OfferKind }
  // Fired once per checked reason when the post-cancel survey is submitted
  // (the survey is multi-select and collected after the cancel commits).
  cancellation_reason_submitted: { reason: string; flow: Flow }
  // Terminal full cancel (Flows A / B / E full cancel). retained_product is
  // always 'full-exit' here — carried for a uniform churn breakdown with
  // debundles. No `reason`: the survey-after-cancel design collects reasons
  // separately (cancellation_reason_submitted), after this fires.
  subscription_cancelled: {
    offer_outcome: 'declined' | 'not_offered'
    flow: Flow
    retained_product: RetainedProduct
  }
  // Terminal debundle (Flows C / D): kept one product, dropped the other. Never
  // a full exit — unchecking both services is Flow E, a full cancel.
  subscription_debundled: {
    flow: Flow
    retained_product: Exclude<RetainedProduct, 'full-exit'>
  }
  subscription_reactivated: void

  // --- Tier 3: secondary conversions & activation ---
  newsletter_subscribed: { slug: string; result: 'ok' | 'error' }
  login_initiated: { intent: 'login' | 'signup' }
  // Gift checkout mirrors the Tier 1 funnel shape (opened → payment → result).
  gift_checkout_opened: { tier?: Tier; term: string }
  gift_payment_submitted: { tier?: Tier; term: string }
  gift_checkout_succeeded: { tier?: Tier; term: string }
  gift_checkout_failed: {
    tier?: Tier
    term: string
    stage: 'create_session' | 'payment'
    reason?: string
  }
  // Recipient side of the gift funnel: the claim landed and access was granted (a
  // new membership term), an existing subscription was extended, or the value was
  // applied as account credit.
  gift_redeemed: { applied: 'membership' | 'credit' | 'mixed' | 'extended' }
  // Private-feed activation: which app a member picks, and the terminal
  // hand-off action (open deep link / copy URL / text themselves the link).
  feed_app_selected: { app: string }
  feed_activated: { app: string; method: 'open' | 'copy' | 'sms' }
  // The one-click path: linking Spotify once follows every private feed in the
  // network. `feed_count` is how many feeds that link covers.
  feed_spotify_linked: { feed_count: number }
  // Intent to buy the Community tier from the /community page — it opens OUR
  // CheckoutModal, so this is a top-of-funnel event that continues into
  // checkout_opened, not a hand-off. (It was previously documented as a
  // hand-off to Circle's own paid signup; that is wrong. Every purchase
  // transacts through our Stripe checkout — there is no other buy path.)
  circle_join_clicked: void

  // --- Attribution: outbound traffic we send off-domain ---
  // One generic event behind <OutboundLink>, rather than a bespoke event per
  // surface (BI plan §4.1, "one chokepoint, not seven"). We are a media company
  // that deliberately sends people to Circle, the app stores, social, and the
  // podcast platforms — that outflow is a first-class metric, not exhaust.
  //   destination — the target HOST only. Never the full URL: private-feed and
  //                 Circle deep links carry per-member tokens in the path/query.
  //   platform    — the brand being handed off to ('instagram', 'circle', 'ios').
  //   placement   — where on our site the link sat ('footer', 'community_feed').
  //   context     — optional discriminator within a placement (a space slug, an
  //                 event id, the newsletter post slug).
  outbound_link_clicked: {
    destination: string
    platform: string
    placement: string
    context?: string
  }

  // --- Tier 4: content engagement (high-value subset) ---
  episode_play_clicked: { show: string; episode: string }
  listen_link_clicked: { platform: string }
  // Book club: outbound Amazon (affiliate) click per pick, and the community
  // hand-off CTA — the two ends of the book-club → community funnel.
  book_link_clicked: { slug: string }
  book_club_join_clicked: void
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
