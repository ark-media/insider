import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  CheckoutElementsProvider,
  CurrencySelectorElement,
  PaymentElement,
  useCheckout,
} from "@stripe/react-stripe-js/checkout";
import { useNavigate } from "@tanstack/react-router";
import { Modal } from "./Modal";
import { useTheme } from "../lib/theme";
import {
  createGiftCheckout,
  fetchGiftStatus,
  GIFT_LABEL,
  type GiftInput,
} from "../lib/gift";

type Step =
  // The Checkout Session is created the moment the modal opens so the giver's
  // localized price (Adaptive Pricing) shows on the first screen.
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

const closeButtonClass =
  "mt-4 inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

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
  const startedFor = useRef<string | null>(null);
  const { theme } = useTheme();
  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    startedFor.current = null;
    setStep({ kind: "creating" });
    onClose();
  }, [onClose]);

  // Kick off the Checkout Session creation once per open. Keyed on the input
  // identity so re-opening with a different gift restarts cleanly.
  const inputKey = input
    ? `${input.giverEmail}|${input.recipientEmail}|${input.term}`
    : null;
  useEffect(() => {
    if (!open || !input || !inputKey) return;
    if (startedFor.current === inputKey) return;
    startedFor.current = inputKey;
    // Intentional: re-opening with a different gift must reset the prior
    // success/error state back to "creating" before we kick off the new
    // Session. Setting this in a callback would flash the stale state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep({ kind: "creating" });
    let cancelled = false;
    (async () => {
      if (!publishableKey) {
        if (!cancelled) {
          setStep({
            kind: "error",
            message: "Stripe is not configured (VITE_STRIPE_PUBLISHABLE_KEY missing).",
          });
        }
        return;
      }
      const result = await createGiftCheckout(input);
      if (cancelled) return;
      if (!result.ok) {
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
  }, [open, input, inputKey]);

  const stripePromiseValue = getStripe();

  return (
    <Modal
      open={open}
      onClose={handleClose}
      className="max-w-lg"
      labelledBy="gift-title"
      describedBy="gift-desc"
    >
      <p id="gift-desc" className="eyebrow">Gift · Inside Call Me Back</p>

      {input ? (
        <p className="mt-3 text-[13px] text-fg-muted break-words">
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
            // Mark this integration as ready for Adaptive Pricing; Stripe then
            // localizes the currency and powers the Currency Selector Element.
            adaptivePricing: { allowed: true },
          }}
        >
          <GiftPaymentForm
            input={input}
            checkoutSessionId={step.checkoutSessionId}
            onError={(message) => setStep({ kind: "error", message })}
            onActivating={() => setStep({ kind: "activating" })}
            onProcessing={() => setStep({ kind: "processing" })}
            onDone={() => {
              handleClose();
              void navigate({ to: "/", search: { gift: "complete" } });
            }}
          />
        </CheckoutElementsProvider>
      ) : null}

      {step.kind === "activating" ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Almost there
          </h2>
          <LoadingRow label="Payment received — setting up the gift…" />
        </>
      ) : null}

      {step.kind === "processing" && input ? (
        <>
          <h2 id="gift-title" className={titleClass}>
            Almost there
          </h2>
          <div className="mt-6 space-y-3 text-sm text-fg">
            <p>
              Your payment is being processed. We'll email{" "}
              <span
                className="font-semibold text-fg-strong break-all"
                title={input.recipientEmail}
              >
                {input.recipientEmail}
              </span>{" "}
              as soon as it clears.
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

function LoadingRow({ label }: { label: string }) {
  return (
    <div
      className="mt-6 flex items-center gap-3 text-sm text-fg"
      role="status"
      aria-live="polite"
    >
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none" />
      <span>{label}</span>
    </div>
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
  // Stripe-formatted, localized string in the giver's selected currency.
  const total = checkout.total.total.amount;
  const label = GIFT_LABEL[input.term];

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);

    // redirect: 'if_required' keeps card payments in the modal; methods that
    // need an off-site step (e.g. 3DS) use the session's return_url.
    const result = await checkout.confirm({ redirect: "if_required" });

    if (result.type === "error") {
      // A decline is retryable — stay on the payment form.
      submittedRef.current = false;
      setSubmitting(false);
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
        {total}{" "}
        <span className="text-[14px] font-sans font-normal text-fg-muted">
          · {label}
        </span>
      </h2>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <span className="eyebrow text-fg-muted">Pay in</span>
          <div className="mt-2">
            <CurrencySelectorElement />
          </div>
        </div>
        <PaymentElement />
        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className="inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
        >
          {submitting ? "Processing…" : `Pay ${total} & send gift`}
        </button>
      </form>
    </>
  );
}
