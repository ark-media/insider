import { useCallback, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Modal } from "./Modal";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { useTheme } from "../lib/theme";

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
  "w-full border border-rule-strong bg-transparent px-3 py-2.5 text-fg-strong placeholder:text-fg-placeholder outline-none transition focus:border-cyan disabled:opacity-50";

const MAX_POLL_ATTEMPTS = 15;

type CheckoutSessionResult =
  | { kind: "ready" }
  | { kind: "processing" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

// Polls /api/auth/checkout-session — the endpoint sets the session cookie
// and returns 200 once Stripe marks the subscription `active` AND we've
// provisioned the member's SC + Auth0 records; it returns 202 while we're
// still waiting on Stripe's state transition. We poll because Stripe takes
// a few hundred ms to flip incomplete -> active after the PaymentIntent
// confirms. credentials:'include' is required so the cookie sticks.
async function pollForCheckoutSession(
  subscriptionId: string,
  email: string,
  timeoutMs = 20000,
): Promise<CheckoutSessionResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    let res: Response;
    try {
      res = await fetch("/api/auth/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subscription_id: subscriptionId, email }),
      });
    } catch {
      return { kind: "error", message: "Network error. Please try again." };
    }
    if (res.status === 200) {
      return { kind: "ready" };
    }
    if (res.status === 202) {
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (data.status === "processing") return { kind: "processing" };
      // Still in transition — keep polling.
    } else if (res.status === 429) {
      // Rate-limited — wait the suggested interval and keep polling. The
      // window is small (~1s) so this is rarely user-visible.
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) =>
        setTimeout(r, Math.max(1000, retryAfter * 1000)),
      );
      continue;
    } else if (res.status >= 400) {
      // Anything else (403 forbidden, 410 expired window, 5xx) won't fix
      // itself by polling — surface the message and stop.
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        kind: "error",
        message:
          data.error ?? `Could not finish checkout (status ${res.status}).`,
      };
    }
    if (Date.now() >= deadline) return { kind: "timeout" };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { kind: "timeout" };
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
  const navigate = useNavigate();
  const { refresh } = useSubscriberAuth();
  const { theme } = useTheme();

  const handleClose = useCallback(() => {
    setStep({ kind: "details" });
    setEmail("");
    setName("");
    onClose();
  }, [onClose]);

  const handleActivated = useCallback(async () => {
    try {
      await refresh();
      onClose();
      void navigate({ to: "/setup" });
    } catch (err) {
      setStep({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not sign you in. Please try again.",
      });
    }
  }, [navigate, onClose, refresh]);

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
    <Modal
      open={open}
      onClose={handleClose}
      className="max-w-lg"
      labelledBy="checkout-title"
      describedBy="checkout-desc"
    >
      <p id="checkout-desc" className="eyebrow">
        Insider Membership · {plan === "yearly" ? "Annual" : "Monthly"}
      </p>
      <h2
        id="checkout-title"
        className="display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong"
      >
        ${displayAmount}{" "}
        <span className="text-[14px] font-sans font-normal text-fg-muted">
          / {intervalLabel}
        </span>
      </h2>

      {step.kind === "details" || step.kind === "creating" ? (
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
            aria-busy={step.kind === "creating"}
            className="inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {step.kind === "creating" ? "Preparing checkout…" : "Continue to payment"}
          </button>
          <p className="text-[12px] leading-snug text-fg-muted">
            Payment is securely processed by Stripe. You'll receive a sign-in
            link by email once your membership is active.
          </p>
        </form>
      ) : null}

      {step.kind === "payment" && stripePromiseValue ? (
        <Elements
          stripe={stripePromiseValue}
          options={{
            clientSecret: step.clientSecret,
            appearance: {
              theme: theme === "light" ? "stripe" : "night",
              labels: "floating",
            },
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
            onActivated={handleActivated}
            onProcessing={() =>
              setStep({ kind: "processing", email: step.email })
            }
          />
        </Elements>
      ) : null}

      {step.kind === "activating" ? (
        <div
          className="mt-6 flex items-center gap-3 text-sm text-fg"
          role="status"
          aria-live="polite"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none" />
          <span>Payment received — signing you in…</span>
        </div>
      ) : null}

      {step.kind === "processing" ? (
        <div className="mt-6 space-y-3 text-sm text-fg">
          <p>
            Your payment is being processed by your bank. We'll email{" "}
            <span
              className="font-semibold text-fg-strong break-all"
              title={step.email}
            >
              {step.email}
            </span>{" "}
            a sign-in link as soon as it clears (usually within a few minutes).
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Close
          </button>
        </div>
      ) : null}

      {step.kind === "error" ? (
        <div className="mt-6 space-y-3 text-sm">
          <p role="alert" className="text-danger">{step.message}</p>
          <button
            type="button"
            onClick={() => setStep({ kind: "details" })}
            className="inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Try again
          </button>
        </div>
      ) : null}
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
      <span className="eyebrow text-fg-muted">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function PaymentStep({
  email,
  subscriptionId,
  onError,
  onActivating,
  onActivated,
  onProcessing,
}: {
  email: string;
  subscriptionId: string;
  onError: (message: string) => void;
  onActivating: () => void;
  onActivated: () => void | Promise<void>;
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
      const result = await pollForCheckoutSession(subscriptionId, email);
      if (result.kind === "ready") {
        await onActivated();
      } else if (result.kind === "processing") {
        onProcessing();
      } else if (result.kind === "error") {
        onError(result.message);
      } else {
        // Timeout: Stripe confirmed payment but our provisioning didn't
        // finish in 20s. The webhook will complete it in the background and
        // email a password-reset link, so route the user to the
        // bank-processing copy rather than stranding them.
        onProcessing();
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
        aria-busy={submitting}
        className="inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
      >
        {submitting ? "Processing…" : "Pay & activate"}
      </button>
    </form>
  );
}
