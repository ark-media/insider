import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  BillingAddressElement,
  CheckoutElementsProvider,
  PaymentElement,
  useCheckout,
} from "@stripe/react-stripe-js/checkout";
import { useNavigate } from "@tanstack/react-router";
import { CheckoutTerms } from "./CheckoutTerms";
import { Modal } from "./Modal";
import { LoadingRow } from "./Spinner";
import { CurrencySelect } from "./CurrencySelect";
import { modalPrimaryCta, modalSecondaryCta } from "../lib/modalCta";
import { useTheme } from "../lib/theme";
import { browserCountry, type PricingResponse } from "../lib/currency";
import {
  createGiftCheckout,
  fetchGiftStatus,
  GIFT_LABEL,
  GIFT_TIER_LABEL,
  type GiftInput,
} from "../lib/gift";
import { trackEvent } from "../lib/analytics";

type Step =
  // The Checkout Session is created once the presentment currency is resolved
  // (geo-detected default, changeable), so the giver's localized price shows on
  // the first screen. Changing currency recreates the Session.
  | { kind: "creating" }
  | { kind: "ready"; clientSecret: string; checkoutSessionId: string }
  | { kind: "activating" }
  | { kind: "processing" }
  | { kind: "error"; message: string };

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

let stripePromise: Promise<StripeJs | null> | null = null;
function getStripe() {
  if (!publishableKey) return null;
  if (!stripePromise) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

const titleClass =
  "display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong";

const closeButtonClass = `mt-4 ${modalSecondaryCta}`;

const MAX_POLL_ATTEMPTS = 15;

async function pollUntilActivated(
  checkoutSessionId: string,
  giverEmail: string,
  timeoutMs = 15000,
): Promise<"activated" | "processing" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    const data = await fetchGiftStatus(checkoutSessionId, giverEmail);
    if (data) {
      if (data.activated) return "activated";
      if (data.status === "processing") return "processing";
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}

export function GiftCheckoutModal({
  open,
  input,
  onClose,
}: {
  open: boolean;
  input: GiftInput | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "creating" });
  // Presentment currency: seeded from the geo-detected default, changeable via
  // the selector. `currencyReady` gates Session creation until that default has
  // resolved (or failed → USD) so we don't mint a throwaway USD Session first.
  const [currency, setCurrency] = useState<string>("usd");
  const [currencies, setCurrencies] = useState<string[] | null>(null);
  const [currencyReady, setCurrencyReady] = useState(false);
  const startedFor = useRef<string | null>(null);
  const { theme } = useTheme();
  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    startedFor.current = null;
    setStep({ kind: "creating" });
    setCurrencyReady(false);
    onClose();
  }, [onClose]);

  // Resolve the presentment currency once per open: /api/pricing carries a
  // geo-detected default and the supported-currency list (Stripe is the source
  // of truth). A failure leaves the default USD. Either way, flip currencyReady
  // so Session creation proceeds.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const hint = browserCountry();
        const res = await fetch(
          `/api/pricing${hint ? `?locale_hint=${encodeURIComponent(hint)}` : ""}`,
        );
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as PricingResponse | null;
          if (!cancelled && data?.currencies) {
            setCurrencies(data.currencies);
            if (typeof data.default_currency === "string") setCurrency(data.default_currency);
          }
        }
      } catch {
        /* non-fatal: gift is presented in USD */
      } finally {
        if (!cancelled) setCurrencyReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Kick off (or recreate) the Checkout Session. Keyed on the gift identity AND
  // the currency, so changing currency mints a fresh Session charging the new
  // currency_options amount. Waits for currencyReady so the first Session uses
  // the geo default, not a throwaway USD one.
  const inputKey = input
    ? `${input.giverEmail}|${input.recipientEmail}|${input.tier}|${input.term}`
    : null;
  const sessionKey = inputKey ? `${inputKey}|${currency}` : null;
  useEffect(() => {
    if (!open || !input || !sessionKey || !currencyReady) return;
    if (startedFor.current === sessionKey) return;
    startedFor.current = sessionKey;
    // Intentional: recreating for a new gift/currency must reset the prior
    // success/error state back to "creating" before we kick off the new Session.
    setStep({ kind: "creating" });
    let cancelled = false;
    (async () => {
      if (!publishableKey) {
        if (!cancelled) {
          setStep({
            kind: "error",
            message: "Checkout is temporarily unavailable. Please try again in a moment.",
          });
        }
        return;
      }
      const result = await createGiftCheckout({ ...input, currency });
      if (cancelled) return;
      if (!result.ok) {
        trackEvent("gift_checkout_failed", {
          tier: input.tier,
          term: input.term,
          stage: "create_session",
          reason: result.error,
        });
        setStep({ kind: "error", message: result.error });
        return;
      }
      setStep({
        kind: "ready",
        clientSecret: result.data.client_secret,
        checkoutSessionId: result.data.checkout_session_id,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, input, sessionKey, currency, currencyReady]);

  const stripePromiseValue = getStripe();

  return (
    <Modal
      open={open}
      onClose={handleClose}
      className="max-w-lg"
      labelledBy="gift-title"
      describedBy="gift-desc"
      scrollBody
    >
      <p id="gift-desc" className="eyebrow">
        {input ? `Gift · ${GIFT_TIER_LABEL[input.tier]} · ${GIFT_LABEL[input.term]}` : "Gift"}
      </p>

      {input ? (
        <p className="mt-3 text-body-sm break-words">
          For{" "}
          <span
            className="font-semibold text-fg-strong break-all"
            title={input.recipientName || input.recipientEmail}
          >
            {input.recipientName || input.recipientEmail}
          </span>
          {input.recipientName ? (
            <span className="text-fg-muted break-all" title={input.recipientEmail}>
              {" "}
              · {input.recipientEmail}
            </span>
          ) : null}
        </p>
      ) : null}

      {step.kind === "creating" ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Gift membership
          </h2>
          <LoadingRow label="Preparing checkout…" />
        </>
      ) : null}

      {step.kind === "ready" && stripePromiseValue && input ? (
        <>
          {/* Currency lives OUTSIDE the Elements provider: changing it recreates
              the Session (new currency_options amount), so the picker can't live
              on the provider it tears down. */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="eyebrow text-fg-muted">Pay in</span>
            <CurrencySelect
              value={currency}
              options={currencies ?? [currency]}
              disabled={!currencies}
              onChange={setCurrency}
            />
          </div>
          <CheckoutElementsProvider
            stripe={stripePromiseValue}
            options={{
              clientSecret: step.clientSecret,
              elementsOptions: {
                appearance: {
                  theme: theme === "light" ? "stripe" : "night",
                  labels: "floating",
                },
              },
              // Currency is fixed on the Session server-side (from
              // currency_options) — no Adaptive Pricing; the giver chose the
              // currency above before the Session was created.
            }}
          >
            <GiftPaymentForm
              input={input}
              checkoutSessionId={step.checkoutSessionId}
              onError={(message) => setStep({ kind: "error", message })}
              onActivating={() => setStep({ kind: "activating" })}
              onProcessing={() => setStep({ kind: "processing" })}
              onDone={() => {
                trackEvent("gift_checkout_succeeded", {
                  tier: input.tier,
                  term: input.term,
                });
                handleClose();
                void navigate({ to: "/", search: { gift: "complete" } });
              }}
            />
          </CheckoutElementsProvider>
        </>
      ) : null}

      {step.kind === "activating" ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Almost there
          </h2>
          <LoadingRow label="Payment received — wrapping up your gift…" />
        </>
      ) : null}

      {step.kind === "processing" && input ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Almost there
          </h2>
          <div className="mt-6 space-y-3 text-sm text-fg">
            <p>
              Your payment is going through. We'll email{" "}
              <span
                className="font-semibold text-fg-strong break-all"
                title={input.recipientEmail}
              >
                {input.recipientEmail}
              </span>{" "}
              a link to start their membership the moment it's confirmed.
            </p>
            <button type="button" onClick={handleClose} className={closeButtonClass}>
              Close
            </button>
          </div>
        </>
      ) : null}

      {step.kind === "error" ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Something went wrong
          </h2>
          <div className="mt-6 space-y-3 text-sm">
            <p role="alert" className="text-danger">{step.message}</p>
            <button type="button" onClick={handleClose} className={closeButtonClass}>
              Close
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

// Lives inside CheckoutElementsProvider, so useCheckout() gives us the giver's
// localized total (Adaptive Pricing) from the first screen. The giver's email
// is already known (set as the Session customer server-side), so there's no
// email step — currency + payment, then confirm.
function GiftPaymentForm({
  input,
  checkoutSessionId,
  onError,
  onActivating,
  onProcessing,
  onDone,
}: {
  input: GiftInput;
  checkoutSessionId: string;
  onError: (message: string) => void;
  onActivating: () => void;
  onProcessing: () => void;
  onDone: () => void;
}) {
  const checkoutState = useCheckout();
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  if (checkoutState.type === "loading") {
    return <LoadingRow label="Loading secure checkout…" />;
  }
  if (checkoutState.type === "error") {
    return (
      <>
        <h2 id="gift-title" className={titleClass}>
          Gift membership
        </h2>
        <p role="alert" className="mt-6 text-sm text-danger">
          {checkoutState.error.message}
        </p>
      </>
    );
  }

  const { checkout } = checkoutState;
  // Stripe-formatted, localized strings in the giver's selected currency
  // (Adaptive Pricing). Tax is exclusive: `subtotal` is the pre-tax gift price,
  // `taxExclusive` is the tax added on top, and `total` is the amount due
  // today. Tax is only known once a billing address is entered, so the tax row
  // appears reactively.
  const subtotal = checkout.total.subtotal.amount; // pre-tax, pre-discount
  const total = checkout.total.total.amount; // due today, incl. tax
  const hasDiscount = checkout.total.discount.minorUnitsAmount > 0;
  const discount = checkout.total.discount.amount;
  const hasTax = checkout.total.taxExclusive.minorUnitsAmount > 0;
  const tax = checkout.total.taxExclusive.amount;
  const label = GIFT_LABEL[input.term];

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    trackEvent("gift_payment_submitted", { tier: input.tier, term: input.term });

    // redirect: 'if_required' keeps card payments in the modal; methods that
    // need an off-site step (e.g. 3DS) use the session's return_url.
    const result = await checkout.confirm({ redirect: "if_required" });

    if (result.type === "error") {
      // A decline is retryable — stay on the payment form.
      submittedRef.current = false;
      setSubmitting(false);
      trackEvent("gift_checkout_failed", {
        tier: input.tier,
        term: input.term,
        stage: "payment",
        reason: result.error.message ?? "payment_failed",
      });
      onError(result.error.message ?? "Payment failed. Please try again.");
      return;
    }

    // Payment confirmed. The webhook provisions the gift a moment later, so
    // poll for it. Anything short of "activated"/"processing" still resolves
    // to done — the webhook finishes the job and emails the recipient.
    onActivating();
    const activation = await pollUntilActivated(checkoutSessionId, input.giverEmail);
    if (activation === "processing") {
      onProcessing();
    } else {
      onDone();
    }
  };

  return (
    <>
      <h2 id="gift-title" className={titleClass}>
        {subtotal}{" "}
        <span className="text-body-sm font-sans font-normal">
          · {label}
        </span>
      </h2>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <PaymentElement />
        {/* Billing address powers Stripe Tax: the calculated tax updates the
            totals below as soon as a usable address is entered. */}
        <BillingAddressElement />
        <div className="space-y-2 border-t border-rule pt-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-fg-muted">Subtotal</span>
            <span className="text-fg-strong">{subtotal}</span>
          </div>
          {hasDiscount ? (
            <div className="flex items-baseline justify-between">
              <span className="text-fg-muted">Discount</span>
              <span className="text-fg-strong">−{discount}</span>
            </div>
          ) : null}
          {hasTax ? (
            <div className="flex items-baseline justify-between">
              <span className="text-fg-muted">Tax</span>
              <span className="text-fg-strong">{tax}</span>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between border-t border-rule pt-2">
            <span className="text-fg-muted">Total due today</span>
            <span className="font-semibold text-fg-strong">{total}</span>
          </div>
        </div>
        <CheckoutTerms action="buying a gift" />
        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className={modalPrimaryCta}
        >
          {submitting ? "Processing…" : `Pay ${total} & send gift`}
        </button>
      </form>
    </>
  );
}
