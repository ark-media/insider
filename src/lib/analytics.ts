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

type Plan = 'monthly' | 'yearly'

// Where a checkout attempt died, so `checkout_failed` is one event you can
// break down by stage in PostHog instead of three near-duplicate events.
type CheckoutFailureStage =
  | 'create_session' // server couldn't create the Stripe Checkout Session
  | 'payment' // Stripe rejected/declined the payment on confirm
  | 'provisioning' // paid, but activation didn't confirm in the poll window

// A retention coupon's value, normalized for analytics. Exactly one of
// percent_off / amount_off_cents is non-null; duration_months is set when the
// coupon repeats. Shared by the "shown" and "accepted" events so a funnel can
// compare offered vs. accepted discount on the same fields.
interface DiscountProps {
  percent_off: number | null
  amount_off_cents: number | null
  duration_months: number | null
}

// The contract. Key = event name, value = its required props (`void` = none).
interface EventMap {
  // --- Tier 1: revenue funnel ---
  pricing_viewed: void
  plan_selected: { plan: Plan }
  custom_amount_entered: { plan: Plan; amount: number; valid: boolean }
  checkout_opened: { plan: Plan; amount: number | null; is_custom_amount: boolean }
  checkout_email_submitted: { plan: Plan; is_custom_amount: boolean }
  checkout_payment_submitted: { plan: Plan }
  checkout_succeeded: { plan: Plan; is_custom_amount: boolean }
  checkout_failed: { plan: Plan; stage: CheckoutFailureStage; reason?: string }

  // --- Tier 2: churn / retention ---
  cancel_initiated: void
  retention_offer_shown: DiscountProps & { kind: 'percent' | 'amount' }
  retention_offer_accepted: DiscountProps
  retention_offer_declined: void
  cancellation_reason_submitted: { reason: string }
  subscription_cancelled: { reason: string; offer_outcome: 'declined' | 'not_offered' }
  subscription_reactivated: void

  // --- Tier 3: secondary conversions & activation ---
  newsletter_subscribed: { slug: string; result: 'ok' | 'error' }
  login_initiated: { intent: 'login' | 'signup' }
  // Gift checkout mirrors the Tier 1 funnel shape (opened → payment → result).
  gift_checkout_opened: { term: string }
  gift_payment_submitted: { term: string }
  gift_checkout_succeeded: { term: string }
  gift_checkout_failed: { term: string; stage: 'create_session' | 'payment'; reason?: string }
  // Private-feed activation: which app a member picks, and the terminal
  // hand-off action (open deep link / copy URL / text themselves the link).
  feed_app_selected: { app: string }
  feed_activated: { app: string; method: 'open' | 'copy' | 'sms' }
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
