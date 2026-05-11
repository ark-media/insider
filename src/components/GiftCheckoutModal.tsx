import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Modal } from "./Modal";
import { SuccessMark } from "./SuccessMark";
import {
  createGiftCheckout,
  fetchGiftStatus,
  GIFT_LABEL,
  GIFT_PRICE_DOLLARS,
  type GiftInput,
} from "../lib/gift";

type Step =
  | { kind: "creating" }
  | {
      kind: "payment";
      clientSecret: string;
      paymentIntentId: string;
      amountCents: number;
    }
  | { kind: "activating"; paymentIntentId: string }
  | { kind: "processing" }
  | { kind: "done" }
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

const MAX_POLL_ATTEMPTS = 15;

async function pollUntilActivated(
  paymentIntentId: string,
  giverEmail: string,
  timeoutMs = 15000,
): Promise<"activated" | "processing" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    const data = await fetchGiftStatus(paymentIntentId, giverEmail);
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

  const handleClose = useCallback(() => {
    startedFor.current = null;
    setStep({ kind: "creating" });
    onClose();
  }, [onClose]);

  // Kick off the PaymentIntent creation once per open. Keyed on the input
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
    // PaymentIntent. Setting this in a callback would flash the stale state.
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
        kind: "payment",
        clientSecret: result.data.client_secret,
        paymentIntentId: result.data.payment_intent_id,
        amountCents: result.data.amount_cents,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, input, inputKey]);

  const stripePromiseValue = getStripe();

  const headerPrice = input ? GIFT_PRICE_DOLLARS[input.term] : 0;
  const headerLabel = input ? GIFT_LABEL[input.term] : "";

  return (
    <Modal open={open} onClose={handleClose} className="max-w-lg">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cyan">
        Gift · Inside Call Me Back
      </p>
      <h2 className="display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-white">
        ${headerPrice}{" "}
        <span className="text-[14px] font-sans font-normal text-white/50">
          · {headerLabel}
        </span>
      </h2>
      {input ? (
        <p className="mt-3 text-[13px] text-white/60">
          For{" "}
          <span className="font-semibold text-white">
            {input.recipientName || input.recipientEmail}
          </span>
          {input.recipientName ? (
            <span className="text-white/50"> · {input.recipientEmail}</span>
          ) : null}
        </p>
      ) : null}

      {step.kind === "creating" ? (
        <p className="mt-6 text-sm text-white/70">Preparing checkout…</p>
      ) : null}

      {step.kind === "payment" && stripePromiseValue && input ? (
        <Elements
          stripe={stripePromiseValue}
          options={{
            clientSecret: step.clientSecret,
            appearance: { theme: "night", labels: "floating" },
          }}
        >
          <PaymentStep
            giverEmail={input.giverEmail}
            paymentIntentId={step.paymentIntentId}
            onError={(message) => setStep({ kind: "error", message })}
            onActivating={() =>
              setStep({ kind: "activating", paymentIntentId: step.paymentIntentId })
            }
            onProcessing={() => setStep({ kind: "processing" })}
            onDone={() => setStep({ kind: "done" })}
          />
        </Elements>
      ) : null}

      {step.kind === "activating" ? (
        <p className="mt-6 text-sm text-white/70">
          Payment received — setting up the gift…
        </p>
      ) : null}

      {step.kind === "processing" && input ? (
        <div className="mt-6 space-y-3 text-sm text-white/80">
          <p>
            Your payment is being processed. We'll email{" "}
            <span className="font-semibold text-white">{input.recipientEmail}</span>{" "}
            as soon as it clears.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Close
          </button>
        </div>
      ) : null}

      {step.kind === "done" && input ? (
        <SuccessMark title="Gift sent.">
          <p>
            We just emailed{" "}
            <span className="font-semibold text-white">{input.recipientEmail}</span>{" "}
            a welcome link to set up their feed.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-6 w-full border border-white/30 px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.18em] transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Close
          </button>
        </SuccessMark>
      ) : null}

      {step.kind === "error" ? (
        <div className="mt-6 space-y-3 text-sm">
          <p className="text-red-300">{step.message}</p>
          <button
            type="button"
            onClick={handleClose}
            className="w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-white transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Close
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

function PaymentStep({
  giverEmail,
  paymentIntentId,
  onError,
  onActivating,
  onProcessing,
  onDone,
}: {
  giverEmail: string;
  paymentIntentId: string;
  onError: (message: string) => void;
  onActivating: () => void;
  onProcessing: () => void;
  onDone: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);

    const result = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: {
        return_url: `${window.location.origin}/?gift=complete`,
        receipt_email: giverEmail,
      },
    });

    if (result.error) {
      submittedRef.current = false;
      setSubmitting(false);
      onError(result.error.message ?? "Payment failed.");
      return;
    }

    const pi = result.paymentIntent;
    if (!pi) {
      submittedRef.current = false;
      setSubmitting(false);
      onError("Unexpected payment state.");
      return;
    }

    if (pi.status === "processing") {
      onProcessing();
      return;
    }

    if (pi.status === "succeeded") {
      onActivating();
      const activation = await pollUntilActivated(paymentIntentId, giverEmail);
      if (activation === "activated") {
        onDone();
      } else if (activation === "processing") {
        onProcessing();
      } else {
        // Stripe confirmed payment; activation is still pending. The webhook
        // will finish the job in the background — show the done state so the
        // giver isn't blocked.
        onDone();
      }
      return;
    }

    submittedRef.current = false;
    setSubmitting(false);
    onError(`Unexpected payment status: ${pi.status}`);
  };

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <PaymentElement />
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full border border-cyan bg-cyan px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-navy transition hover:bg-transparent hover:text-cyan disabled:opacity-60"
      >
        {submitting ? "Processing…" : "Pay & send gift"}
      </button>
    </form>
  );
}
