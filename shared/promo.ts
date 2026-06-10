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
  plan: string | null
  maxRedemptions: number | null
  timesRedeemed: number
  redeemBy: string | null
  code: string | null
}
