// API view of a retention discount offer — the subset of a Stripe coupon the
// cancel flow needs to render "keep your discount." Shared by the server
// serializer and the client offer step. Amounts are USD cents (our source
// currency); `durationMonths` is non-null only for a repeating coupon.

export type RetentionOffer = {
  couponId: string
  label: string | null
  percentOff: number | null
  amountOff: number | null
  durationMonths: number | null
}
