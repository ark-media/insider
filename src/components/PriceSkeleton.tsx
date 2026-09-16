// Pulsing placeholder bar shown in place of a price while it loads from Stripe.
// Height/width come in via `className` (prices sit at different type sizes).
export function PriceSkeleton({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-pulse rounded bg-rule-strong/40 align-middle ${className}`.trim()}
    />
  );
}
