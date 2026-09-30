import type { StripeCheckoutElementsValue } from "@stripe/react-stripe-js/checkout";

// The Subtotal / Discount / Tax / Total block on the payment step, shared by
// the membership and gift checkouts so the two can't drift apart. Amounts are
// Stripe's own localized strings. Tax is exclusive — added on top of the
// subtotal — and only known once a billing address is entered, so its row (like
// the discount's) appears only when there is something to show.
export function CheckoutTotals({
  total,
}: {
  total: StripeCheckoutElementsValue["total"];
}) {
  return (
    <div className="space-y-2 border-t border-rule pt-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-fg-muted">Subtotal</span>
        <span className="text-fg-strong">{total.subtotal.amount}</span>
      </div>
      {total.discount.minorUnitsAmount > 0 ? (
        <div className="flex items-baseline justify-between">
          <span className="text-fg-muted">Discount</span>
          <span className="text-fg-strong">−{total.discount.amount}</span>
        </div>
      ) : null}
      {total.taxExclusive.minorUnitsAmount > 0 ? (
        <div className="flex items-baseline justify-between">
          <span className="text-fg-muted">Tax</span>
          <span className="text-fg-strong">{total.taxExclusive.amount}</span>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between border-t border-rule pt-2">
        <span className="text-fg-muted">Total due today</span>
        <span className="font-semibold text-fg-strong">{total.total.amount}</span>
      </div>
    </div>
  );
}
