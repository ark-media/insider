// API view of a Stripe promo (a coupon plus its optional promotion-code label),
// flattened for the back office. Shared by the server serializer and the client.

export type Promo = {
  id: string
  name: string | null
  valid: boolean
  kind: 'percent' | 'amount'
  percentOff: number | null
  amountOffCents: number | null
  currency: string | null
  duration: string
  durationInMonths: number | null
  autoApply: boolean
  // Eligible to be offered in the cancel save flow (metadata.retention_offer).
  retentionOffer: boolean
  // Which save in that flow it fills (metadata.offer_kind) — see CouponOfferKind.
  offerKind: string | null
  plan: string | null
  maxRedemptions: number | null
  timesRedeemed: number
  redeemBy: string | null
  code: string | null

  // --- Promotion-code restrictions -----------------------------------------
  // These live on the CODE, not the coupon, and Stripe checks them at
  // redemption — which is what makes them per-buyer, unlike the coupon's
  // global max_redemptions. Null/false when there's no code or no restriction.
  codeMaxRedemptions: number | null
  codeTimesRedeemed: number | null
  codeExpiresAt: string | null
  // Only redeemable by someone with no prior payment or invoice.
  firstTimeOnly: boolean
  // Minimum basket, in USD minor units. The code also carries the equivalent in
  // every other supported currency — a minimum in USD alone would make the code
  // unredeemable everywhere else (Stripe: "The supported currencies of your
  // promotion code (usd) must include the currency of the object").
  minimumAmountCents: number | null
}
