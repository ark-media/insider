import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import {
  BillingAddressElement,
  CheckoutElementsProvider,
  ExpressCheckoutElement,
  PaymentElement,
  useCheckout,
  type StripeCheckoutElementsValue,
} from "@stripe/react-stripe-js/checkout";
import { CheckoutConsent } from "./CheckoutConsent";
import { PromoBanner, PromoCode } from "./PromoCode";
import { fetchActivePromo, type PromoInfo } from "../lib/promo";
import { useCheckoutConsent, type Renewal } from "../lib/checkoutConsent";
import { billingPeriod } from "../../shared/checkout-consent";
import { Modal } from "./Modal";
import { CurrencySelect } from "./CurrencySelect";
import { LoadingRow } from "./Spinner";
import { modalPrimaryCta, modalSecondaryCta } from "../lib/modalCta";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { useTheme } from "../lib/theme";
import { trackEvent } from "../lib/analytics";
import { getAttribution } from "../lib/attribution";
import {
  type PricingResponse,
  browserCountry,
  currencySymbol,
  decimalsForCurrency,
  formatMajor,
  toMajor,
  toMinor,
} from "../lib/currency";
import {
  SLIDER_STEPS,
  amountFromPos,
  posFromAmount,
  snapStep,
} from "../lib/pwycSlider";
import { ProductMarks } from "./FoldLogo";
import type { ProductMark } from "../data/pricingTiers";

type Plan = "monthly" | "yearly";
type Tier = "ark-plus" | "circle" | "bundle";

// The slider's drag ceiling and the typed safety cap are expressed as multiples
// of the plan's floor so they hold in any currency (a fixed "$3,600" is
// meaningless in ¥ or ₪). SLIDER_MAX = the top of the *drag range* (not a hard
// cap — the field accepts up to INPUT_MAX beyond it). ~14.4× the floor mirrors
// the $250 → $3,600 USD range (bundle yearly); ~400× mirrors the old $50k typed
// ceiling. The curve/snap math lives in ../lib/pwycSlider.
const SLIDER_MAX_MULTIPLE = 14.4;
const INPUT_MAX_MULTIPLE = 400;

// The SKU label shown in the modal chrome. Checkout derives entitlements from
// the tier's catalog product server-side; this is copy only.
const TIER_LABEL: Record<Tier, string> = {
  "ark-plus": "Ark+ Membership",
  circle: "The Fold",
  bundle: "Ark+ & The Fold",
};

// The brand marks beside that label, mirroring the tier cards on /plus so the
// modal reads as a continuation of the card the buyer just clicked. Same grant
// as TIERS[].marks in data/pricingTiers.ts.
const TIER_MARKS: Record<Tier, ProductMark[]> = {
  "ark-plus": ["ark-plus"],
  circle: ["fold"],
  bundle: ["ark-plus", "fold"],
};

type Step =
  // Email is collected before the Checkout Session is created so the server
  // can pre-create the Stripe Customer with it — see the matching note in
  // server/routes/stripe.ts. The localized price (Adaptive Pricing) renders
  // on the payment screen once Elements has the session.
  | { kind: "email" }
  | { kind: "creating" }
  | {
      kind: "ready";
      clientSecret: string;
      checkoutSessionId: string;
      email: string;
    }
  | { kind: "activating"; email: string }
  | { kind: "processing"; email: string }
  | { kind: "already_subscribed"; email: string; message: string }
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

const ctaClass = modalPrimaryCta;

const titleClass =
  "display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong";

// The screen a fresh modal opens on. The publishable key is a module-level
// build-time value, so this is decided synchronously here rather than in an
// effect that would paint the email form and then swap it for the error.
function initialStep(): Step {
  if (!publishableKey) {
    return {
      kind: "error",
      message: "Stripe is not configured (VITE_STRIPE_PUBLISHABLE_KEY missing).",
    };
  }
  return { kind: "email" };
}

const MAX_POLL_ATTEMPTS = 15;

type CheckoutSessionResult =
  | { kind: "ready" }
  | { kind: "processing" }
  | { kind: "already_subscribed"; message: string }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

// Polls /api/auth/checkout-session — the endpoint sets the session cookie
// and returns 200 once Stripe marks the subscription `active` AND we've
// provisioned the member's Beehiiv + Auth0 records; it returns 202 while we're
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
      // itself by polling — surface the message and stop. 409 with the
      // already_subscribed code is a distinct terminal state: the buyer paid
      // but already had an active membership, so we route them to a sign-in
      // screen instead of a generic retry.
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (res.status === 409 && data.code === "already_subscribed") {
        return {
          kind: "already_subscribed",
          message:
            data.error ?? "This email already has an active membership.",
        };
      }
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

