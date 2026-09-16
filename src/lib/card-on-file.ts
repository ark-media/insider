import type { CardOnFile } from "./auth";

// "Visa ending 4242 · exp 04/28". The brand comes off Stripe lowercase
// ('visa', 'amex'), and month is a plain number that has to be zero-padded to
// look like an expiry rather than a typo.
export function cardLine(card: CardOnFile): string {
  const brand = card.brand
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const mm = String(card.expMonth).padStart(2, "0");
  const yy = String(card.expYear).slice(-2);
  return `${brand} ending ${card.last4} · exp ${mm}/${yy}`;
}
