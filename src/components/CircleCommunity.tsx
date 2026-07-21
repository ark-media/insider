import { useState } from "react";
import { CommunityAppLinks } from "./CommunityAppLinks";
import { CheckoutModal } from "./CheckoutModal";
import { ContentError } from "./ContentError";
import { useAsyncResource } from "../lib/useAsyncResource";
import { trackEvent } from "../lib/analytics";
import { formatMinor } from "../lib/currency";
import { PriceSkeleton } from "./PriceSkeleton";

const pillars = [
  {
    no: "01",
    title: "The conversation, all week",
    body: "The arguments the episodes start, carried on by the people who listen to them — analysts, veterans, students, and the hosts themselves, in the thread with everyone else.",
  },
  {
    no: "02",
    title: "Member events, live",
    body: "Live discussions and Q&As held in the community — the room where questions get asked out loud instead of shouted into a comments section.",
  },
  {
    no: "03",
    title: "Dan's book club",
    body: "One book at a time, read together, with Dan running the discussion. Slow, serious reading in the middle of a very fast news cycle.",
  },
];

/**
 * The community, sold on its own terms — a peer of the Ark+ pricing section, not
 * a line item inside it. Community is its own SKU (the `circle` axis): we bill it
 * through our own Stripe checkout, and it is NOT included with Ark+ (decision
 * #2). The price is sourced live from /api/pricing so it never drifts from what
 * checkout actually charges. Bundle (Ark+ + Community) lives on the Pricing page.
 */
export function CircleCommunity() {
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const pricing = useAsyncResource(async () => {
    const res = await fetch("/api/pricing");
    if (!res.ok) throw new Error("pricing request failed");
    const data = (await res.json().catch(() => ({}))) as {
      tiers?: { circle?: { monthly?: Record<string, number> } };
      default_currency?: string;
      minor_factors?: Record<string, number>;
    };
    const currency = data.default_currency ?? "usd";
    const minor = data.tiers?.circle?.monthly?.[currency];
    if (typeof minor !== "number") throw new Error("pricing response malformed");
    const factor = data.minor_factors?.[currency] ?? 100;
    return { monthlyMinor: minor, currency, factor };
  }, []);
  const monthly = pricing.data ?? null;

  return (
    <section id="community" className="relative border-t border-rule-soft">
      <div className="page-gutter pt-12 pb-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="eyebrow text-cyan">Community</div>
            <h2 className="mt-5 text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Somewhere to
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                <span className="display text-cyan">argue</span> properly.
              </span>
            </h2>
            <p className="mt-6 max-w-md text-body-sm text-fg">
              Join the Ark Media community. Conversations, member events, and
              Dan's book club — in an app built for talking rather than for going
              viral.
            </p>

            {pricing.status === "error" ? (
              // Don't strand the buyer on a dead, disabled button when the price
              // couldn't load — surface an in-place retry, matching the rest of
              // the site's fetch-failure treatment.
              <div className="mt-8">
                <ContentError
                  message="We couldn't load the community price just now."
                  onRetry={pricing.retry}
                />
              </div>
            ) : (
              <>
                <div className="mt-8 flex items-baseline gap-2 text-fg-strong">
                  <span className="display-upright text-[clamp(2.6rem,5vw,3.6rem)] leading-none">
                    {monthly !== null ? (
                      formatMinor(monthly.monthlyMinor, monthly.currency, monthly.factor)
                    ) : (
                      <PriceSkeleton className="h-[0.7em] w-16" />
                    )}
                  </span>
                  <span className="text-body-sm">/ month</span>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    trackEvent("circle_join_clicked");
                    setCheckoutOpen(true);
                  }}
                  disabled={monthly === null}
                  className="group mt-6 inline-flex min-h-12 w-full items-center justify-between bg-cyan px-5 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:gap-8"
                >
                  Join the community
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                    →
                  </span>
                </button>

                <p className="mt-6 max-w-md text-body-sm text-fg-muted">
                  Want the private feed too? The Ark+ &amp; Community bundle
                  covers both — see the plans above.
                </p>
              </>
            )}
          </div>

          <div className="lg:col-span-7">
            <ol>
              {pillars.map((p) => (
                <li
                  key={p.no}
                  className="grid grid-cols-[auto_1fr] gap-x-8 border-t border-rule py-7 first:border-t-0 first:pt-0 sm:gap-x-14"
                >
                  <div className="display-upright text-[20px] text-cyan sm:text-[22px]">
                    {p.no}
                  </div>
                  <div className="max-w-[54ch]">
                    <h3 className="display-upright text-[20px] leading-tight text-fg-strong sm:text-[22px]">
                      {p.title}
                    </h3>
                    <p className="mt-3 text-body-sm">{p.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-8 border-t border-rule pt-7">
              <div className="eyebrow text-fg-muted">Get the app</div>
              <CommunityAppLinks className="mt-4" />
            </div>
          </div>
        </div>
      </div>
      <CheckoutModal
        open={checkoutOpen}
        plan="monthly"
        tier="circle"
        onClose={() => setCheckoutOpen(false)}
      />
    </section>
  );
}
