import { useState } from "react";
import { CheckoutModal } from "./CheckoutModal";

export function Pricing() {
  const [plan, setPlanRaw] = useState<"monthly" | "yearly">("yearly");
  const [customAmount, setCustomAmount] = useState<string>("");
  const setPlan = (p: "monthly" | "yearly") => {
    setPlanRaw(p);
    setCustomAmount("");
  };
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const price = plan === "yearly" ? 80 : 8;
  const parsedCustom = customAmount.trim() === "" ? null : Number(customAmount);
  const customValid =
    parsedCustom !== null && Number.isFinite(parsedCustom) && parsedCustom >= price;

  return (
    <section id="pricing" className="relative bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 pt-20 pb-24 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="inside-tab text-[13px]">Join the insiders</div>
            <h2 className="mt-10 text-white">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Pick your
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                own <span className="display text-cyan">terms.</span>
              </span>
            </h2>
            <p className="mt-6 max-w-md text-[14px] leading-[1.6] text-white/70">
              Eight dollars a month or eighty a year — or name a higher amount
              to support the show. Every Insider gets the same feed, the same
              Q&amp;As, the same complete interviews.
            </p>
            <ul className="mt-10 space-y-2 text-[13px] text-white/55">
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Cancel anytime
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Gift subscriptions available
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block size-1.5 rounded-full bg-cyan" />
                Secure checkout
              </li>
            </ul>
          </div>

          <div className="lg:col-span-7">
            {/* Plan toggle */}
            <div role="tablist" className="inline-flex border border-white/20 p-1">
              {(["monthly", "yearly"] as const).map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={plan === p}
                  onClick={() => setPlan(p)}
                  className={`relative px-6 py-2 font-display text-[12px] font-bold uppercase tracking-[0.18em] transition ${
                    plan === p
                      ? "bg-cyan text-navy"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {p}
                  {p === "yearly" && (
                    <span className={`ml-2 text-[10px] ${plan === p ? "text-navy/70" : "text-cyan"}`}>
                      −17%
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Plan block */}
            <div className="mt-6 border border-white/15 bg-navy-800/50">
              <div className="grid grid-cols-1 sm:grid-cols-[1.1fr_1fr]">
                {/* Price column */}
                <div className="relative border-b border-white/12 p-8 sm:border-b-0 sm:border-r">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                    {plan === "yearly" ? "Annual · billed once" : "Monthly · billed monthly"}
                  </div>
                  <div className="mt-6 flex items-baseline gap-2 text-white">
                    <span className="display-upright text-[clamp(3.5rem,7vw,5rem)] leading-none">
                      ${price}
                    </span>
                    <span className="text-[14px] text-white/55">
                      / {plan === "yearly" ? "year" : "month"}
                    </span>
                  </div>
                  <div className="mt-3 text-[13px] text-white/55">
                    {plan === "yearly"
                      ? "Works out to $6.67 a month."
                      : "Or save with an annual plan."}
                  </div>

                  {/* Custom amount */}
                  <div className="mt-10">
                    <label className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">
                      Or name your price
                    </label>
                    <div className="mt-2 flex items-center border-b border-white/25 pb-2 focus-within:border-cyan">
                      <span className="mr-2 text-[22px] text-white/55">$</span>
                      <input
                        type="number"
                        min={price}
                        value={customAmount}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        placeholder={plan === "yearly" ? "120" : "12"}
                        className="w-full bg-transparent text-[22px] text-white outline-none placeholder:text-white/25"
                      />
                      <span className="text-[12px] text-white/55">
                        / {plan === "yearly" ? "yr" : "mo"}
                      </span>
                    </div>
                    {parsedCustom !== null &&
                      Number.isFinite(parsedCustom) &&
                      parsedCustom < price && (
                        <p className="mt-2 text-[11px] text-signal/90">
                          Minimum is ${price}/{plan === "yearly" ? "yr" : "mo"}.
                        </p>
                      )}
                  </div>
                </div>

                {/* Includes column */}
                <div className="p-8">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">
                    Every Insider receives
                  </div>
                  <ul className="mt-5 space-y-3 text-[14px] text-white/80">
                    {[
                      "Private, ad-free RSS feed",
                      "Weekly subscriber debriefs",
                      "Full-length unedited interviews",
                      "Q&A episodes every other week",
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
                    className="group mt-8 inline-flex w-full items-center justify-between bg-cyan px-5 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-white"
                  >
                    Start my subscription
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
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
        defaultAmount={price}
        customAmount={customValid ? (parsedCustom as number) : null}
        onClose={() => setCheckoutOpen(false)}
      />
    </section>
  );
}
