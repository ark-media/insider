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

import { deriveEntitlements, type Tier } from '../../entitlement.js'
import type { Sql } from '../../lib/db.js'
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

// Subscription metadata naming the gift(s) whose term a gift-funded trial is
// standing in for, as comma-joined redemption tokens. Nothing else ties the
// subscription to the gift: the trial is just a trial_end to Stripe, and a
// trialing subscription reads as live to the webhook. Without it, refunding or
// disputing the gift took the term off the Neon row but left the subscription
// trialing — the gifted months stayed free with the money back. The webhook's
// gift reversal (reverseRedeemedGift) reads this to end or shorten the trial.
export const GIFT_TRIAL_TOKENS_KEY = 'gift_trial_tokens'

// Stripe caps a metadata value at 500 characters. A token is 43 (base64url of a
// SHA-256), so this holds the eleven most recent gifts — far more than any
// recipient stacks.
const GIFT_TRIAL_TOKENS_MAX_LEN = 500

// The tokens behind a gift-funded trial on `tier`: every redeemed gift this
// member holds that pays for an axis the plan needs. Over-inclusive on purpose —
// an older gift whose term has already run out is named too — because the
// reversal doesn't end the trial on the token alone: it re-derives what the
// remaining gifts still cover and only cuts the trial back to that.
//
// Newest first, so if the list ever outgrew the cap it is the oldest (and least
// likely to still be funding the trial) that drop off. Throws on a DB error;
// the checkout caller fails closed.
export async function giftTrialTokensFor(
  sql: Sql,
  redeemerSub: string,
  tier: PricedTier,
): Promise<string[]> {
  const needs = deriveEntitlements(tier)
  const rows = (await sql`
    select redemption_token, tier from gift
    where redeemed_by = ${redeemerSub} and status = 'redeemed'
    order by created_at desc`) as Array<{ redemption_token: string; tier: Tier }>
  const tokens: string[] = []
  let len = 0
  for (const g of rows) {
    const covers = deriveEntitlements(g.tier)
    if (!((needs.arkPlus && covers.arkPlus) || (needs.circle && covers.circle))) continue
    const add = (tokens.length > 0 ? 1 : 0) + g.redemption_token.length
    if (len + add > GIFT_TRIAL_TOKENS_MAX_LEN) break
    tokens.push(g.redemption_token)
    len += add
  }
  return tokens
}

// The tokens a subscription's metadata names, or [] when it names none.
export function giftTrialTokensOf(metadata: Record<string, string> | null | undefined): string[] {
  const raw = metadata?.[GIFT_TRIAL_TOKENS_KEY]
  if (!raw) return []
  return raw.split(',').map((t) => t.trim()).filter((t) => t !== '')
}
