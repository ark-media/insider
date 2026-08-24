import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BillingPeriodToggle } from "./BillingPeriodToggle";
import { CheckoutModal } from "./CheckoutModal";
import { ContentError } from "./ContentError";
import { PriceSkeleton } from "./PriceSkeleton";
import { trackEvent } from "../lib/analytics";
import { TIERS, type Tier, type TierMeta } from "../data/pricingTiers";
import { type TierAmounts, formatMinor, toMajor } from "../lib/currency";
import { usePricing, annualSavingsPct } from "../lib/usePricing";
import { useSubscriberAuth } from "../lib/subscriberAuth";

type Plan = "monthly" | "yearly";

// What each tier grants, in entitlement-axis terms. Used to personalize the grid
// for signed-in members: a tier is shown only if every axis it grants is still
// un-owned — so an Ark+ member sees just Community, a Circle member sees just
// Ark+, and a full-bundle member sees none. This never offers a tier that
// bundles an axis they already pay for (which would double-charge them).
const TIER_GRANTS: Record<Tier, ("arkPlus" | "circle")[]> = {
  "ark-plus": ["arkPlus"],
  circle: ["circle"],
  bundle: ["arkPlus", "circle"],
};

// Stacked on a phone there's no "center" to feature, so the Bundle leads and the
// two single-axis tiers follow. From `lg` the grid takes over and the DOM order
// (Ark+ · Bundle · Community) puts the featured card back in the middle. Static
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
// (the Bundle featured in the center), and the checkout modal. Prices come from
// Stripe (the source of truth) via /api/pricing — never hardcoded, so the
// displayed amount can't drift from what we charge.
export function PricingCards({ id = "plans" }: { id?: string }) {
  const [plan, setPlanRaw] = useState<Plan>("yearly");
  const [checkout, setCheckout] = useState<{ tier: Tier } | null>(null);
  const { state } = useSubscriberAuth();

  // Which axes the signed-in member already owns (guests own neither). The grid
  // then shows only tiers that grant something they're still missing.
  const owned = {
    arkPlus: state.kind === "member" && state.me.entitlements.arkPlus,
    circle: state.kind === "member" && state.me.entitlements.circle,
  };
  const visibleTiers = TIERS.filter((meta) =>
    TIER_GRANTS[meta.key].every((axis) => !owned[axis]),
  );
  // One card centers, two cards sit in a narrower two-up; three keeps the full
  // grid. (Static class strings so Tailwind can see them.)
  const gridColsClass =
    visibleTiers.length === 1
      ? "lg:mx-auto lg:max-w-md lg:grid-cols-1"
      : visibleTiers.length === 2
        ? "lg:mx-auto lg:max-w-3xl lg:grid-cols-2"
        : "lg:grid-cols-3";

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

  // Owns both axes already — nothing left to sell. Reachable only by deep link
  // (the nav hides "Subscribe" for full members), so keep it simple.
  if (visibleTiers.length === 0) {
    return (
      <div id={id} className="mx-auto max-w-xl px-6 py-10 text-center">
        <p className="text-body text-fg-strong">
          You already have full access — Ark+ and the Community.
        </p>
        <Link
          to="/account"
          className="group mt-6 inline-flex items-center gap-2 button-text font-display font-bold text-cyan transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Manage your membership
          <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
            →
          </span>
        </Link>
      </div>
    );
  }

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

      <div
        className={`mt-10 grid grid-cols-1 gap-6 lg:items-start lg:gap-5 ${gridColsClass}`}
      >
        {visibleTiers.map((meta) => (
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
