import { useEffect, useState } from "react";
import { CheckoutModal } from "./CheckoutModal";

function fmtPrice(dollars: number): string {
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

export function Pricing() {
  const [plan, setPlanRaw] = useState<"monthly" | "yearly">("yearly");
  const [customAmount, setCustomAmount] = useState<string>("");
  const setPlan = (p: "monthly" | "yearly") => {
    setPlanRaw(p);
    setCustomAmount("");
  };
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  // Prices come from Stripe (the source of truth) via /api/pricing — never
  // hardcoded, so the displayed amount can't drift from what we actually
  // charge. (USD source amount; buyers pay the localized equivalent.)
  const [prices, setPrices] = useState<{ monthly: number; yearly: number } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/pricing");
        const data = (await res.json().catch(() => ({}))) as {
          monthly_cents?: number;
          yearly_cents?: number;
        };
        if (
          !cancelled &&
          typeof data.monthly_cents === "number" &&
          typeof data.yearly_cents === "number"
        ) {
          setPrices({
            monthly: data.monthly_cents / 100,
            yearly: data.yearly_cents / 100,
          });
        }
      } catch {
        /* leave prices null — UI shows a loading state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <section id="pricing" className="relative bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 pt-20 pb-24 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="inside-tab text-[13px]">Become a member</div>
            <h2 className="mt-10 text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Pick your
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                own <span className="display text-cyan">terms.</span>
              </span>
            </h2>
            <p className="mt-6 max-w-md text-[14px] leading-[1.6] text-fg">
              {prices
                ? `$${fmtPrice(prices.monthly)} a month or $${fmtPrice(prices.yearly)} a year`
                : "Monthly or annual"}{" "}
              — or name a higher amount to support the work. Every Ark+ member
              gets the same bundle, the same paid feed, the same community.
            </p>
            <ul className="mt-10 space-y-2 text-[13px] text-fg-muted">
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
            {/* Plan toggle */}
            <div role="group" aria-label="Billing period" className="inline-flex border border-rule-strong p-1">
              {(["monthly", "yearly"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={plan === p}
                  onClick={() => setPlan(p)}
                  className={`relative inline-flex min-h-11 items-center px-6 font-display text-[12px] font-bold uppercase tracking-button transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                    plan === p
                      ? "bg-cyan text-navy"
                      : "text-fg-muted hover:text-fg-strong"
                  }`}
                >
                  {p}
                  {p === "yearly" && savingsPct ? (
                    <span className={`ml-2 text-[10px] ${plan === p ? "text-navy/70" : "text-cyan"}`}>
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
                  <div className="mt-6 flex items-baseline gap-2 text-fg-strong">
                    <span className="display-upright text-[clamp(3.5rem,7vw,5rem)] leading-none">
                      {price !== null ? (
                        `$${fmtPrice(price)}`
                      ) : (
                        <span className="inline-block h-[0.7em] w-28 animate-pulse rounded bg-rule-strong/40 align-middle" />
                      )}
                    </span>
                    <span className="text-[14px] text-fg-muted">
                      / {plan === "yearly" ? "year" : "month"}
                    </span>
                  </div>
                  <div className="mt-3 text-[13px] text-fg-muted">
                    {plan === "yearly"
                      ? prices
                        ? `Works out to $${(prices.yearly / 12).toFixed(2)} a month.`
                        : ""
                      : "Or save with an annual plan."}
                  </div>

                  {/* Custom amount */}
                  <div className="mt-10">
                    <label htmlFor="custom-amount" className="eyebrow text-fg-muted">
                      Or name your price
                    </label>
                    <div className="mt-2 flex items-center border-b border-rule-strong pb-2 focus-within:border-cyan">
                      <span className="mr-2 text-[22px] text-fg-muted">$</span>
                      <input
                        id="custom-amount"
                        type="number"
                        min={price ?? undefined}
                        value={customAmount}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        placeholder={plan === "yearly" ? "120" : "12"}
                        className="w-full bg-transparent text-[22px] text-fg-strong outline-none placeholder:text-fg-placeholder"
                      />
                      <span className="text-[12px] text-fg-muted">
                        / {plan === "yearly" ? "yr" : "mo"}
                      </span>
                    </div>
                    {parsedCustom !== null &&
                    Number.isFinite(parsedCustom) &&
                    price !== null &&
                    parsedCustom < price ? (
                      <p className="mt-2 text-[12px] text-danger" role="alert">
                        Minimum is ${fmtPrice(price)}/{plan === "yearly" ? "yr" : "mo"}.
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Includes column */}
                <div className="p-8">
                  <div className="eyebrow text-fg-muted">
                    Every Ark+ member gets
                  </div>
                  <ul className="mt-5 space-y-3 text-[14px] text-fg">
                    {[
                      "Inside Call Me Back — private, ad-free feed",
                      "Members-only newsletters",
                      "The Ark+ community in the Circle app",
                      "Live events and Q&As",
                    ].map((f) => (
                      <li key={f} className="flex items-start gap-3">
                        <span className="mt-[7px] h-px w-4 bg-cyan" />
                        {f}
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    onClick={() => setCheckoutOpen(true)}
                    disabled={price === null}
                    className="group mt-8 inline-flex min-h-12 w-full items-center justify-between bg-cyan px-5 font-display text-[13px] font-bold uppercase tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-cyan disabled:hover:text-navy"
                  >
                    Become a member
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                      →
                    </span>
                  </button>
                </div>
              </div>
            </div>
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
