import { useCallback, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Modal } from "./Modal";

type Plan = "monthly" | "yearly";

type Step =
  | { kind: "details" }
  | { kind: "creating" }
  | {
      kind: "payment";
      clientSecret: string;
      subscriptionId: string;
      email: string;
      amountCents: number;
    }
  | { kind: "activating"; subscriptionId: string; email: string }
  | { kind: "processing"; email: string }
  | { kind: "done"; email: string }
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

const inputClass =
  "w-full border border-white/20 bg-transparent px-3 py-2.5 text-white placeholder:text-white/30 outline-none transition focus:border-cyan disabled:opacity-50";

const MAX_POLL_ATTEMPTS = 15;

async function pollUntilActivated(
  subscriptionId: string,
  email: string,
  timeoutMs = 15000,
): Promise<"activated" | "processing" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    const params = new URLSearchParams({ id: subscriptionId, email });
    const res = await fetch(`/api/stripe/subscription-status?${params}`);
    if (res.ok) {
      const data = (await res.json()) as { status: string; activated: boolean };
      if (data.activated) return "activated";
      if (data.status === "processing") return "processing";
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}

export function CheckoutModal({
  open,
  plan,
  defaultAmount,
  customAmount,
  onClose,
}: {
  open: boolean;
  plan: Plan;
  defaultAmount: number;
  customAmount: number | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "details" });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const handleClose = useCallback(() => {
    setStep({ kind: "details" });
    setEmail("");
    setName("");
    onClose();
  }, [onClose]);

  const amountCents =
    customAmount !== null ? Math.round(customAmount * 100) : defaultAmount * 100;
  const displayAmount = (amountCents / 100).toFixed(2);
  const intervalLabel = plan === "yearly" ? "year" : "month";

  const startCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (!publishableKey) {
      setStep({
        kind: "error",
        message: "Stripe is not configured (VITE_STRIPE_PUBLISHABLE_KEY missing).",
      });
      return;
    }
    setStep({ kind: "creating" });
    try {
      const res = await fetch("/api/stripe/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          plan,
          custom_amount_cents: customAmount !== null ? amountCents : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        client_secret?: string;
        subscription_id?: string;
        amount_cents?: number;
        error?: string;
      };
      if (!res.ok || !data.client_secret || !data.subscription_id) {
        setStep({
          kind: "error",
          message: data.error ?? "Could not start checkout.",
        });
        return;
      }
      setStep({
        kind: "payment",
        clientSecret: data.client_secret,
        subscriptionId: data.subscription_id,
        email: email.trim(),
        amountCents: data.amount_cents ?? amountCents,
      });
    } catch {
      setStep({ kind: "error", message: "Network error. Please try again." });
    }
  };

  const stripePromiseValue = getStripe();

  return (
    <Modal open={open} onClose={handleClose} className="max-w-lg">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cyan">
        Insider Membership · {plan === "yearly" ? "Annual" : "Monthly"}
      </p>
      <h2 className="mt-2 font-serif text-3xl leading-tight">
        ${displayAmount}{" "}
        <span className="text-base text-white/50">/ {intervalLabel}</span>
      </h2>

      {(step.kind === "details" || step.kind === "creating") && (
        <form onSubmit={startCheckout} className="mt-6 space-y-4">
          <Field label="Name (optional)">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={step.kind === "creating"}
              placeholder="Jane Appleseed"
              className={inputClass}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={step.kind === "creating"}
              placeholder="you@example.com"
              className={inputClass}
            />
          </Field>
          <button
            type="submit"
            disabled={step.kind === "creating"}
            className="w-full border border-cyan bg-cyan px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-navy transition hover:bg-transparent hover:text-cyan disabled:opacity-60"
          >
            {step.kind === "creating" ? "Preparing checkout…" : "Continue to payment"}
          </button>
          <p className="text-[11px] leading-snug text-white/45">
            Payment is securely processed by Stripe. You'll receive a sign-in
            link by email once your membership is active.
          </p>
        </form>
      )}

      {step.kind === "payment" && stripePromiseValue && (
        <Elements
          stripe={stripePromiseValue}
          options={{
            clientSecret: step.clientSecret,
            appearance: { theme: "night", labels: "floating" },
          }}
        >
          <PaymentStep
            email={step.email}
            subscriptionId={step.subscriptionId}
            onError={(message) => setStep({ kind: "error", message })}
            onActivating={() =>
              setStep({
                kind: "activating",
                subscriptionId: step.subscriptionId,
                email: step.email,
              })
            }
            onDone={() => setStep({ kind: "done", email: step.email })}
            onProcessing={() =>
              setStep({ kind: "processing", email: step.email })
            }
          />
        </Elements>
      )}

      {step.kind === "activating" && (
        <p className="mt-6 text-sm text-white/70">
          Payment received — activating your membership…
        </p>
      )}

      {step.kind === "processing" && (
        <div className="mt-6 space-y-3 text-sm text-white/80">
          <p>
            Your payment is being processed by your bank. We'll email{" "}
            <span className="font-semibold text-white">{step.email}</span> a
            sign-in link as soon as it clears (usually within a few minutes).
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Close
          </button>
        </div>
      )}

      {step.kind === "done" && (
        <div className="mt-6 space-y-3 text-sm text-white/80">
          <p>
            You're in. We just sent a sign-in link to{" "}
            <span className="font-semibold text-white">{step.email}</span>.
            Tap it to set up your private podcast feed.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Close
          </button>
        </div>
      )}

      {step.kind === "error" && (
        <div className="mt-6 space-y-3 text-sm">
          <p className="text-red-300">{step.message}</p>
          <button
            type="button"
            onClick={() => setStep({ kind: "details" })}
            className="w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-white transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Try again
          </button>
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/55">
        {label}
      </span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function PaymentStep({
  email,
  subscriptionId,
  onError,
  onActivating,
  onDone,
  onProcessing,
}: {
  email: string;
  subscriptionId: string;
  onError: (message: string) => void;
  onActivating: () => void;
  onDone: () => void;
  onProcessing: () => void;
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
        return_url: `${window.location.origin}/?checkout=complete`,
        receipt_email: email,
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
      const result = await pollUntilActivated(subscriptionId, email);
      if (result === "activated") {
        onDone();
      } else if (result === "processing") {
        onProcessing();
      } else {
        // Stripe confirmed payment; activation is still pending. The webhook
        // will finish the job in the background — show the done state so the
        // user isn't blocked.
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
        {submitting ? "Processing…" : "Pay & activate"}
      </button>
    </form>
  );
}
