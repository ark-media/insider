import { useEffect, useRef, useState } from "react";
import { CheckoutModal } from "./CheckoutModal";
import { ContentError } from "./ContentError";
import { useAsyncResource } from "../lib/useAsyncResource";
import { trackEvent } from "../lib/analytics";

function fmtPrice(dollars: number): string {
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// Pay-what-you-choose ceiling for the slider, as a multiple of the plan's base
// price. The typed field still accepts more (the server caps at $10,000) — this
// only bounds the drag range.
const SLIDER_MAX_MULTIPLE = 4;

type Tier = "ark-plus" | "circle" | "bundle";

// The three SKUs, each on its own entitlement footing (§4). Community is NOT
// part of Ark+ (decision #2) — it's its own tier, and the Bundle is what buys
// both. `includes` is the exact, truthful grant per tier.
const TIERS: {
  key: Tier;
  label: string;
  blurb: string;
  includes: string[];
}[] = [
  {
    key: "ark-plus",
    label: "Ark+",
    blurb:
      "Every Ark Media podcast, ad-free, plus the members-only newsletters.",
    includes: [
      "Inside Call Me Back — private, ad-free feed",
      "The full network, ad-free",
      "Members-only newsletters",
    ],
  },
  {
    key: "circle",
    label: "Community",
    blurb:
      "The Ark Media community app — conversations, member events, and Dan's book club.",
    includes: [
      "The Ark Media community in Circle",
      "Live member events & Q&As",
      "Dan's book club",
    ],
  },
  {
    key: "bundle",
    label: "Ark+ & Community",
    blurb: "Both — the private feed and the community, one membership.",
    includes: [
      "Inside Call Me Back — private, ad-free feed",
      "The full network, ad-free",
      "Members-only newsletters",
      "The Ark Media community in Circle",
      "Live member events & Q&As",
    ],
  },
];

type TierPricing = { monthly_cents: number; yearly_cents: number };

export function Pricing() {
  const [tier, setTierRaw] = useState<Tier>("bundle");
  const [plan, setPlanRaw] = useState<"monthly" | "yearly">("yearly");
  const [customAmount, setCustomAmount] = useState<string>("");
  const setPlan = (p: "monthly" | "yearly") => {
    setPlanRaw(p);
    setCustomAmount("");
    trackEvent("plan_selected", { plan: p });
  };
  const setTier = (t: Tier) => {
    setTierRaw(t);
    setCustomAmount("");
  };
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  // Top of the revenue funnel: fire once when the pricing section scrolls into
  // view, not on mount.
  const sectionRef = useRef<HTMLElement>(null);
  const viewedRef = useRef(false);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || viewedRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !viewedRef.current) {
          viewedRef.current = true;
          trackEvent("pricing_viewed");
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Prices come from Stripe (the source of truth) via /api/pricing — never
  // hardcoded, so the displayed amount can't drift from what we charge. A failed
  // or malformed response rejects, so the UI shows error+retry.
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
  const selected = TIERS.find((t) => t.key === tier)!;

  const price = tiers
    ? (plan === "yearly"
        ? tiers[tier].yearly_cents
        : tiers[tier].monthly_cents) / 100
    : null;
  const parsedCustom = customAmount.trim() === "" ? null : Number(customAmount);
  const customValid =
    parsedCustom !== null &&
    Number.isFinite(parsedCustom) &&
    price !== null &&
    parsedCustom >= price;
  const savingsPct = tiers
    ? Math.round(
        (1 -
          tiers[tier].yearly_cents / (tiers[tier].monthly_cents * 12)) *
          100,
      )
    : null;

  // What the member would actually be charged: their chosen amount if valid,
  // otherwise the plan's base price.
  const amount = customValid ? (parsedCustom as number) : price;

  // The slider moves in whole dollars; the leftmost stop maps back to the exact
  // base so the standard price is always reachable, and typing stays exact.
  const sliderMin = price !== null ? Math.ceil(price) : 0;
  const sliderMax = price !== null ? Math.round(price * SLIDER_MAX_MULTIPLE) : 0;
  const sliderValue =
    amount !== null
      ? Math.min(Math.max(Math.round(amount), sliderMin), sliderMax)
      : sliderMin;

  return (
    <section id="pricing" ref={sectionRef} className="relative">
      <div className="page-gutter pt-12 pb-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Pick your
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                own <span className="display text-cyan">terms.</span>
              </span>
            </h2>
            <p className="mt-6 max-w-md text-body-sm text-fg">
              Three ways in: the private feed, the community, or both. Every plan
              is pay-what-you-choose — name the suggested amount or give more to
              help sustain independent Jewish media.
            </p>
            <ul className="mt-10 space-y-2 text-body-sm">
              {[
                "Cancel anytime",
                "Gift Ark+ available",
                "Secure checkout via Stripe",
                "Pay in your local currency",
              ].map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <span className="inline-block size-1.5 rounded-full bg-cyan" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-7">
            {pricing.status === "error" ? (
              <ContentError
                message="We couldn't load pricing right now. Refresh to try again."
                onRetry={pricing.retry}
              />
            ) : (
              <>
                {/* Tier selector — the three SKUs. */}
                <div
                  role="group"
                  aria-label="Membership"
                  className="mb-3 grid grid-cols-3 gap-1 border border-rule-strong p-1"
                >
                  {TIERS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={tier === t.key}
                      onClick={() => setTier(t.key)}
                      className={`inline-flex min-h-11 items-center justify-center px-2 text-center button-text font-display font-bold leading-tight transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                        tier === t.key
                          ? "bg-cyan text-navy"
                          : "text-fg-muted hover:text-fg-strong"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Plan toggle — monthly / annual. */}
                <div
                  role="group"
                  aria-label="Billing period"
                  className="flex w-full border border-rule-strong p-1 sm:inline-flex sm:w-auto"
                >
                  {(["monthly", "yearly"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={plan === p}
                      onClick={() => setPlan(p)}
                      className={`relative inline-flex min-h-11 flex-1 items-center justify-center px-3 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:flex-none sm:px-6 ${
                        plan === p
                          ? "bg-cyan text-navy"
                          : "text-fg-muted hover:text-fg-strong"
                      }`}
                    >
                      {p === "yearly" ? "annual" : "monthly"}
                      {p === "yearly" && savingsPct ? (
                        <span
                          className={`ml-2 text-xs ${plan === p ? "opacity-80" : "text-cyan"}`}
                        >
                          −{savingsPct}%
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>

                {/* Plan block */}
                <div className="mt-6 border border-rule bg-navy-800/50">
                  <div className="grid grid-cols-1 sm:grid-cols-[1.1fr_1fr]">
                    {/* Price column */}
                    <div className="relative border-b border-rule p-8 sm:border-b-0 sm:border-r">
                      <div className="eyebrow">
                        {selected.label} ·{" "}
                        {plan === "yearly" ? "billed annually" : "billed monthly"}
                      </div>
                      <div className="mt-6 flex items-baseline gap-2 text-fg-strong">
                        <span className="display-upright text-[clamp(3.5rem,7vw,5rem)] leading-none">
                          {amount !== null ? (
                            `$${fmtPrice(amount)}`
                          ) : (
                            <span className="inline-block h-[0.7em] w-28 animate-pulse rounded bg-rule-strong/40 align-middle" />
                          )}
                        </span>
                        <span className="text-body-sm">
                          / {plan === "yearly" ? "year" : "month"}
                        </span>
                      </div>
                      <div className="mt-3 text-body-sm">
                        {price !== null
                          ? `$${fmtPrice(price)}/${plan === "yearly" ? "year" : "month"} minimum — pay what you choose.`
                          : ""}
                      </div>

                      <p className="mt-5 max-w-[42ch] text-body-sm text-fg">
                        {selected.blurb}
                      </p>

                      {/* Custom amount — drag for the shape, type for the exact
                          figure. */}
                      <div className="mt-10">
                        <label
                          htmlFor="custom-amount"
                          className="eyebrow text-fg-muted"
                        >
                          Adjust amount
                        </label>
                        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
                          <div className="relative min-w-0 flex-1">
                            <input
                              type="range"
                              aria-label={`Amount per ${plan === "yearly" ? "year" : "month"}`}
                              min={sliderMin}
                              max={sliderMax}
                              step={1}
                              value={sliderValue}
                              disabled={price === null}
                              onChange={(e) => {
                                // The leftmost stop is the base price itself;
                                // clearing to "" hands checkout the base and its
                                // fixed price ID. Every other stop is its own
                                // whole-dollar custom amount.
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
                              className="h-11 w-full cursor-pointer bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
                              style={{ accentColor: "var(--color-cyan)" }}
                            />
                          </div>

                          <div className="flex w-full shrink-0 items-center border-b border-rule-strong pb-2 focus-within:border-cyan sm:w-32">
                            <span className="mr-1 text-[22px] text-fg-muted">
                              $
                            </span>
                            <input
                              id="custom-amount"
                              type="number"
                              min={price ?? undefined}
                              step="any"
                              value={customAmount}
                              onChange={(e) => setCustomAmount(e.target.value)}
                              onBlur={() => {
                                if (
                                  parsedCustom === null ||
                                  !Number.isFinite(parsedCustom)
                                )
                                  return;
                                trackEvent("custom_amount_entered", {
                                  plan,
                                  amount: parsedCustom,
                                  valid: customValid,
                                });
                              }}
                              placeholder={price !== null ? fmtPrice(price) : ""}
                              className="min-h-11 w-full bg-transparent text-[22px] text-fg-strong outline-none placeholder:text-fg-placeholder"
                            />
                            <span className="ml-1 shrink-0 whitespace-nowrap text-body-sm">
                              /{plan === "yearly" ? "yr" : "mo"}
                            </span>
                          </div>
                        </div>

                        {parsedCustom !== null &&
                        Number.isFinite(parsedCustom) &&
                        price !== null &&
                        parsedCustom < price ? (
                          <p
                            className="mt-2 text-body-sm text-danger"
                            role="alert"
                          >
                            Minimum is ${fmtPrice(price)}/
                            {plan === "yearly" ? "yr" : "mo"}.
                          </p>
                        ) : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          trackEvent("checkout_opened", {
                            plan,
                            tier,
                            amount,
                            is_custom_amount: customValid,
                          });
                          setCheckoutOpen(true);
                        }}
                        disabled={price === null}
                        className="group mt-8 inline-flex min-h-12 w-full items-center justify-between bg-cyan px-5 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-cyan disabled:hover:text-navy"
                      >
                        {plan === "yearly" ? "Subscribe annually" : "Subscribe monthly"}
                        <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                          →
                        </span>
                      </button>
                    </div>

                    {/* Includes column — the exact grant for the selected tier. */}
                    <div className="p-8">
                      <div className="eyebrow text-fg-muted">
                        {selected.label} includes
                      </div>
                      <ul className="mt-5 space-y-3 text-body-sm text-fg">
                        {selected.includes.map((f) => (
                          <li key={f} className="flex items-start gap-3">
                            <span className="mt-[7px] h-px w-4 bg-cyan" />
                            {f}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <CheckoutModal
        open={checkoutOpen}
        plan={plan}
        tier={tier}
        customAmount={customValid ? (parsedCustom as number) : null}
        onClose={() => setCheckoutOpen(false)}
      />
    </section>
  );
}
