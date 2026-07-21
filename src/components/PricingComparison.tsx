import { Fragment, useRef, useState } from "react";
import { CheckoutModal } from "./CheckoutModal";
import { useAsyncResource } from "../lib/useAsyncResource";
import { trackEvent } from "../lib/analytics";
import type { Tier } from "../data/pricingTiers";

type Plan = "monthly" | "yearly";
type TierPricing = { monthly_cents: number; yearly_cents: number };

function fmtPrice(dollars: number): string {
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

// Column order mirrors the card grid: Ark+, the Bundle (featured), Community.
const COLUMNS: { key: Tier; label: string; featured?: boolean }[] = [
  { key: "ark-plus", label: "Ark+" },
  { key: "bundle", label: "Ark+ & Community", featured: true },
  { key: "circle", label: "Community" },
];

type Row = { label: string; tiers: Record<Tier, boolean> };
type Group = { heading: string; rows: Row[] };

// The truthful grant per tier — kept in sync with the `includes` copy in
// PricingCards. Entitlements themselves are derived server-side from each
// tier's Stripe product; this table is the reader-facing summary.
const GROUPS: Group[] = [
  {
    heading: "Podcasts & newsletters",
    rows: [
      {
        label: "Every Ark Media podcast, ad-free",
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
      {
        label: "Inside Call Me Back — private feed",
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
      {
        label: "Members-only newsletters",
        tiers: { "ark-plus": true, bundle: true, circle: false },
      },
    ],
  },
  {
    heading: "Community",
    rows: [
      {
        label: "The Ark Media community in Circle",
        tiers: { "ark-plus": false, bundle: true, circle: true },
      },
      {
        label: "Live member events & Q&As",
        tiers: { "ark-plus": false, bundle: true, circle: true },
      },
      {
        label: "Dan's book club",
        tiers: { "ark-plus": false, bundle: true, circle: true },
      },
    ],
  },
  {
    heading: "Every membership",
    rows: [
      {
        label: "Pay what you choose",
        tiers: { "ark-plus": true, bundle: true, circle: true },
      },
      {
        label: "Cancel anytime",
        tiers: { "ark-plus": true, bundle: true, circle: true },
      },
      {
        label: "Pay in your local currency",
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
  const periodRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // "From $X" floor per column, sourced live from Stripe (never hardcoded) — the
  // same values the cards on /plus show. Price is secondary here: if it fails to
  // load, the column simply omits the line and the "Choose" CTA (which fetches
  // its own price in the modal) still works.
  const pricing = useAsyncResource(async () => {
    const res = await fetch("/api/pricing");
    if (!res.ok) throw new Error("pricing request failed");
    const data = (await res.json().catch(() => ({}))) as {
      tiers?: Record<string, TierPricing>;
    };
    if (!data.tiers) throw new Error("pricing response malformed");
    return data.tiers;
  }, []);
  const tiers = pricing.status === "ready" ? pricing.data : null;

  const floorFor = (key: Tier): number | null => {
    const t = tiers?.[key];
    if (!t) return null;
    const cents = plan === "yearly" ? t.yearly_cents : t.monthly_cents;
    return typeof cents === "number" ? cents / 100 : null;
  };

  const colClass = (featured?: boolean) =>
    featured ? "bg-navy-800/50" : "";

  const PERIODS = ["monthly", "yearly"] as const;
  const selectPeriod = (p: Plan) => {
    setPlan(p);
    trackEvent("plan_selected", { plan: p });
  };
  // Roving-tabindex keyboard model for the billing-period radiogroup.
  const onPeriodKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      next = (index + 1) % PERIODS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (index - 1 + PERIODS.length) % PERIODS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = PERIODS.length - 1;
    else return;
    e.preventDefault();
    selectPeriod(PERIODS[next]);
    periodRefs.current[next]?.focus();
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
          <div
            role="radiogroup"
            aria-label="Billing period"
            className="inline-flex border border-rule-strong p-1"
          >
            {PERIODS.map((p, i) => (
              <button
                key={p}
                ref={(el) => {
                  periodRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={plan === p}
                tabIndex={plan === p ? 0 : -1}
                onKeyDown={(e) => onPeriodKeyDown(e, i)}
                onClick={() => selectPeriod(p)}
                className={`relative inline-flex min-h-11 items-center justify-center px-6 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                  plan === p
                    ? "bg-cyan text-navy"
                    : "text-fg-muted hover:text-fg-strong"
                }`}
              >
                {p === "yearly" ? "Annual" : "Monthly"}
              </button>
            ))}
          </div>
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
                            ${fmtPrice(floorFor(c.key) as number)}
                          </span>
                          <span className="whitespace-nowrap">
                            {" "}
                            / {plan === "yearly" ? "yr" : "mo"}
                          </span>
                        </>
                      ) : pricing.status === "error" ? null : (
                        <span className="inline-block h-[1em] w-16 animate-pulse rounded bg-rule-strong/40 align-middle" />
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
                        className="py-3.5 pr-4 text-body-sm font-normal text-fg"
                      >
                        {row.label}
                      </th>
                      {COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          className={`py-3.5 text-center ${colClass(c.featured)}`}
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
