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

type PromoInfo = {
  name: string | null;
  kind: "percent" | "amount";
  percentOff?: number;
  amountOffCents?: number;
};

type Step =
  // The Checkout Session is created the moment the modal opens so the buyer's
  // localized price can show on the very first screen.
  | { kind: "init" }
  | { kind: "ready"; clientSecret: string; checkoutSessionId: string }
  | { kind: "activating"; email: string }
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

const ctaClass =
  "inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

const titleClass =
  "display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong";

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
  customAmount,
  onClose,
}: {
  open: boolean;
  plan: Plan;
  customAmount: number | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "init" });
  const [reloadKey, setReloadKey] = useState(0);
  const [promo, setPromo] = useState<PromoInfo | null>(null);
  const navigate = useNavigate();
  const { refresh } = useSubscriberAuth();
  const { theme } = useTheme();

  const handleClose = useCallback(() => {
    setStep({ kind: "init" });
    setPromo(null);
    onClose();
  }, [onClose]);

  // Create the Checkout Session as soon as the modal opens. Stripe localizes
  // the price (Adaptive Pricing) the moment the Elements provider loads it, so
  // the first screen can show what the buyer will actually pay.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      if (!publishableKey) {
        if (!cancelled) {
          setStep({
            kind: "error",
            message:
              "Stripe is not configured (VITE_STRIPE_PUBLISHABLE_KEY missing).",
          });
        }
        return;
      }
      try {
        const res = await fetch("/api/stripe/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan,
            custom_amount_cents:
              customAmount !== null ? Math.round(customAmount * 100) : undefined,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          client_secret?: string;
          checkout_session_id?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.client_secret || !data.checkout_session_id) {
          setStep({
            kind: "error",
            message: data.error ?? "Could not start checkout.",
          });
          return;
        }
        setStep({
          kind: "ready",
          clientSecret: data.client_secret,
          checkoutSessionId: data.checkout_session_id,
        });
      } catch {
        if (!cancelled) {
          setStep({ kind: "error", message: "Network error. Please try again." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan, customAmount, reloadKey]);

  // Auto-apply the active promo (if any) for this plan when the modal opens.
  // Display-only (the coupon Stripe actually charges is attached server-side at
  // session creation); failures fall back silently to full price.
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

      {step.kind === "init" ? (
        <>
          <h2 id="checkout-title" className={titleClass}>
            Complete your membership
          </h2>
          <LoadingRow label="Preparing checkout…" />
        </>
      ) : null}

      {step.kind === "ready" && stripePromiseValue ? (
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
          <CheckoutForm
            plan={plan}
            checkoutSessionId={step.checkoutSessionId}
            promo={promo}
            onActivating={(email) => setStep({ kind: "activating", email })}
            onActivated={handleActivated}
            onProcessing={(email) => setStep({ kind: "processing", email })}
          />
        </CheckoutElementsProvider>
      ) : null}

      {step.kind === "activating" ? (
        <>
          <h2 id="checkout-title" className={titleClass}>
            Complete your membership
          </h2>
          <LoadingRow label="Payment received — signing you in…" />
        </>
      ) : null}

      {step.kind === "processing" ? (
        <>
          <h2 id="checkout-title" className={titleClass}>
            Almost there
          </h2>
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
        </>
      ) : null}

      {step.kind === "error" ? (
        <>
          <h2 id="checkout-title" className={titleClass}>
            Something went wrong
          </h2>
          <div className="mt-6 space-y-3 text-sm">
            <p role="alert" className="text-danger">
              {step.message}
            </p>
            <button
              type="button"
              onClick={() => {
                setStep({ kind: "init" });
                setReloadKey((k) => k + 1);
              }}
              className="inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Try again
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

function PromoBanner({ promo }: { promo: PromoInfo }) {
  return (
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

// Lives inside CheckoutElementsProvider, so useCheckout() gives us the buyer's
// localized total (Adaptive Pricing) from the first screen. Two phases keep the
// original UX: enter email → pay.
function CheckoutForm({
  plan,
  checkoutSessionId,
  promo,
  onActivating,
  onActivated,
  onProcessing,
}: {
  plan: Plan;
  checkoutSessionId: string;
  promo: PromoInfo | null;
  onActivating: (email: string) => void;
  onActivated: () => void | Promise<void>;
  onProcessing: (email: string) => void;
}) {
  const checkoutState = useCheckout();
  const [phase, setPhase] = useState<"details" | "payment">("details");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const submittedRef = useRef(false);

  if (checkoutState.type === "loading") {
    return <LoadingRow label="Loading secure checkout…" />;
  }
  if (checkoutState.type === "error") {
    return (
      <>
        <h2 id="checkout-title" className={titleClass}>
          Complete your membership
        </h2>
        <p role="alert" className="mt-6 text-sm text-danger">
          {checkoutState.error.message}
        </p>
      </>
    );
  }

  const { checkout } = checkoutState;
  const intervalLabel = plan === "yearly" ? "year" : "month";
  // Stripe-formatted, localized strings in the buyer's selected currency.
  const total = checkout.total.total.amount; // after discount
  const subtotal = checkout.total.subtotal.amount; // before discount
  const hasDiscount = checkout.total.discount.minorUnitsAmount > 0;

  const continueToPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || working) return;
    setWorking(true);
    setEmailError(null);
    const result = await checkout.updateEmail(email.trim());
    setWorking(false);
    if (result.type === "error") {
      setEmailError(result.error.message ?? "Please enter a valid email.");
      return;
    }
    setPhase("payment");
  };

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    submittedRef.current = true;
    setWorking(true);
    setPayError(null);

    // redirect: 'if_required' keeps card payments in the modal; methods that
    // need an off-site step (e.g. 3DS) use the session's return_url.
    const result = await checkout.confirm({
      redirect: "if_required",
      email: email.trim(),
    });

    if (result.type === "error") {
      // A decline is retryable — stay on the payment form rather than tearing
      // down the session.
      submittedRef.current = false;
      setWorking(false);
      setPayError(result.error.message ?? "Payment failed. Please try again.");
      return;
    }

    // Payment confirmed. The subscription takes a moment to flip to active, so
    // poll for provisioning. Anything short of "ready" routes to the
    // bank-processing copy — never back to a pay button, which would risk a
    // double charge (the webhook finishes provisioning and emails a link).
    onActivating(email.trim());
    const poll = await pollForCheckoutSession(checkoutSessionId, email.trim());
    if (poll.kind === "ready") {
      await onActivated();
    } else {
      onProcessing(email.trim());
    }
  };

  return (
    <>
      <h2 id="checkout-title" className={titleClass}>
        {hasDiscount ? (
          <span className="mr-2 align-middle text-[0.58em] font-sans font-normal text-fg-muted line-through">
            {subtotal}
          </span>
        ) : null}
        {total}{" "}
        <span className="text-[14px] font-sans font-normal text-fg-muted">
          / {intervalLabel}
        </span>
      </h2>

      {promo ? <PromoBanner promo={promo} /> : null}

      {phase === "details" ? (
        <form onSubmit={continueToPayment} className="mt-6 space-y-4">
          <div>
            <span className="eyebrow text-fg-muted">Pay in</span>
            <div className="mt-2">
              <CurrencySelectorElement />
            </div>
          </div>
          <Field label="Email">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={working}
              placeholder="you@example.com"
              className={inputClass}
            />
          </Field>
          {emailError ? (
            <p role="alert" className="text-[12px] text-danger">
              {emailError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={working}
            aria-busy={working}
            className={ctaClass}
          >
            {working ? "Checking…" : "Continue to payment"}
          </button>
          <p className="text-[12px] leading-snug text-fg-muted">
            Payment is securely processed by Stripe. You'll receive a sign-in
            link by email once your membership is active.
          </p>
        </form>
      ) : (
        <form onSubmit={pay} className="mt-6 space-y-4">
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
              {total} / {intervalLabel}
            </span>
          </div>
          {payError ? (
            <p role="alert" className="text-[12px] text-danger">
              {payError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={working}
            aria-busy={working}
            className={ctaClass}
          >
            {working ? "Processing…" : `Pay ${total}`}
          </button>
        </form>
      )}
    </>
  );
}
