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
// only bounds the drag range so the meaningful part of it, the stretch from base
// to Founding, isn't squeezed into the first few pixels.
const SLIDER_MAX_MULTIPLE = 4;

export function Pricing() {
  const [plan, setPlanRaw] = useState<"monthly" | "yearly">("yearly");
  const [customAmount, setCustomAmount] = useState<string>("");
  const setPlan = (p: "monthly" | "yearly") => {
    setPlanRaw(p);
    setCustomAmount("");
    trackEvent("plan_selected", { plan: p });
  };
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  // Top of the revenue funnel: fire once when the pricing section actually
  // scrolls into view, not on mount — otherwise every homepage load counts as
  // a pricing view and the funnel's first step is meaningless.
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
  // hardcoded, so the displayed amount can't drift from what we actually
  // charge. (USD source amount; buyers pay the localized equivalent.) A failed
  // or malformed response rejects, so the UI shows an error+retry instead of
  // spinning on the skeleton forever.
  const pricing = useAsyncResource(async () => {
    const res = await fetch("/api/pricing");
    if (!res.ok) throw new Error("pricing request failed");
    const data = (await res.json().catch(() => ({}))) as {
      monthly_cents?: number;
      yearly_cents?: number;
      founding_multiple?: number;
    };
    if (
      typeof data.monthly_cents !== "number" ||
      typeof data.yearly_cents !== "number" ||
      typeof data.founding_multiple !== "number"
    ) {
      throw new Error("pricing response malformed");
    }
    return {
      monthly: data.monthly_cents / 100,
      yearly: data.yearly_cents / 100,
      // The Founding threshold is the server's to define — it's what checkout
      // actually enforces. Shipping it with the prices keeps the promise on
      // this page and the rule in the webhook from drifting apart.
      foundingMultiple: data.founding_multiple,
    };
  }, []);
  const prices = pricing.status === "ready" ? pricing.data : null;

  const price = prices ? (plan === "yearly" ? prices.yearly : prices.monthly) : null;
  const parsedCustom = customAmount.trim() === "" ? null : Number(customAmount);
  const customValid =
    parsedCustom !== null &&
    Number.isFinite(parsedCustom) &&
    price !== null &&
    parsedCustom >= price;
  const savingsPct = prices
    ? Math.round((1 - prices.yearly / (prices.monthly * 12)) * 100)
    : null;

  // What the member would actually be charged: their chosen amount if it's a
  // valid one, otherwise the plan's base price.
  const amount = customValid ? (parsedCustom as number) : price;
  const foundingAt = prices && price !== null ? price * prices.foundingMultiple : null;
  // Decided in integer cents, exactly as the server does (stripe.ts:
  // `amountCents >= defaultCents * FOUNDING_MULTIPLE`), so the badge this page
  // promises and the one checkout stamps agree bit-for-bit — no float slack at
  // the boundary, whatever the multiple.
  const isFounding =
    amount !== null && prices !== null && price !== null
      ? Math.round(amount * 100) >= Math.round(price * 100) * prices.foundingMultiple
      : false;

  // The slider moves in whole dollars — a base price like $59.99 would otherwise
  // drag through $60.99, $61.99, and every stop after it would carry the cents.
  // The floor is the first whole dollar at or above the base; the range's
  // onChange maps that leftmost stop back to the exact base (see below), so the
  // standard price is always reachable. Typing stays exact and can exceed the
  // slider's ceiling.
  const sliderMin = price !== null ? Math.ceil(price) : 0;
  const sliderMax = price !== null ? Math.round(price * SLIDER_MAX_MULTIPLE) : 0;
  const sliderValue =
    amount !== null ? Math.min(Math.max(Math.round(amount), sliderMin), sliderMax) : sliderMin;
  // Where the Founding threshold sits along the track, as a percentage.
  const foundingPct =
    foundingAt !== null && sliderMax > sliderMin
      ? ((foundingAt - sliderMin) / (sliderMax - sliderMin)) * 100
      : 0;

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
              {prices
                ? `$${fmtPrice(prices.monthly)} a month or $${fmtPrice(prices.yearly)} a year`
                : "Monthly or annual"}{" "}
              — or name a higher amount to support the work. Every Ark+ member
              gets the same feed, the same newsletters, the same community. Give
              more and you're helping sustain independent Jewish media.
            </p>
            <ul className="mt-10 space-y-2 text-body-sm">
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Cancel anytime
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Gift Ark+ available
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Secure checkout via Stripe
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Pay in your local currency
              </li>
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
            {/* Plan toggle — fluid on phones (each button takes half the row) and
                intrinsic from `sm` up. An `inline-flex` here sized to its content,
                which at 320px is wider than the gutter and forced the whole page
                to overflow horizontally. */}
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
                    {plan === "yearly" ? "Annual · billed once" : "Monthly · billed monthly"}
                  </div>
                  {/* Said up front, not in the small print: the community isn't a
                      second purchase. It's the question every membership page of
                      this shape gets asked. */}
                  <div className="mt-4 inline-flex items-center border border-rule-strong px-3 py-1.5 text-xs text-fg-muted">
                    Includes Circle community access at no extra cost
                  </div>
                  {/* The headline is the amount they'll actually be charged, not
                      the list price — once someone names a higher figure, showing
                      them the base would be quoting a number we aren't going to
                      bill. The base is still on the record: it's stated to the
                      left, and as the minimum on the field below. */}
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
                    {plan === "yearly"
                      ? price !== null
                        ? `$${fmtPrice(price)}/year minimum — pay what you choose.`
                        : ""
                      : "Billed monthly. Cancel anytime."}
                  </div>

                  <p className="mt-5 max-w-[42ch] text-body-sm text-fg">
                    {plan === "yearly"
                      ? "Full access to every Ark Media podcast, ad-free. Give more to help sustain independent Jewish media."
                      : "The best way to listen to every Ark Media podcast. Full access across the network, ad-free, with subscriber-exclusive episodes."}
                  </p>

                  {/* Custom amount — drag for the shape of it, type for the
                      exact figure. The slider carries the persuasion (you can
                      see Founding sitting a third of the way along); the box
                      keeps the control precise and keyboard-reachable. */}
                  <div className="mt-10">
                    <label htmlFor="custom-amount" className="eyebrow text-fg-muted">
                      Adjust amount
                    </label>

                    {/* Stacked on phones: side by side, the range input's ~129px
                        intrinsic width plus the amount box overflows the card's
                        padded interior at 320px (flex-1 alone won't shrink past
                        content — hence min-w-0 once they do sit in a row). */}
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
                            // The leftmost stop is the base price itself, not the
                            // whole dollar above it. `sliderMin` is `ceil(base)`,
                            // so a $59.99 plan has no whole-dollar stop at base —
                            // without this, dragging to the far left would select
                            // "$60", charge a penny over, and (since it no longer
                            // equals the fixed price) mint a one-off dynamic
                            // Stripe price. Clearing to "" hands checkout the base
                            // and its configured price ID. Every other stop is its
                            // own whole-dollar custom amount.
                            const v = Number(e.target.value);
                            setCustomAmount(v <= sliderMin ? "" : String(v));
                          }}
                          // Track on blur, not pointer-up: pointer-up misses
                          // keyboard users adjusting with arrow keys entirely, and
                          // blur fires once with the committed value for both
                          // input methods (before the checkout button's click, so
                          // the figure is still captured if they proceed).
                          onBlur={() => {
                            if (amount === null) return;
                            trackEvent("custom_amount_entered", {
                              plan,
                              amount,
                              valid: customValid,
                            });
                          }}
                          className="h-11 w-full cursor-pointer bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
                          // The thumb and fill turn gold the moment the amount
                          // crosses into Founding — the control itself confirms
                          // the unlock, before you read a word about it.
                          style={{
                            accentColor: isFounding
                              ? "var(--color-founding)"
                              : "var(--color-cyan)",
                          }}
                        />
                        {/* Founding tick. Decorative — the threshold is stated
                            in words below, so it carries no meaning of its own. */}
                        {price !== null ? (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-founding/60"
                            style={{ left: `${foundingPct}%` }}
                          />
                        ) : null}
                      </div>

                      <div className="flex w-full shrink-0 items-center border-b border-rule-strong pb-2 focus-within:border-cyan sm:w-32">
                        <span className="mr-1 text-[22px] text-fg-muted">$</span>
                        <input
                          id="custom-amount"
                          type="number"
                          min={price ?? undefined}
                          // Without this the input inherits step=1, and a base
                          // price with cents ($59.99) makes every round figure a
                          // step mismatch — $200 would report itself invalid.
                          step="any"
                          value={customAmount}
                          onChange={(e) => setCustomAmount(e.target.value)}
                          onBlur={() => {
                            // Fire on commit, not per keystroke, so we capture
                            // the buyer's intended figure once instead of N noisy
                            // partial values.
                            if (parsedCustom === null || !Number.isFinite(parsedCustom)) return;
                            trackEvent("custom_amount_entered", {
                              plan,
                              amount: parsedCustom,
                              valid: customValid,
                            });
                          }}
                          placeholder={price !== null ? fmtPrice(price) : ""}
                          // 44px — it's a payment field on a phone.
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
                      <p className="mt-2 text-body-sm text-danger" role="alert">
                        Minimum is ${fmtPrice(price)}/{plan === "yearly" ? "yr" : "mo"}.
                      </p>
                    ) : null}

                    {/* The unlock. Announced politely so a screen-reader user
                        crossing the threshold with arrow keys hears it too. */}
                    <div aria-live="polite">
                      {isFounding ? (
                        <div className="mt-4 border-l-2 border-founding bg-founding/8 p-4">
                          <div className="eyebrow text-founding">
                            You'll unlock Founding Member
                          </div>
                          <p className="mt-2 text-body-sm text-fg">
                            Your Circle profile will show this badge for as long as
                            your {plan === "yearly" ? "annual" : "monthly"} gift stays
                            at this level.
                          </p>
                        </div>
                      ) : foundingAt !== null ? (
                        <p className="mt-4 text-body-sm text-fg-muted">
                          Give ${fmtPrice(foundingAt)}/{plan === "yearly" ? "yr" : "mo"}{" "}
                          or more and you'll unlock a{" "}
                          <span className="text-founding">Founding Member</span> badge
                          in the community.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      trackEvent("checkout_opened", {
                        plan,
                        amount,
                        is_custom_amount: customValid,
                        is_founding: isFounding,
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

                {/* Includes column */}
                <div className="p-8">
                  <div className="eyebrow text-fg-muted">
                    Every Ark+ member gets
                  </div>
                  <ul className="mt-5 space-y-3 text-body-sm text-fg">
                    {[
                      "Inside Call Me Back — private, ad-free feed",
                      "Members-only newsletters",
                      "The Ark Media community in Circle",
                      "Live events and Q&As",
                    ].map((f) => (
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
        customAmount={customValid ? (parsedCustom as number) : null}
        onClose={() => setCheckoutOpen(false)}
      />
    </section>
  );
}
