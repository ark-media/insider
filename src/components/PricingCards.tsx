import { useState } from "react";
import { BillingPeriodToggle } from "./BillingPeriodToggle";
import { CheckoutModal } from "./CheckoutModal";
import { ContentError } from "./ContentError";
import { PriceSkeleton } from "./PriceSkeleton";
import { trackEvent } from "../lib/analytics";
import { TIERS, type Tier, type TierMeta } from "../data/pricingTiers";
import { type TierAmounts, formatMinor, toMajor } from "../lib/currency";
import { usePricing, annualSavingsPct } from "../lib/usePricing";

type Plan = "monthly" | "yearly";

// Stacked on a phone there's no "center" to feature, so the Bundle leads and the
// two single-axis tiers follow. From `lg` the grid takes over and the DOM order
// (Ark+ · Bundle · the Fold) puts the featured card back in the middle. Static
// class strings so Tailwind can see them.
const MOBILE_ORDER: Record<Tier, string> = {
  bundle: "max-lg:order-1",
  "ark-plus": "max-lg:order-2",
  circle: "max-lg:order-3",
};

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
  currency,
  factor,
  onSubscribe,
}: {
  meta: TierMeta;
  plan: Plan;
  pricing: TierAmounts | null;
  currency: string;
  factor: number;
  onSubscribe: (tier: Tier) => void;
}) {
  const featured = Boolean(meta.featured);

  // The floor price in the buyer's currency (minor units). It's a floor, not a
  // fixed price: members choose their amount (this or more) at checkout, so the
  // card leads with "From <price>".
  const priceMinor = pricing
    ? ((plan === "yearly" ? pricing.yearly : pricing.monthly)[currency] ?? null)
    : null;
  const savingsPct = pricing ? annualSavingsPct(pricing) : null;

  return (
    <div
      className={`relative flex flex-col p-7 sm:p-8 ${MOBILE_ORDER[meta.key]} ${
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
          <span className="text-body-sm">From</span>
          <span className="display-upright text-[clamp(2.4rem,5vw,3rem)] leading-none">
            {priceMinor !== null ? (
              formatMinor(priceMinor, currency, factor)
            ) : (
              <PriceSkeleton className="h-[0.7em] w-20" />
            )}
          </span>
          <span className="text-body-sm">
            / {plan === "yearly" ? "year" : "month"}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-body-sm">
          <span>
            {plan === "yearly" ? "Billed annually" : "Billed monthly"}
          </span>
          {plan === "yearly" && savingsPct !== null ? (
            <span className="text-cyan">· Save {savingsPct}%</span>
          ) : null}
        </div>
        <p className="mt-2 text-body-sm text-fg-muted">
          Give more to sustain independent Jewish media.
        </p>
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

      <button
        type="button"
        onClick={() => {
          trackEvent("checkout_opened", {
            plan,
            tier: meta.key,
            amount: priceMinor !== null ? toMajor(priceMinor, factor) : null,
            is_custom_amount: false,
          });
          onSubscribe(meta.key);
        }}
        disabled={priceMinor === null}
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
// (the Bundle featured in the center), and the checkout modal. Always the full
// catalog — /plus is a public membership page, not an upsell that hides SKUs
// the viewer already owns. Prices come from Stripe (the source of truth) via
// /api/pricing — never hardcoded, so the displayed amount can't drift from
// what we charge.
export function PricingCards({ id = "plans" }: { id?: string }) {
  const [plan, setPlanRaw] = useState<Plan>("yearly");
  const [checkout, setCheckout] = useState<{ tier: Tier } | null>(null);

  const setPlan = (p: Plan) => {
    setPlanRaw(p);
    trackEvent("plan_selected", { plan: p });
  };

  // Shared with the comparison table below the grid — one request, one currency.
  // (No selector here; the checkout modal owns currency choice.)
  const pricing = usePricing();
  const data = pricing.status === "ready" ? pricing.data : null;
  const tiers = data?.tiers ?? null;
  const currency = data?.currency ?? "usd";
  const factor = data?.factor ?? 100;

  // Representative savings for the toggle badge — the Bundle's annual discount.
  const toggleSavings = tiers ? annualSavingsPct(tiers.bundle) : null;

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
        <BillingPeriodToggle
          plan={plan}
          onChange={setPlan}
          savingsPct={toggleSavings}
        />
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start lg:gap-5">
        {TIERS.map((meta) => (
          <PriceCard
            key={meta.key}
            meta={meta}
            plan={plan}
            pricing={tiers ? tiers[meta.key] : null}
            currency={currency}
            factor={factor}
            onSubscribe={(tier) => setCheckout({ tier })}
          />
        ))}
      </div>

      <CheckoutModal
        open={checkout !== null}
        plan={plan}
        tier={checkout?.tier ?? "bundle"}
        onClose={() => setCheckout(null)}
      />
    </div>
  );
}