// `tier` is required, not defaulted. It used to default to "ark-plus", so an
// entry point that forgot the prop silently sold — and priced — the wrong thing
// instead of failing. The type system is the only thing that catches that.
export function CheckoutModal({
  open,
  plan,
  tier,
  onClose,
}: {
  open: boolean;
  plan: Plan;
  tier: Tier;
  onClose: () => void;
}) {
  // Stripe.js is required before we can render Elements, decided synchronously
  // (see initialStep). Otherwise nothing else to do until the buyer submits
  // their email, which triggers session creation.
  const [step, setStep] = useState<Step>(() => initialStep());
  // Last submitted email — persists across retries so the form repopulates
  // after an error rather than asking the buyer to retype it.
  const [lastEmail, setLastEmail] = useState("");
  const [promo, setPromo] = useState<PromoInfo | null>(null);
  // Per-currency pricing, fetched on open — the slider's floor and the amount
  // checkout charges. Pay-what-you-choose lives on this screen, so the modal
  // owns the price it needs. `currency` is the presentment/charge currency:
  // seeded from the geo-detected default, changeable via the selector.
  const [pricing, setPricing] = useState<PricingResponse | null>(null);
  const [currency, setCurrency] = useState<string>("usd");
  // Whether the buyer raised the amount above the floor — read at the bottom of
  // the funnel (after the session is gone) for the checkout_succeeded event.
  const customAmountRef = useRef<number | null>(null);
  const { refresh, signIn } = useSubscriberAuth();
  const { theme } = useTheme();

  // The pricing grids keep ONE modal mounted behind every card and swap `tier`
  // as cards are clicked, so per-purchase state cannot be settled once at
  // mount — a modal left on the previous visit's tier would carry that visit's
  // email, promo and pricing into this one.
  //
  // So it is re-derived whenever the purchase changes — during render rather
  // than in an effect, which would paint the stale screen for a frame first,
  // and inside the component rather than as a `key` at the call sites, which
  // would hand every future entry point the same hole.
  const [purchase, setPurchase] = useState({ open, tier });
  if (purchase.open !== open || purchase.tier !== tier) {
    setPurchase({ open, tier });
    setStep(initialStep());
    setLastEmail("");
    setPromo(null);
    setPricing(null);
    setCurrency("usd");
    // customAmountRef is deliberately not cleared here: it is written on every
    // submit and read only after one, so it cannot carry across a purchase —
    // and writing a ref during render is exactly what refs are not for.
  }

  // The tier+plan floor in the selected currency (minor units) and that
  // currency's minor-unit factor — everything the slider/hero needs.
  const tierAmounts = pricing?.tiers[tier];
  const floorMinor =
    tierAmounts?.[plan === "yearly" ? "yearly" : "monthly"]?.[currency] ?? null;
  const factor = pricing?.minor_factors[currency] ?? 100;

  // Closing only tells the parent — `onClose` is called directly everywhere
  // below. Resetting is the block above's job, which runs on the `open` flip
  // every close produces, so a modal closed by the overlay, by Escape, or by a
  // caller that never routes through here can't reopen carrying the last
  // purchase's answers.

  // The house sale for this purchase, and the code that applies it — the
  // payment step needs the code, because the Session allows promotion codes
  // instead of carrying a server-set discount (see server/routes/promo.ts).
  // Tier and currency are part of the question: they decide the list price the
  // coupons are ranked against, and a fixed-amount coupon in the wrong currency
  // can't apply at all. Failures fall back silently to full price.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const active = await fetchActivePromo({ plan, tier, currency });
      if (!cancelled) setPromo(active);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan, tier, currency]);

  // Fetch per-currency pricing on open so the slider knows its floor and the
  // buyer sees their local currency. Prices come from /api/pricing (Stripe, the
  // source of truth) — never hardcoded. The response carries a geo-detected
  // default currency; we seed the selector with it. While it loads the slider
  // stays disabled; a failure leaves it disabled and the buyer checks out at
  // the floor in USD.
  //
  // Keyed on `tier` as well as `open`, because the reset block above clears
  // `pricing` and `currency` on a tier change too. Without it, a grid that
  // swaps tiers on ONE mounted modal (which is what the grids do) cleared the
  // pricing and never fetched it again: a dead slider, a dead currency
  // selector, and a buyer whose geo currency was GBP checked out in USD.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        // Pass the browser-locale country as a soft hint so the default
        // currency is still localized when the platform geo header is absent
        // (local dev, or a proxy that strips it). In production the real geo IP
        // wins over this hint server-side — see server/routes/pricing.ts.
        const hint = browserCountry();
        const res = await fetch(
          `/api/pricing${hint ? `?locale_hint=${encodeURIComponent(hint)}` : ""}`,
        );
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as PricingResponse | null;
        if (cancelled || !data?.tiers) return;
        setPricing(data);
        if (typeof data.default_currency === "string") {
          setCurrency(data.default_currency);
        }
      } catch {
        /* non-fatal: buyer checks out at the floor */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tier]);

  const submitEmail = useCallback(
    // customAmountMinor is already in the selected currency's minor units (the
    // slider/field converts via the currency factor), or null to charge the
    // floor. currency is the presentment/charge currency.
    async (
      email: string,
      customAmountMinor: number | null,
      selectedCurrency: string,
    ) => {
      setLastEmail(email);
      customAmountRef.current = customAmountMinor;
      trackEvent("checkout_email_submitted", {
        plan,
        tier,
        is_custom_amount: customAmountMinor !== null,
      });
      setStep({ kind: "creating" });
      try {
        const res = await fetch("/api/stripe/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            plan,
            tier,
            currency: selectedCurrency,
            custom_amount_cents: customAmountMinor ?? undefined,
            // Ride the acquisition channel into Stripe's subscription metadata
            // so the webhook's server-side revenue events carry attribution
            // without having to rejoin to this browser session (BI plan §4.1).
            // Server-side allowlisted — see shared/attribution.ts.
            attribution: getAttribution(),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          client_secret?: string;
          checkout_session_id?: string;
          error?: string;
        };
        if (!res.ok || !data.client_secret || !data.checkout_session_id) {
          trackEvent("checkout_failed", {
            plan,
            stage: "create_session",
            reason: data.error ?? `status ${res.status}`,
          });
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
          email,
        });
      } catch {
        trackEvent("checkout_failed", {
          plan,
          stage: "create_session",
          reason: "network_error",
        });
        setStep({
          kind: "error",
          message: "Network error. Please try again.",
        });
      }
    },
    [plan, tier],
  );

  const handleActivated = useCallback(
    async (email: string) => {
      // Reached only after the poll confirms an active, provisioned
      // subscription — the true bottom of the funnel.
      trackEvent("checkout_succeeded", {
        plan,
        tier,
        is_custom_amount: customAmountRef.current !== null,
      });
      try {
        await refresh();
        onClose();
        // Hand off to the Ark+ welcome flow (lives on the ark-plus.xyz host).
        window.location.assign("https://ark-plus.xyz/welcome");
      } catch {
        // Payment confirmed and the webhook will provision the user; the
        // refresh failed locally. Routing back to the EmailForm would risk
        // a second Checkout Session (and potentially a double charge), so
        // land on the processing screen — the buyer gets the "we'll email
        // you a link" copy that matches the polling-timeout case.
        setStep({ kind: "processing", email });
      }
    },
    [onClose, refresh, plan, tier],
  );

  const stripePromiseValue = getStripe();

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="max-w-lg"
      labelledBy="checkout-title"
      describedBy="checkout-desc"
      scrollBody
    >
      {/* Clears the Modal's close button, which overlays the panel's top-right
          corner (44px wide, inset 8px) rather than taking part in the layout.
          Without the padding this line runs underneath it on a phone, where
          the longest tier label and the period barely fit the width as it is —
          it wraps to two lines instead, which is the harmless outcome. */}
      <p id="checkout-desc" className="flex items-center gap-2 eyebrow pr-10">
        <ProductMarks marks={TIER_MARKS[tier]} size="sm" />
        <span>
          {TIER_LABEL[tier]} · {plan === "yearly" ? "Annual" : "Monthly"}
        </span>
      </p>

      {step.kind === "email" ? (
        <EmailForm
          plan={plan}
          initialEmail={lastEmail}
          promo={promo}
          floorMinor={floorMinor}
          currency={currency}
          factor={factor}
          currencies={pricing?.currencies ?? null}
          onCurrencyChange={setCurrency}
          onSubmit={submitEmail}
        />
      ) : null}

      {step.kind === "creating" ? (
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
            // Currency is fixed on the Session server-side (from currency_options,
            // per §7 #4) — no Adaptive Pricing / CurrencySelectorElement here; the
            // buyer chose their currency before the Session was created.
          }}
        >
          <CheckoutForm
            plan={plan}
            checkoutSessionId={step.checkoutSessionId}
            email={step.email}
            promo={promo}
            theme={theme}
            onActivating={(email) => setStep({ kind: "activating", email })}
            onActivated={handleActivated}
            onProcessing={(email) => setStep({ kind: "processing", email })}
            onAlreadySubscribed={(email, message) =>
              setStep({ kind: "already_subscribed", email, message })
            }
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

      {step.kind === "already_subscribed" ? (
        <>
          <h2 id="checkout-title" className={titleClass}>
            You're already a member
          </h2>
          <div className="mt-6 space-y-4 text-sm text-fg">
            <p role="alert">{step.message}</p>
            <button
              type="button"
              // They already have a membership, so this is a "take me to my
              // stuff" sign-in, not a contextual one — land on /account rather
              // than returning to whatever page the modal was opened over.
              onClick={() => signIn("/account", { loginHint: step.email })}
              className={ctaClass}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={onClose}
              className={modalSecondaryCta}
            >
              Close
            </button>
          </div>
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
              onClick={onClose}
              className={`mt-4 ${modalSecondaryCta}`}
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
              onClick={() => setStep({ kind: "email" })}
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

// First screen of the modal: just an email. Submitting creates the Checkout
// Session server-side (with the Customer pre-set to this email) and advances
// to the payment screen. Lives outside CheckoutElementsProvider — no Session
// exists yet — so it can't use useCheckout.
// Exported for tests — the currency-reset behaviour below is not reachable
// through CheckoutModal without a live Stripe session.
export function EmailForm({
  plan,
  initialEmail,
  promo,
  floorMinor,
  currency,
  factor,
  currencies,
  onCurrencyChange,
  onSubmit,
}: {
  plan: Plan;
  initialEmail: string;
  promo: PromoInfo | null;
  floorMinor: number | null;
  currency: string;
  factor: number;
  currencies: string[] | null;
  onCurrencyChange: (currency: string) => void;
  onSubmit: (
    email: string,
    customAmountMinor: number | null,
    currency: string,
  ) => void | Promise<void>;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // The chosen amount lives here as a string in MAJOR units of the selected
  // currency ("" = give the floor / catalog price). Slider + tap-to-type write it.
  const [customAmount, setCustomAmount] = useState("");
  // Tap-to-type: while editing, the hero amount becomes an input backed by this
  // draft so the slider doesn't twitch on every keystroke — it commits on blur.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Visual hint on the slider once the floor is in — a jump, then a pulsing
  // ring — without changing the charged amount. Stripped on pointerdown.
  const [nudge, setNudge] = useState(false);
  const nudged = useRef(false);
  const intervalLabel = plan === "yearly" ? "year" : "month";
  const shortInterval = plan === "yearly" ? "yr" : "mo";
  const floorReady = floorMinor !== null;

  // Switching currency resets the chosen amount to the new floor — a raw number
  // carried across currencies is meaningless (300 USD ≠ 300 JPY). Adjusted
  // during render rather than in an effect so the reset lands in the same pass
  // as the currency change, with no interim frame showing the stale amount.
  const [prevCurrency, setPrevCurrency] = useState(currency);
  if (prevCurrency !== currency) {
    setPrevCurrency(currency);
    setCustomAmount("");
    setEditing(false);
  }

  useEffect(() => {
    if (!floorReady || nudged.current) return;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    nudged.current = true;
    if (reduceMotion) return;
    setNudge(true);
  }, [floorReady]);

  const stopNudge = () => {
    if (nudge) setNudge(false);
  };

  // Everything below works in MAJOR units of the selected currency. The floor is
  // what we charge if the buyer doesn't raise it; the slider drags up to
  // sliderMax (the common range) and the field accepts up to inputMax (an
  // effectively-unlimited safety ceiling) — both scaled off the floor so they
  // hold in any currency. The effective amount is clamped into [floor, inputMax],
  // so a sub-floor entry snaps up and anything above sliderMax pegs the thumb.
  const floorMajor = floorMinor !== null ? toMajor(floorMinor, factor) : null;
  // Display/input decimals follow the currency (0 for JPY/HUF/TWD), NOT the
  // charge factor — HUF/TWD charge in hundredths but show whole units, so the
  // field must round to whole to keep the minor amount divisible by 100.
  const decimals = decimalsForCurrency(currency, factor);
  const sliderMaxMajor = floorMajor !== null ? floorMajor * SLIDER_MAX_MULTIPLE : 0;
  const inputMaxMajor = floorMajor !== null ? floorMajor * INPUT_MAX_MULTIPLE : 0;
  const step = floorMajor !== null ? snapStep(floorMajor) : 1;

  const parsedCustom = customAmount.trim() === "" ? null : Number(customAmount);
  const effectiveAmount =
    floorMajor === null
      ? null
      : parsedCustom !== null && Number.isFinite(parsedCustom)
        ? Math.min(inputMaxMajor, Math.max(floorMajor, parsedCustom))
        : floorMajor;
  // Custom = strictly above the floor. At/below the floor we hand checkout the
  // fixed catalog price (null) rather than an equal custom amount.
  const isCustom =
    effectiveAmount !== null && floorMajor !== null && effectiveAmount > floorMajor;

  // Thumb position + fill %, derived from the amount via the eased curve. Above
  // sliderMax the thumb pegs at the far right (posFromAmount clamps).
  const sliderPos =
    floorMajor !== null && effectiveAmount !== null
      ? posFromAmount(effectiveAmount, floorMajor, sliderMaxMajor)
      : 0;
  const sliderPct = (sliderPos / SLIDER_STEPS) * 100;

  const roundMajor = (v: number) =>
    decimals === 0 ? Math.round(v) : Math.round(v * 100) / 100;

  const commitDraft = () => {
    setEditing(false);
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || floorMajor === null) return;
    const clean = roundMajor(Math.min(inputMaxMajor, Math.max(floorMajor, n)));
    setCustomAmount(clean <= floorMajor ? "" : String(clean));
    trackEvent("custom_amount_entered", {
      plan,
      amount: clean,
      currency,
      valid: clean > floorMajor,
    });
  };

  const startEdit = () => {
    if (floorMajor === null) return;
    stopNudge();
    setDraft(effectiveAmount !== null ? String(effectiveAmount) : "");
    setEditing(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || working) return;
    // Loose client-side check; the server is the real validator.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Please enter a valid email.");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      // A raised amount checks out at that figure (converted to minor units);
      // the floor hands checkout the fixed catalog price (null).
      await onSubmit(
        trimmed,
        isCustom && effectiveAmount !== null ? toMinor(effectiveAmount, factor) : null,
        currency,
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <h2 id="checkout-title" className={titleClass}>
        Complete your membership
      </h2>
      {promo ? <PromoBanner promo={promo} /> : null}

      {/* Pay what you choose — the floor is the minimum. A one-shot thumb
          nudge invites a first drag; helper copy and the CTA then reflect
          whether the buyer stayed at the floor or gave more. Tap the hero
          amount to type an exact figure. A currency selector (seeded from
          the buyer's locale) sits alongside. Disabled until the floor loads. */}
      <div className="mt-6 border-t border-rule pt-5">
        <div className="flex items-center justify-between gap-3">
          <span className="eyebrow text-fg-muted">Choose your amount</span>
          {currencies && currencies.length > 1 ? (
            <CurrencySelect
              value={currency}
              options={currencies}
              disabled={floorMajor === null}
              onChange={onCurrencyChange}
            />
          ) : null}
        </div>

        {/* Hero amount — the focal point. Tap to type an exact figure. */}
        <div className="mt-3 flex items-baseline gap-2">
          {editing ? (
            <>
              <span className="display-upright text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong">
                {currencySymbol(currency)}
              </span>
              <input
                type="number"
                inputMode="decimal"
                aria-label={`Amount per ${intervalLabel}`}
                autoFocus
                min={floorMajor ?? undefined}
                max={inputMaxMajor}
                step={decimals === 0 ? 1 : "any"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDraft();
                  } else if (e.key === "Escape") {
                    setEditing(false);
                  }
                }}
                className="pwyc-amount-input display-upright min-w-0 bg-transparent text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong outline-none"
              />
              <span className="text-lg text-fg-muted">/{shortInterval}</span>
            </>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              disabled={floorMajor === null}
              className="group inline-flex items-baseline gap-2 rounded-sm text-left outline-none transition disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
              aria-label={
                effectiveAmount !== null
                  ? `Amount: ${formatMajor(effectiveAmount, currency)} per ${intervalLabel}. Tap to type an exact figure.`
                  : "Amount, tap to type"
              }
            >
              <span className="display-upright text-[clamp(2.25rem,8vw,3rem)] leading-none text-fg-strong tabular-nums">
                {effectiveAmount !== null
                  ? formatMajor(effectiveAmount, currency)
                  : "—"}
              </span>
              <span className="text-lg text-fg-muted">/{shortInterval}</span>
              {/* Pencil affordance — signals the amount is editable. */}
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 self-center text-fg-faint transition group-hover:text-cyan"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          )}
        </div>

        <input
          type="range"
          aria-label={`Amount per ${intervalLabel}`}
          aria-valuetext={
            effectiveAmount !== null
              ? `${formatMajor(effectiveAmount, currency)} per ${intervalLabel}`
              : undefined
          }
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderPos}
          disabled={floorMajor === null}
          onPointerDown={stopNudge}
          onChange={(e) => {
            if (floorMajor === null) return;
            stopNudge();
            const a = amountFromPos(
              Number(e.target.value),
              floorMajor,
              sliderMaxMajor,
              step,
            );
            // The leftmost stop maps back to the floor; clearing to "" hands
            // checkout the fixed catalog price.
            setCustomAmount(a <= floorMajor ? "" : String(a));
          }}
          onBlur={() => {
            if (effectiveAmount === null) return;
            trackEvent("custom_amount_entered", {
              plan,
              amount: effectiveAmount,
              currency,
              valid: isCustom,
            });
          }}
          className={`pwyc-slider mt-5 w-full${nudge ? " pwyc-slider--nudge" : ""}`}
          style={{ "--pct": `${sliderPct}%` } as React.CSSProperties}
        />

        {/* Floor label only — we intentionally don't advertise a maximum, since
            the amount field accepts more than the slider's drag range. */}
        {floorMajor !== null ? (
          <div className="mt-2 text-xs tabular-nums text-fg-faint">
            {formatMajor(floorMajor, currency)} minimum
          </div>
        ) : null}

        <p className="mt-3 text-body-sm">
          {floorMajor === null
            ? "Loading price…"
            : isCustom
              ? "Thank you for supporting our mission."
              : "Give more to sustain independent Jewish media."}
        </p>
      </div>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Email">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={working}
            placeholder="you@example.com"
            className={inputClass}
            autoFocus
          />
        </Field>
        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={working}
          aria-busy={working}
          className={ctaClass}
        >
          {working
            ? "Loading…"
            : effectiveAmount !== null
              ? `Continue at ${formatMajor(effectiveAmount, currency)}/${shortInterval}`
              : "Continue to payment"}
        </button>
        <p className="text-body-sm">
          You'll receive a sign-in link by email once your membership is
          active.
        </p>
      </form>
    </>
  );
}

// What the buyer is asked to accept as the recurring charge.
// `recurring.dueNext.total` is what Stripe will actually take on the next
// cycle — a first-period-only discount has already fallen away from it, and the
// tax the billing address implies is already in it — so it is the number the
// disclosure has to name, not today's total and not the pre-tax list price.
//
// If Stripe ever hands back a subscription session without `recurring`, `plan`
// supplies the period and the amount is DROPPED. Today's total is the one
// number we know is wrong for this sentence: a first-month-only code and
// today's tax are both inside it, and the sentence is stamped on the Session as
// the evidence of what was agreed. A subscription must never lose the sentence,
// only its precision.
function renewalDisclosure(
  session: StripeCheckoutElementsValue | null,
  plan: Plan,
): Renewal | null {
  if (!session) return null;
  return {
    amount: session.recurring?.dueNext.total.amount ?? null,
    period: session.recurring
      ? billingPeriod(
          session.recurring.interval,
          session.recurring.intervalCount,
        )
      : `per ${plan === "yearly" ? "year" : "month"}`,
  };
}

// Lives inside CheckoutElementsProvider, so useCheckout() gives us the buyer's
// localized total (Adaptive Pricing). Email is already on the Customer (set
// server-side when the Session was created), so this screen is payment-only.
function CheckoutForm({
  plan,
  checkoutSessionId,
  email,
  promo,
  theme,
  onActivating,
  onActivated,
  onProcessing,
  onAlreadySubscribed,
}: {
  plan: Plan;
  checkoutSessionId: string;
  email: string;
  promo: PromoInfo | null;
  theme: "light" | "dark";
  onActivating: (email: string) => void;
  onActivated: (email: string) => void | Promise<void>;
  onProcessing: (email: string) => void;
  onAlreadySubscribed: (email: string, message: string) => void;
}) {
  const checkoutState = useCheckout();
  const [payError, setPayError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const submittedRef = useRef(false);
  // Wallet (Apple Pay / Google Pay) availability, reported by the Express
  // Checkout Element's onReady. "pending" until Stripe probes the device;
  // "none" on browsers/devices with no eligible wallet (most desktops) so we
  // render neither the buttons nor the "or pay with card" divider.
  const [walletState, setWalletState] = useState<"pending" | "available" | "none">(
    "pending",
  );
  // Every hook has to run before the loading/error returns below, so the
  // renewal the buyer is asked to accept is derived from whatever session
  // exists right now — null until Stripe has one, which is also the window in
  // which no pay button is rendered.
  const renewal = renewalDisclosure(
    checkoutState.type === "success" ? checkoutState.checkout : null,
    plan,
  );
  const consent = useCheckoutConsent(renewal);
  const consentRef = useRef<HTMLDivElement>(null);

  // Send an unaccepted buyer to the box that's still empty. Both pay paths use
  // it, and the wallet path needs it most: its buttons sit at the top of the
  // form, a screenful above the checkboxes that gate them.
  const focusConsent = () => {
    const box = consentRef.current?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]:not(:checked)',
    );
    box?.focus();
    box?.scrollIntoView?.({ block: "center" });
  };

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
  // Stripe-formatted, localized strings in the buyer's selected currency
  // (Adaptive Pricing). Tax is exclusive, so `subtotal` is the pre-tax
  // recurring list price, `taxExclusive` is the tax added on top, and `total`
  // is the amount due today (subtotal − discount + tax). Tax is only known
  // once the buyer enters a billing address, so the tax row appears reactively.
  const subtotal = checkout.total.subtotal.amount; // pre-tax, pre-discount
  const total = checkout.total.total.amount; // due today, incl. tax
  const hasDiscount = checkout.total.discount.minorUnitsAmount > 0;
  const discount = checkout.total.discount.amount;
  const hasTax = checkout.total.taxExclusive.minorUnitsAmount > 0;
  const tax = checkout.total.taxExclusive.amount;

  // Shared tail for both the card form and the wallet button: Stripe has
  // returned a confirm result, so surface a decline (retryable) or poll for
  // provisioning. Identical for both paths because checkout.confirm() returns
  // the same StripeCheckoutConfirmResult whether the payment came from the
  // PaymentElement or an Express Checkout wallet.
  const handleConfirmResult = async (
    result: Awaited<ReturnType<typeof checkout.confirm>>,
  ) => {
    if (result.type === "error") {
      // A decline is retryable — stay on the payment form rather than tearing
      // down the session.
      submittedRef.current = false;
      setWorking(false);
      trackEvent("checkout_failed", {
        plan,
        stage: "payment",
        reason: result.error.message ?? "payment_failed",
      });
      setPayError(result.error.message ?? "Payment failed. Please try again.");
      return;
    }

    // Payment confirmed. The subscription takes a moment to flip to active, so
    // poll for provisioning. Anything short of "ready" routes to the
    // bank-processing copy — never back to a pay button, which would risk a
    // double charge (the webhook finishes provisioning and emails a link).
    onActivating(email);
    const poll = await pollForCheckoutSession(checkoutSessionId, email);
    if (poll.kind === "ready") {
      await onActivated(email);
    } else if (poll.kind === "already_subscribed") {
      onAlreadySubscribed(email, poll.message);
    } else {
      // Paid, but activation didn't confirm in the poll window (timeout,
      // bank still processing, or a network/server error). reason carries the
      // poll outcome so PostHog can separate "slow bank" from real errors.
      trackEvent("checkout_failed", {
        plan,
        stage: "provisioning",
        reason: poll.kind,
      });
      onProcessing(email);
    }
  };

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    // Nothing is charged until both boxes are ticked. The button stays enabled
    // so the refusal can say why — a disabled button that never explains itself
    // is the version of this a buyer bounces off.
    if (!consent.confirm()) {
      focusConsent();
      return;
    }
    submittedRef.current = true;
    setWorking(true);
    setPayError(null);
    trackEvent("checkout_payment_submitted", { plan });
    await consent.record(checkoutSessionId);

    // redirect: 'if_required' keeps card payments in the modal; methods that
    // need an off-site step (e.g. 3DS) use the session's return_url. Email is
    // already on the Customer attached to the Session, so passing it here is
    // rejected by Stripe with an IntegrationError.
    const result = await checkout.confirm({
      redirect: "if_required",
    });
    await handleConfirmResult(result);
  };

  // Wallet path: the buyer authorized Apple Pay / Google Pay in the native
  // sheet, so hand the event to checkout.confirm(). The wallet supplies the
  // billing address; the Session's automatic_tax already recomputes tax from
  // it, so no BillingAddressElement is involved on this path. redirect stays
  // 'if_required' for parity with the card path (3DS from a wallet is rare but
  // possible). The submittedRef guard blocks a double-confirm if the buyer
  // also had the card form partly filled.
  const confirmWallet = async (
    event: Parameters<
      NonNullable<React.ComponentProps<typeof ExpressCheckoutElement>["onConfirm"]>
    >[0],
  ) => {
    if (submittedRef.current) return;
    // Belt and braces behind the click gate on the buttons themselves: a wallet
    // sheet that has already authorized payment must not reach confirm() on an
    // unaccepted consent.
    if (!consent.confirm()) {
      focusConsent();
      return;
    }
    submittedRef.current = true;
    setWorking(true);
    setPayError(null);
    trackEvent("checkout_payment_submitted", { plan });
    await consent.record(checkoutSessionId);
    const result = await checkout.confirm({
      expressCheckoutConfirmEvent: event,
      redirect: "if_required",
    });
    await handleConfirmResult(result);
  };

  return (
    <>
      <h2 id="checkout-title" className={titleClass}>
        {subtotal}{" "}
        <span className="text-body-sm font-sans font-normal">
          / {intervalLabel}
        </span>
      </h2>

      <form onSubmit={pay} className="mt-6 space-y-4">
        {/* Apple Pay / Google Pay. Always mounted so onReady can report wallet
            availability; the wrapper collapses to nothing when no wallet exists
            (most desktops) so there's no orphan "or pay with card" divider. The
            wallet supplies the billing address, so tax still resolves via the
            Session's automatic_tax — no BillingAddressElement on this path. */}
        <div className={walletState === "none" ? "hidden" : "space-y-4"}>
          {/* The wallet buttons confirm on their own, straight out of the
              native sheet — the Checkout SDK's ExpressCheckoutElement has no
              onClick to intercept — so an unaccepted consent has to stop the
              click before the sheet opens. pointer-events-none on the inner
              wrapper lets the click land on this one instead, which says why. */}
          <div
            onClick={
              consent.complete
                ? undefined
                : () => {
                    consent.confirm();
                    focusConsent();
                  }
            }
          >
            <div
              className={
                consent.complete ? undefined : "pointer-events-none opacity-50"
              }
            >
              <ExpressCheckoutElement
                options={{
                  buttonHeight: 48,
                  // Contrast the button against the modal surface.
                  buttonTheme:
                    theme === "light"
                      ? { applePay: "black", googlePay: "black" }
                      : { applePay: "white", googlePay: "white" },
                  buttonType: undefined,
                  layout: undefined,
                  paymentMethodOrder: undefined,
                  paymentMethods: undefined,
                }}
                onReady={(event) =>
                  setWalletState(
                    event.availablePaymentMethods ? "available" : "none",
                  )
                }
                onConfirm={confirmWallet}
                onLoadError={() => setWalletState("none")}
              />
            </div>
          </div>
          {walletState === "available" && !consent.complete ? (
            <p className="text-body-sm text-fg-muted">
              Tick the boxes at the bottom of this form to pay with a wallet.
            </p>
          ) : null}
          {walletState === "available" ? (
            <div className="flex items-center gap-3 text-xs uppercase tracking-button text-fg-faint">
              <span className="h-px flex-1 bg-rule" />
              Or pay with card
              <span className="h-px flex-1 bg-rule" />
            </div>
          ) : null}
        </div>
        <PaymentElement />
        {/* Billing address powers Stripe Tax: the calculated tax updates the
            totals below as soon as a usable address is entered. `name: "split"`
            collects first and last separately and, with customer_update.name on
            the Session, saves them to customer.name — the only point in the
            funnel where a new subscriber's name is captured. */}
        <BillingAddressElement options={{ display: { name: "split" } }} />
        <PromoCode checkout={checkout} promo={promo} surface="membership" />
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
        {payError ? (
          <p role="alert" className="text-body-sm text-danger">
            {payError}
          </p>
        ) : null}
        <div ref={consentRef}>
          <CheckoutConsent renewal={renewal} consent={consent} />
        </div>
        <button
          type="submit"
          disabled={working}
          aria-busy={working}
          className={ctaClass}
        >
          {working ? "Processing…" : `Pay ${total}`}
        </button>
      </form>
    </>
  );
}
