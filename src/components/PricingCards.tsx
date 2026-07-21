import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckoutModal } from "./CheckoutModal";
import { ContentError } from "./ContentError";
import { useAsyncResource } from "../lib/useAsyncResource";
import { trackEvent } from "../lib/analytics";
import { TIERS, type Tier, type TierMeta } from "../data/pricingTiers";

function fmtPrice(dollars: number): string {
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// Pay-what-you-choose ceiling for the slider, as a multiple of the plan's base
// price. The typed field still accepts more (the server caps at $10,000) — this
// only bounds the drag range.
const SLIDER_MAX_MULTIPLE = 4;

type TierPricing = { monthly_cents: number; yearly_cents: number };
type Plan = "monthly" | "yearly";

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="mt-0.5 size-4 shrink-0 text-cyan"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  );
}

function PriceCard({
  meta,
  plan,
  pricing,
  onSubscribe,
}: {
  meta: TierMeta;
  plan: Plan;
  pricing: TierPricing | null;
  onSubscribe: (tier: Tier, customAmount: number | null) => void;
}) {
  const [customAmount, setCustomAmount] = useState<string>("");
  const [pwycOpen, setPwycOpen] = useState(false);
  const featured = Boolean(meta.featured);

  const price = pricing
    ? (plan === "yearly" ? pricing.yearly_cents : pricing.monthly_cents) / 100
    : null;
  const parsedCustom = customAmount.trim() === "" ? null : Number(customAmount);
  const customValid =
    parsedCustom !== null &&
    Number.isFinite(parsedCustom) &&
    price !== null &&
    parsedCustom >= price;
  // What the member would actually be charged: their chosen amount if valid,
  // otherwise the plan's base price.
  const amount = customValid ? (parsedCustom as number) : price;
  const savingsPct = pricing
    ? Math.round((1 - pricing.yearly_cents / (pricing.monthly_cents * 12)) * 100)
    : null;

  // The slider moves in whole dollars; the leftmost stop maps back to the exact
  // base so the standard price is always reachable, and typing stays exact.
  const sliderMin = price !== null ? Math.ceil(price) : 0;
  const sliderMax = price !== null ? Math.round(price * SLIDER_MAX_MULTIPLE) : 0;
  const sliderValue =
    amount !== null
      ? Math.min(Math.max(Math.round(amount), sliderMin), sliderMax)
      : sliderMin;

  const belowMin =
    parsedCustom !== null &&
    Number.isFinite(parsedCustom) &&
    price !== null &&
    parsedCustom < price;

  return (
    <div
      className={`relative flex flex-col p-7 sm:p-8 ${
        featured
          ? "border-2 border-cyan bg-navy-800/60 lg:-my-3 lg:pt-11"
          : "border border-rule bg-navy-800/40"
      }`}
    >
      {featured ? (
        <span className="absolute -top-px left-1/2 -translate-x-1/2 -translate-y-1/2 bg-cyan px-3 py-1 button-text font-display font-bold text-navy">
          Best value
        </span>
      ) : null}

      <div className="text-h4 font-display font-bold text-fg-strong">
        {meta.label}
      </div>

      <div className="mt-5 border-t border-rule pt-5">
        <div className="flex items-baseline gap-2 text-fg-strong">
          <span className="display-upright text-[clamp(2.4rem,5vw,3rem)] leading-none">
            {amount !== null ? (
              `$${fmtPrice(amount)}`
            ) : (
              <span className="inline-block h-[0.7em] w-20 animate-pulse rounded bg-rule-strong/40 align-middle" />
            )}
          </span>
          <span className="text-body-sm">
            / {plan === "yearly" ? "year" : "month"}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-body-sm">
          <span>{plan === "yearly" ? "Billed annually" : "Billed monthly"}</span>
          {plan === "yearly" && savingsPct && savingsPct > 0 ? (
            <span className="text-cyan">· Save {savingsPct}%</span>
          ) : null}
        </div>
      </div>

      <p className="mt-5 text-body-sm text-fg">{meta.blurb}</p>

      <ul className="mt-6 space-y-3 text-body-sm text-fg">
        {meta.includes.map((f) => (
          <li key={f} className="flex items-start gap-3">
            <CheckIcon />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {/* Pay-what-you-choose — collapsed by default to keep the card clean;
          drag for the shape, type for the exact figure. */}
      <div className="mt-6 border-t border-rule pt-5">
        <button
          type="button"
          aria-expanded={pwycOpen}
          onClick={() => setPwycOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 button-text font-display font-bold text-fg-muted transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <span>Pay what you choose</span>
          <span
            className={`text-cyan transition-transform duration-300 ${pwycOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>

        {pwycOpen ? (
          <div className="mt-4">
            <div className="flex items-center gap-3">
              <input
                type="range"
                aria-label={`${meta.label} amount per ${plan === "yearly" ? "year" : "month"}`}
                min={sliderMin}
                max={sliderMax}
                step={1}
                value={sliderValue}
                disabled={price === null}
                onChange={(e) => {
                  // The leftmost stop is the base price itself; clearing to ""
                  // hands checkout the base and its fixed price ID. Every other
                  // stop is its own whole-dollar custom amount.
                  const v = Number(e.target.value);
                  setCustomAmount(v <= sliderMin ? "" : String(v));
                }}
                onBlur={() => {
                  if (amount === null) return;
                  trackEvent("custom_amount_entered", {
                    plan,
                    amount,
                    valid: customValid,
                  });
                }}
                className="h-9 min-w-0 flex-1 cursor-pointer bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
                style={{ accentColor: "var(--color-cyan)" }}
              />
              <div className="flex w-28 shrink-0 items-center border-b border-rule-strong pb-1.5 focus-within:border-cyan">
                <span className="mr-1 text-lg text-fg-muted">$</span>
                <input
                  type="number"
                  aria-label={`${meta.label} custom amount`}
                  min={price ?? undefined}
                  step="any"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  onBlur={() => {
                    if (parsedCustom === null || !Number.isFinite(parsedCustom))
                      return;
                    trackEvent("custom_amount_entered", {
                      plan,
                      amount: parsedCustom,
                      valid: customValid,
                    });
                  }}
                  placeholder={price !== null ? fmtPrice(price) : ""}
                  className="min-w-0 flex-1 bg-transparent text-lg text-fg-strong outline-none placeholder:text-fg-placeholder"
                />
                <span className="ml-1 shrink-0 whitespace-nowrap text-body-sm">
                  /{plan === "yearly" ? "yr" : "mo"}
                </span>
              </div>
            </div>
            {belowMin ? (
              <p className="mt-2 text-body-sm text-danger" role="alert">
                Minimum is ${price !== null ? fmtPrice(price) : ""}/
                {plan === "yearly" ? "yr" : "mo"}.
              </p>
            ) : (
              <p className="mt-2 text-body-sm">
                {price !== null
                  ? `$${fmtPrice(price)} minimum — give more to sustain independent Jewish media.`
                  : ""}
              </p>
            )}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => {
          trackEvent("checkout_opened", {
            plan,
            tier: meta.key,
            amount,
            is_custom_amount: customValid,
          });
          onSubscribe(meta.key, customValid ? (parsedCustom as number) : null);
        }}
        disabled={price === null}
        className={`group mt-7 inline-flex min-h-12 w-full items-center justify-between px-5 button-text font-display font-bold tracking-cta transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50 ${
          featured
            ? "bg-cyan text-navy hover:bg-fg-strong hover:text-navy-900 disabled:hover:bg-cyan disabled:hover:text-navy"
            : "border border-cyan text-cyan hover:bg-cyan hover:text-navy"
        }`}
      >
        {plan === "yearly" ? "Subscribe annually" : "Subscribe monthly"}
        <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
          →
        </span>
      </button>
    </div>
  );
}

// The 3-card pricing grid: a shared Monthly/Annual toggle, one card per SKU
// (the Bundle featured in the center), and the checkout modal. Prices come from
// Stripe (the source of truth) via /api/pricing — never hardcoded, so the
// displayed amount can't drift from what we charge.
export function PricingCards({
  id = "plans",
  showCompareLink = false,
}: {
  id?: string;
  showCompareLink?: boolean;
}) {
  const [plan, setPlanRaw] = useState<Plan>("yearly");
  const [checkout, setCheckout] = useState<{
    tier: Tier;
    customAmount: number | null;
  } | null>(null);

  const setPlan = (p: Plan) => {
    setPlanRaw(p);
    trackEvent("plan_selected", { plan: p });
  };

  const pricing = useAsyncResource(async () => {
    const res = await fetch("/api/pricing");
    if (!res.ok) throw new Error("pricing request failed");
    const data = (await res.json().catch(() => ({}))) as {
      tiers?: Record<string, TierPricing>;
    };
    const tiers = data.tiers;
    if (
      !tiers ||
      !TIERS.every(
        (t) =>
          typeof tiers[t.key]?.monthly_cents === "number" &&
          typeof tiers[t.key]?.yearly_cents === "number",
      )
    ) {
      throw new Error("pricing response malformed");
    }
    return tiers;
  }, []);
  const tiers = pricing.status === "ready" ? pricing.data : null;

  // Representative savings for the toggle badge — the Bundle's annual discount.
  const toggleSavings = tiers
    ? Math.round(
        (1 - tiers.bundle.yearly_cents / (tiers.bundle.monthly_cents * 12)) *
          100,
      )
    : null;

  if (pricing.status === "error") {
    return (
      <div id={id} className="page-gutter py-12">
        <ContentError
          message="We couldn't load pricing right now. Refresh to try again."
          onRetry={pricing.retry}
        />
      </div>
    );
  }

  return (
    <div id={id}>
      <div className="flex justify-center">
        <div
          role="group"
          aria-label="Billing period"
          className="inline-flex border border-rule-strong p-1"
        >
          {(["monthly", "yearly"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={plan === p}
              onClick={() => setPlan(p)}
              className={`relative inline-flex min-h-11 items-center justify-center px-6 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                plan === p
                  ? "bg-cyan text-navy"
                  : "text-fg-muted hover:text-fg-strong"
              }`}
            >
              {p === "yearly" ? "Annual" : "Monthly"}
              {p === "yearly" && toggleSavings && toggleSavings > 0 ? (
                <span
                  className={`ml-2 text-xs ${plan === p ? "opacity-80" : "text-cyan"}`}
                >
                  −{toggleSavings}%
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start lg:gap-5">
        {TIERS.map((meta) => (
          <PriceCard
            key={meta.key}
            meta={meta}
            plan={plan}
            pricing={tiers ? tiers[meta.key] : null}
            onSubscribe={(tier, customAmount) =>
              setCheckout({ tier, customAmount })
            }
          />
        ))}
      </div>

      {showCompareLink ? (
        <div className="mt-10 text-center">
          <Link
            to="/pricing"
            className="group inline-flex items-center gap-2 button-text font-display font-bold text-cyan transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Compare all plans
            <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
              →
            </span>
          </Link>
        </div>
      ) : null}

      <CheckoutModal
        open={checkout !== null}
        plan={plan}
        tier={checkout?.tier ?? "bundle"}
        customAmount={checkout?.customAmount ?? null}
        onClose={() => setCheckout(null)}
      />
    </div>
  );
}
