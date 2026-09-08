import { useEffect, useId, useRef, useState } from "react";
import type { StripeCheckoutElementsValue } from "@stripe/react-stripe-js/checkout";
import { formatCouponDiscount } from "../lib/currency";
import type { PromoInfo } from "../lib/promo";
import { trackEvent } from "../lib/analytics";

// Only the slice of the Checkout object this needs: the discount the Session is
// carrying, and the two calls that fill or empty that slot.
type PromoCheckout = Pick<
  StripeCheckoutElementsValue,
  | "applyPromotionCode"
  | "removePromotionCode"
  | "discountAmounts"
  | "total"
  | "currency"
>;

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
  const autoAppliedFor = useRef<string | null>(null);

  // What the Session says is applied — the truth, rather than a local mirror of
  // it that a failed call could leave lying.
  const applied = checkout.discountAmounts?.[0] ?? null;
  const appliedCode = applied?.promotionCode ?? null;
  const houseApplied = sameCode(appliedCode, houseCode);

  // Apply the house sale once. Silent whatever happens: the buyer never typed
  // this code, so a dead one is not an error they can do anything about — they
  // just see full price, exactly as before the sale existed.
  useEffect(() => {
    if (!houseCode || autoAppliedFor.current === houseCode) return;
    autoAppliedFor.current = houseCode;
    // Don't clobber a code the buyer managed to type while this was loading.
    if (appliedCode) return;
    void checkout.applyPromotionCode(houseCode);
  }, [houseCode, appliedCode, checkout]);

  const label = (code: string) =>
    sameCode(code, houseCode) ? "The current sale" : code.toUpperCase();

  const apply = async () => {
    const code = draft.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);

    const previous = appliedCode;
    const before = checkout.total.discount.minorUnitsAmount;
    // Empty the slot before claiming it, so the outcome doesn't depend on
    // whether applying over an existing code replaces it or is refused.
    if (previous) await checkout.removePromotionCode();
    const result = await checkout.applyPromotionCode(code);

    const typed = code.toUpperCase();
    if (result.type === "error") {
      if (previous) await checkout.applyPromotionCode(previous);
      setError(result.error.message || "That code isn't valid.");
      trackEvent("promo_code_rejected", { surface, code: typed, reason: "invalid" });
    } else if (previous && result.session.total.discount.minorUnitsAmount < before) {
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
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    if (appliedCode) {
      trackEvent("promo_code_removed", { surface, code: appliedCode.toUpperCase() });
    }
    await checkout.removePromotionCode();
    // Removing a code you typed puts you back where you started, which is the
    // sale — not full price.
    if (houseCode) {
      const restored = await checkout.applyPromotionCode(houseCode);
      if (restored.type === "success") setNote("Code removed — the sale is back.");
    }
    setBusy(false);
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
