// When a gift recipient subscribes before their gift runs out, billing starts
// the day the gift ends — not today. Charging today would bill them for months
// the gift already paid for.
//
// The subscription is created with a trial that ends when the gift does. A
// trial is Stripe's own "nothing to pay until" mechanism: the card is saved at
// checkout, no invoice is cut until trial_end, and the first charge lands then
// at the price they chose.
//
// Only when the gift covers EVERYTHING the plan sells. A Fold gift doesn't pay
// for Ark+, so someone with one buying the Bundle is charged today like any
// other buyer — a trial would hand them the uncovered axis free until the gift
// ends. Where the plan needs both axes, billing starts when the FIRST of the two
// gifts runs out: after that, part of what they're getting is no longer paid for.

import { deriveEntitlements } from '../../entitlement.js'
import type { PricedTier } from '../../lib/pricing.js'
import type { MembershipRow } from '../../lib/membership.js'

// Checkout refuses a trial_end less than 48 hours away. A gift that close to
// its end bills today — a day or two of overlap, not the months this is for.
export const GIFT_TRIAL_MIN_LEAD_SEC = 48 * 60 * 60

// And more than 730 days away. Stacked gifts could in principle reach past it;
// billing then starts at the cap, a little early, rather than refusing to sell.
export const GIFT_TRIAL_MAX_SEC = 730 * 24 * 60 * 60

type GiftExpiries = Pick<MembershipRow, 'ark_plus_gift_expires_at' | 'circle_gift_expires_at'>

function expirySec(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

// The unix-seconds trial_end for a new subscription to `tier`, or null when it
// should bill today (no gift, a gift that doesn't cover the whole plan, or one
// ending inside the 48-hour floor).
export function giftTrialEndSec(
  row: GiftExpiries | null,
  tier: PricedTier,
  nowSec: number,
): number | null {
  if (!row) return null
  const needs = deriveEntitlements(tier)
  const ends: number[] = []
  if (needs.arkPlus) {
    const end = expirySec(row.ark_plus_gift_expires_at)
    if (end === null) return null
    ends.push(end)
  }
  if (needs.circle) {
    const end = expirySec(row.circle_gift_expires_at)
    if (end === null) return null
    ends.push(end)
  }
  const coveredUntil = Math.min(...ends)
  if (coveredUntil < nowSec + GIFT_TRIAL_MIN_LEAD_SEC) return null
  return Math.min(coveredUntil, nowSec + GIFT_TRIAL_MAX_SEC)
}
