import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  CheckoutElementsProvider,
  CurrencySelectorElement,
  PaymentElement,
  useCheckout,
} from "@stripe/react-stripe-js/checkout";
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
      checkoutSessionId: string;
      email: string;
    }
  | { kind: "activating"; checkoutSessionId: string; email: string }
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
// a few hundred ms to flip the Checkout Session's subscription to active
// after the payment confirms. credentials:'include' is required so the cookie
// sticks.
async function pollForCheckoutSession(
  checkoutSessionId: string,
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
        body: JSON.stringify({
          checkout_session_id: checkoutSessionId,
          email,
        }),
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
  const [promo, setPromo] = useState<{
    name: string | null;
    kind: "percent" | "amount";
    percentOff?: number;
    amountOffCents?: number;
  } | null>(null);
  const navigate = useNavigate();
  const { refresh } = useSubscriberAuth();
  const { theme } = useTheme();

  const handleClose = useCallback(() => {
    setStep({ kind: "details" });
    setEmail("");
    setName("");
    setPromo(null);
    onClose();
  }, [onClose]);

  // Auto-apply the active promo (if any) for this plan when the modal opens.
  // The discount the server actually charges is re-discovered at create time;
  // this is display-only, so failures fall back silently to full price.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/promo/active?plan=${plan}`);
        const data = (await res.json().catch(() => ({}))) as {
          active?: boolean;
          name?: string | null;
          kind?: "percent" | "amount";
          percent_off?: number;
          amount_off_cents?: number;
        };
        if (
          !cancelled &&
          data.active &&
          (data.kind === "percent" || data.kind === "amount")
        ) {
          setPromo({
            name: data.name ?? null,
            kind: data.kind,
            percentOff: data.percent_off,
            amountOffCents: data.amount_off_cents,
          });
        }
      } catch {
        /* non-fatal: full price */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan]);

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

  // USD source amount — the price Adaptive Pricing converts from. Shown on the
  // details step; the buyer's localized total comes from Stripe on the payment
  // step (see PaymentStep).
  const amountCents =
    customAmount !== null ? Math.round(customAmount * 100) : defaultAmount * 100;
  const discountedCents = promo
    ? promo.kind === "percent"
      ? Math.round(amountCents * (1 - (promo.percentOff ?? 0) / 100))
      : Math.max(0, amountCents - (promo.amountOffCents ?? 0))
    : amountCents;
  const displayAmount = (discountedCents / 100).toFixed(2);
  const originalAmount = (amountCents / 100).toFixed(2);
  const intervalLabel = plan === "yearly" ? "year" : "month";
  const showSourcePrice = step.kind === "details" || step.kind === "creating";

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
      const res = await fetch("/api/stripe/create-checkout-session", {
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
        checkout_session_id?: string;
        error?: string;
      };
      if (!res.ok || !data.client_secret || !data.checkout_session_id) {
        setStep({
          kind: "error",
          message: data.error ?? "Could not start checkout.",
        });
        return;
      }
      setStep({
        kind: "payment",
        clientSecret: data.client_secret,
        checkoutSessionId: data.checkout_session_id,
        email: email.trim(),
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
      {showSourcePrice ? (
        <h2
          id="checkout-title"
          className="display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong"
        >
          {promo ? (
            <span className="mr-2 align-middle text-[0.58em] font-sans font-normal text-fg-muted line-through">
              ${originalAmount}
            </span>
          ) : null}
          ${displayAmount}{" "}
          <span className="text-[14px] font-sans font-normal text-fg-muted">
            / {intervalLabel}
          </span>
        </h2>
      ) : (
        <h2
          id="checkout-title"
          className="display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong"
        >
          Complete your membership
        </h2>
      )}

      {showSourcePrice && promo ? (
        <p
          role="status"
          className="mt-3 border border-cyan/50 bg-cyan/10 px-3 py-2 text-[13px] text-fg-strong"
        >
          <span className="font-semibold">
            {promo.kind === "percent"
              ? `${promo.percentOff}% off`
              : `$${((promo.amountOffCents ?? 0) / 100).toFixed(2)} off`}
          </span>{" "}
          applied automatically{promo.name ? ` — ${promo.name}` : ""}.
        </p>
      ) : null}

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
            Prices are in USD. You'll choose your currency and pay the local
            equivalent on the next step. Payment is securely processed by
            Stripe; you'll receive a sign-in link by email once your membership
            is active.
          </p>
        </form>
      ) : null}

      {step.kind === "payment" && stripePromiseValue ? (
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
          <PaymentStep
            email={step.email}
            checkoutSessionId={step.checkoutSessionId}
            intervalLabel={intervalLabel}
            onError={(message) => setStep({ kind: "error", message })}
            onActivating={() =>
              setStep({
                kind: "activating",
                checkoutSessionId: step.checkoutSessionId,
                email: step.email,
              })
            }
            onActivated={handleActivated}
            onProcessing={() =>
              setStep({ kind: "processing", email: step.email })
            }
          />
        </CheckoutElementsProvider>
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
  checkoutSessionId,
  intervalLabel,
  onError,
  onActivating,
  onActivated,
  onProcessing,
}: {
  email: string;
  checkoutSessionId: string;
  intervalLabel: string;
  onError: (message: string) => void;
  onActivating: () => void;
  onActivated: () => void | Promise<void>;
  onProcessing: () => void;
}) {
  const checkoutState = useCheckout();
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  if (checkoutState.type === "loading") {
    return (
      <div
        className="mt-6 flex items-center gap-3 text-sm text-fg"
        role="status"
        aria-live="polite"
      >
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none" />
        <span>Loading secure checkout…</span>
      </div>
    );
  }

  if (checkoutState.type === "error") {
    return (
      <p role="alert" className="mt-6 text-sm text-danger">
        {checkoutState.error.message}
      </p>
    );
  }

  const { checkout } = checkoutState;
  // Stripe-formatted, localized total (e.g. "$8.00" or "₪29.00") including any
  // applied discount and the buyer's selected currency.
  const localizedTotal = checkout.total.total.amount;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);

    // redirect: 'if_required' keeps card payments in the modal; methods that
    // need an off-site step (e.g. 3DS) use the session's return_url.
    const result = await checkout.confirm({ redirect: "if_required", email });

    if (result.type === "error") {
      submittedRef.current = false;
      setSubmitting(false);
      onError(result.error.message ?? "Payment failed.");
      return;
    }

    // Confirmed in place. The subscription may take a moment to flip to
    // active; poll until provisioning completes.
    onActivating();
    const poll = await pollForCheckoutSession(checkoutSessionId, email);
    if (poll.kind === "ready") {
      await onActivated();
    } else if (poll.kind === "processing") {
      onProcessing();
    } else if (poll.kind === "error") {
      onError(poll.message);
    } else {
      // Timeout: payment confirmed but provisioning didn't finish in 20s. The
      // webhook completes it in the background and emails a sign-in link, so
      // route to the bank-processing copy rather than stranding the user.
      onProcessing();
    }
  };

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <div>
        <span className="eyebrow text-fg-muted">Pay in</span>
        <div className="mt-2">
          <CurrencySelectorElement />
        </div>
      </div>
      <PaymentElement />
      <div className="flex items-baseline justify-between border-t border-rule pt-3 text-sm">
        <span className="text-fg-muted">Total</span>
        <span className="font-semibold text-fg-strong">
          {localizedTotal} / {intervalLabel}
        </span>
      </div>
      <button
        type="submit"
        disabled={submitting}
        aria-busy={submitting}
        className="inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
      >
        {submitting ? "Processing…" : `Pay ${localizedTotal}`}
      </button>
    </form>
  );
}
