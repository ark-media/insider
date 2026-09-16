import { useEffect, useId, useRef, useState } from "react";
import type { StripeCheckoutElementsValue } from "@stripe/react-stripe-js/checkout";
import { formatCouponDiscount } from "../lib/currency";
import type { PromoInfo } from "../lib/promo";
import { trackEvent } from "../lib/analytics";

// Only the slice of the Checkout object this needs: the discount the Session is
// carrying, the billing cadence it is carried on, and the two calls that fill or
// empty that slot.
type PromoCheckout = Pick<
  StripeCheckoutElementsValue,
  | "applyPromotionCode"
  | "removePromotionCode"
  | "discountAmounts"
  | "recurring"
  | "currency"
>;

// What the value comparison reads, so both the live Checkout object and the
// Session a promotion-code call hands back satisfy it.
type DiscountedSession = Pick<PromoCheckout, "discountAmounts" | "recurring">;

// Which door this is, so membership and gift stay separable in PostHog.
export type PromoSurface = "membership" | "gift";

const fieldClass =
  "w-full border border-rule-strong bg-transparent px-3 py-2.5 text-fg-strong uppercase placeholder:normal-case placeholder:text-fg-placeholder outline-none transition focus:border-cyan disabled:opacity-50";

const applyClass =
  "shrink-0 border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-50 disabled:hover:border-rule-strong disabled:hover:bg-transparent disabled:hover:text-inherit";

const noticeClass =
  "border border-cyan/50 bg-cyan/10 px-3 py-2 text-body-sm text-fg-strong";

// Stripe upper-cases codes and matches them case-insensitively; compare the
// same way so "spring60" is recognized as the sale we just applied.
function sameCode(a: string | null, b: string | null): boolean {
  return a != null && b != null && a.toUpperCase() === b.toUpperCase();
}

// How far ahead a discount is valued when two of them are compared.
//
// Some horizon is needed, because "forever" has no total and the two have to be
// commensurable. Two years rather than one: on the YEARLY plan a one-year
// horizon sees a single invoice, which collapses the comparison straight back
// to today's number — the thing this is here to stop.
const VALUATION_HORIZON_MONTHS = 24;

/** Months between invoices. One-time purchases (gifts) have no next invoice. */
function monthsPerInvoice(recurring: DiscountedSession["recurring"]): number {
  if (!recurring) return VALUATION_HORIZON_MONTHS;
  const months =
    recurring.interval === "year"
      ? 12
      : recurring.interval === "month"
        ? 1
        : recurring.interval === "week"
          ? 12 / 52
          : 12 / 365;
  return months * Math.max(recurring.intervalCount, 1);
}

/**
 * What the Session's discount is actually worth, rather than what it takes off
 * today's invoice.
 *
 * Comparing today's number alone is how "20% off forever" loses its slot to
 * "your first month free": the second is worth more on the first charge and
 * nothing at all after it, so the buyer who typed a perfectly valid code ends
 * up paying more from month two — the exact outcome the better-of-the-two rule
 * exists to prevent.
 *
 * Assumes each surviving invoice is discounted by roughly what today's is,
 * which holds for both shapes Stripe gives us (a percentage of a fixed
 * recurring price, or a fixed amount off it).
 */
function discountValueMinor(session: DiscountedSession): number {
  const applied = session.discountAmounts?.[0];
  if (!applied) return 0;
  const perInvoice = monthsPerInvoice(session.recurring);
  // `== null` rather than `=== null`: a payload without the field at all is the
  // same claim as `once`, and valuing it must not throw through the pay screen.
  const months =
    applied.recurring == null
      ? 0 // this invoice only
      : applied.recurring.type === "forever"
        ? VALUATION_HORIZON_MONTHS
        : Math.min(applied.recurring.durationInMonths, VALUATION_HORIZON_MONTHS);
  const invoices = Math.max(1, Math.ceil(months / perInvoice));
  return applied.minorUnitsAmount * invoices;
}

// The house sale, before a Session exists (the email step). Announces the
// discount the buyer is about to get without them doing anything.
export function PromoBanner({ promo }: { promo: PromoInfo }) {
  return (
    <p role="status" className={`mt-3 ${noticeClass}`}>
      <span className="font-semibold">
        {formatCouponDiscount(promo.percentOff, promo.amountOffCents)}
      </span>{" "}
      applied automatically{promo.name ? ` — ${promo.name}` : ""}.
    </p>
  );
}

