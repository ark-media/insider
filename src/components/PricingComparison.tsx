import { Fragment, useState } from "react";
import { BillingPeriodToggle } from "./BillingPeriodToggle";
import { CheckoutModal } from "./CheckoutModal";
import { PriceSkeleton } from "./PriceSkeleton";
import { useAsyncResource } from "../lib/useAsyncResource";
import { trackEvent } from "../lib/analytics";
import type { Tier } from "../data/pricingTiers";
import { type TierAmounts, formatMinor } from "../lib/currency";

type Plan = "monthly" | "yearly";

// Column order mirrors the card grid: Ark+, the Bundle (featured), Community.
const COLUMNS: { key: Tier; label: string; featured?: boolean }[] = [
  { key: "ark-plus", label: "Ark+" },
  { key: "bundle", label: "Ark+ & Community", featured: true },
  { key: "circle", label: "Community" },
];

type Row = { label: string; detail?: string[]; tiers: Record<Tier, boolean> };
type Group = { heading: string; rows: Row[] };

// The truthful grant per tier, and the specific shows/items behind each
// benefit. Entitlements themselves are derived server-side from each tier's
// Stripe product; this table is the reader-facing summary.
const GROUPS: Group[] = [
  {
    heading: "Podcasts & video",
    rows: [
      {
        label: "Ad-free podcasts",
        detail: [
          "Call Me Back",
          "Ark News Daily",
          "For Heaven's Sake",
          "Chosen People Problems",
        ],
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
      {
        label: "Subscriber-exclusive content",
        detail: [
          "Inside Call Me Back — in your Call Me Back feed",
          "Chosen People Problems AMA",
          "Ark News Daily 6th episode",
        ],
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
      {
        label: "Early access",
        detail: [
          "Mid-week Call Me Back episode — Wednesdays, not Fridays",
          "History show",
        ],
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
      {
        label: "Ad-free video episodes",
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
    ],
  },
  {
    heading: "Community & newsletters",
    rows: [
      {
        label: "Premium access to the Community app",
        tiers: { "ark-plus": false, bundle: true, circle: true },
      },
      {
        label: "Full access to Ark Media newsletters",
        detail: ["Weekly roundup", "Ark+ paid newsletter with Nadav's column"],
        tiers: { "ark-plus": true, bundle: true, circle: true },
      },
    ],
  },
];

function Mark({ on }: { on: boolean }) {
  return on ? (
    <svg
      viewBox="0 0 20 20"
      className="mx-auto size-5 text-cyan"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  ) : (
    <span className="mx-auto block h-px w-4 bg-rule-strong" aria-hidden="true" />
  );
}

// Feature-comparison table for the /pricing page — the primary buying surface
// there (the card grid was removed). A shared Monthly/Annual toggle sets the
// billing period; each column's "Choose" button opens checkout for that tier at
// that period. Amount (pay-what-you-choose) and the exact price are set inside
// the checkout modal, which sources them live from Stripe.
export function PricingComparison() {
  const [plan, setPlan] = useState<Plan>("yearly");
  const [checkout, setCheckout] = useState<{ tier: Tier } | null>(null);

  // "From $X" floor per column, sourced live from Stripe (never hardcoded) — the
  // same values the cards on /plus show. Price is secondary here: if it fails to
  // load, the column simply omits the line and the "Choose" CTA (which fetches
  // its own price in the modal) still works.
  const pricing = useAsyncResource(async () => {
    const res = await fetch("/api/pricing");
    if (!res.ok) throw new Error("pricing request failed");
    const data = (await res.json().catch(() => ({}))) as {
      tiers?: Record<string, TierAmounts>;
      default_currency?: string;
      minor_factors?: Record<string, number>;
    };
    if (!data.tiers) throw new Error("pricing response malformed");
    const currency = data.default_currency ?? "usd";
    const factor = data.minor_factors?.[currency] ?? 100;
    return { tiers: data.tiers, currency, factor };
  }, []);
  const data = pricing.status === "ready" ? pricing.data : null;
  const tiers = data?.tiers ?? null;
  const currency = data?.currency ?? "usd";
  const factor = data?.factor ?? 100;

  // "From <price>" floor per column, formatted in the buyer's currency, or null
  // if pricing hasn't loaded.
  const floorFor = (key: Tier): string | null => {
    const t = tiers?.[key];
    if (!t) return null;
    const minor = (plan === "yearly" ? t.yearly : t.monthly)[currency];
    return typeof minor === "number" ? formatMinor(minor, currency, factor) : null;
  };

  const colClass = (featured?: boolean) =>
    featured ? "bg-navy-800/50" : "";

  const selectPeriod = (p: Plan) => {
    setPlan(p);
    trackEvent("plan_selected", { plan: p });
  };

  const openCheckout = (tier: Tier) => {
    trackEvent("checkout_opened", {
      plan,
      tier,
      amount: null,
      is_custom_amount: false,
    });
    setCheckout({ tier });
  };

  return (
    <section className="relative">
      <div className="page-gutter pt-14 pb-16">
        <div className="mx-auto max-w-2xl text-center">
          <div className="eyebrow">Compare plans</div>
          <h2 className="mt-3 text-h2">What you get with each tier</h2>
        </div>

        <div className="mt-8 flex justify-center">
          <BillingPeriodToggle plan={plan} onChange={selectPeriod} />
        </div>

        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <caption className="sr-only">
              Feature comparison across Ark+, Ark+ &amp; Community, and Community
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-2/5 p-4 align-bottom" />
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`p-4 text-center align-bottom ${colClass(c.featured)} ${
                      c.featured ? "border-t-2 border-cyan" : ""
                    }`}
                  >
                    {c.featured ? (
                      <div className="mb-1 button-text font-display font-bold text-cyan">
                        Best value
                      </div>
                    ) : null}
                    <div className="text-h5 font-display font-bold text-fg-strong">
                      {c.label}
                    </div>
                    <div className="mt-2 text-body-sm text-fg-muted">
                      {floorFor(c.key) !== null ? (
                        <>
                          From{" "}
                          <span className="text-fg-strong">
                            {floorFor(c.key)}
                          </span>
                          <span className="whitespace-nowrap">
                            {" "}
                            / {plan === "yearly" ? "yr" : "mo"}
                          </span>
                        </>
                      ) : pricing.status === "error" ? null : (
                        <PriceSkeleton className="h-[1em] w-16" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((group) => (
                <Fragment key={group.heading}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={COLUMNS.length + 1}
                      className="border-t border-rule pt-6 pb-2 eyebrow text-fg-muted"
                    >
                      {group.heading}
                    </th>
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.label} className="border-t border-rule-soft">
                      <th
                        scope="row"
                        className="py-3.5 pr-4 align-top font-normal"
                      >
                        <span className="block text-body-sm text-fg">
                          {row.label}
                        </span>
                        {row.detail ? (
                          <ul className="mt-1.5 space-y-1 text-xs leading-snug text-fg-faint">
                            {row.detail.map((item) => (
                              <li key={item} className="flex gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className="mt-1.5 size-1 shrink-0 rounded-full bg-rule-strong"
                                />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </th>
                      {COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          className={`py-3.5 text-center align-top ${colClass(c.featured)}`}
                        >
                          <Mark on={row.tiers[c.key]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="p-4" />
                {COLUMNS.map((c) => (
                  <td
                    key={c.key}
                    className={`p-4 text-center align-top ${colClass(c.featured)} ${
                      c.featured ? "border-b-2 border-cyan" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => openCheckout(c.key)}
                      className={`group inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 button-text font-display font-bold tracking-cta transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                        c.featured
                          ? "bg-cyan text-navy hover:bg-fg-strong hover:text-navy-900"
                          : "border border-cyan text-cyan hover:bg-cyan hover:text-navy"
                      }`}
                    >
                      Choose
                      <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1">
                        →
                      </span>
                    </button>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <CheckoutModal
        open={checkout !== null}
        plan={plan}
        tier={checkout?.tier ?? "bundle"}
        onClose={() => setCheckout(null)}
      />
    </section>
  );
}