// The live discount control on the payment step: applies the house sale for the
// buyer, and lets them redeem a code of their own.
//
// A Checkout Session holds ONE discount. Stripe won't take a server-set
// `discounts` array on a Session that allows promotion codes, and it won't
// stack two codes either — so the house sale and a buyer's code compete for the
// same slot, and the rule here is that the better of the two wins. Nobody ends
// up paying more for having typed a valid code.
export function PromoCode({
  checkout,
  promo,
  surface,
}: {
  checkout: PromoCheckout;
  promo: PromoInfo | null;
  surface: PromoSurface;
}) {
  const houseCode = promo?.code ?? null;
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [houseFailed, setHouseFailed] = useState(false);
  const autoAppliedFor = useRef<string | null>(null);

  // What the Session says is applied — the truth, rather than a local mirror of
  // it that a failed call could leave lying.
  const applied = checkout.discountAmounts?.[0] ?? null;
  const appliedCode = applied?.promotionCode ?? null;
  const houseApplied = sameCode(appliedCode, houseCode);

  // Apply the house sale once.
  //
  // Not silent when it fails, which it used to be. The buyer never typed this
  // code, so a dead one is not an error they can act on — but they have already
  // been PROMISED the discount on the email step (PromoBanner), and letting a
  // failed apply pass without a word charges them full price under a sentence
  // that said the sale was already on. Whatever we do about it, they have to be
  // told the promise didn't hold.
  useEffect(() => {
    if (!houseCode || autoAppliedFor.current === houseCode) return;
    autoAppliedFor.current = houseCode;
    // Don't clobber a code the buyer managed to type while this was loading.
    if (appliedCode) return;
    void (async () => {
      try {
        const result = await checkout.applyPromotionCode(houseCode);
        setHouseFailed(result.type === "error");
      } catch {
        setHouseFailed(true);
      }
    })();
  }, [houseCode, appliedCode, checkout]);

  const label = (code: string) =>
    sameCode(code, houseCode) ? "The current sale" : code.toUpperCase();

  // Put back whatever was in the slot before we emptied it. Used only on the
  // throw paths, where the slot is empty and nothing else is going to refill it.
  const restore = async (code: string) => {
    try {
      await checkout.applyPromotionCode(code);
    } catch {
      /* nothing further to try; the notice below tells the buyer */
    }
  };

  const apply = async () => {
    const code = draft.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);

    const previous = appliedCode;
    const beforeValue = discountValueMinor(checkout);
    const typed = code.toUpperCase();
    // try/finally, because every path out of here has to re-enable the field.
    // Without it a throw mid-sequence left the input and the Apply button
    // disabled forever, with no error to explain either.
    try {
      // Empty the slot before claiming it, so the outcome doesn't depend on
      // whether applying over an existing code replaces it or is refused.
      if (previous) await checkout.removePromotionCode();
      const result = await checkout.applyPromotionCode(code);

      if (result.type === "error") {
        if (previous) await checkout.applyPromotionCode(previous);
        setError(result.error.message || "That code isn't valid.");
        trackEvent("promo_code_rejected", { surface, code: typed, reason: "invalid" });
      } else if (previous && discountValueMinor(result.session) < beforeValue) {
        await checkout.removePromotionCode();
        await checkout.applyPromotionCode(previous);
        setNote(`${label(previous)} is a better deal than ${typed}, so we kept it.`);
        setDraft("");
        trackEvent("promo_code_rejected", {
          surface,
          code: typed,
          reason: "worse_than_sale",
        });
      } else {
        setDraft("");
        trackEvent("promo_code_applied", {
          surface,
          code: typed,
          discount_minor:
            result.type === "success"
              ? result.session.total.discount.minorUnitsAmount
              : 0,
          currency: checkout.currency,
        });
      }
    } catch {
      // The call threw rather than answering {type:'error'} — a dropped
      // connection, or the SDK itself. The slot is empty and the discount the
      // buyer arrived with is gone, so put it back before saying anything:
      // silently downgrading them to full price is the one outcome worse than
      // refusing their code.
      if (previous) await restore(previous);
      setError("We couldn't apply that code just now. Please try again.");
      trackEvent("promo_code_rejected", { surface, code: typed, reason: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    if (appliedCode) {
      trackEvent("promo_code_removed", { surface, code: appliedCode.toUpperCase() });
    }
    try {
      await checkout.removePromotionCode();
      // Removing a code you typed puts you back where you started, which is the
      // sale — not full price.
      if (houseCode) {
        const restored = await checkout.applyPromotionCode(houseCode);
        if (restored.type === "success") setNote("Code removed — the sale is back.");
      }
    } catch {
      setError("We couldn't update the discount just now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {houseApplied && promo ? (
        <p role="status" className={noticeClass}>
          <span className="font-semibold">
            {formatCouponDiscount(promo.percentOff, promo.amountOffCents)}
          </span>{" "}
          applied automatically{promo.name ? ` — ${promo.name}` : ""}.
        </p>
      ) : null}

      {/* The sale was announced on the email step and then didn't land. Say so
          here rather than letting the buyer meet the full price with no
          explanation and a promise still fresh from the screen before. */}
      {houseFailed && !appliedCode && promo ? (
        <p role="alert" className="text-body-sm text-danger">
          {promo.name ? `${promo.name} couldn't` : "The current sale couldn't"} be
          applied to this order — the price shown is the full price.
        </p>
      ) : null}

      {appliedCode && !houseApplied ? (
        <div className={`flex items-center justify-between gap-3 ${noticeClass}`}>
          <span>
            <span className="font-semibold">{appliedCode.toUpperCase()}</span>{" "}
            applied{applied ? ` — you save ${applied.amount}` : ""}.
          </span>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="shrink-0 text-xs uppercase tracking-button underline underline-offset-4 hover:text-cyan disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <div>
          <label htmlFor={inputId} className="eyebrow text-fg-muted">
            Promo code
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id={inputId}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // Enter inside the payment form would otherwise submit it — and
              // charge the card — instead of applying the code.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void apply();
              }}
              disabled={busy}
              placeholder="Have a code?"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className={fieldClass}
            />
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy || draft.trim() === ""}
              className={applyClass}
            >
              {busy ? "…" : "Apply"}
            </button>
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}
