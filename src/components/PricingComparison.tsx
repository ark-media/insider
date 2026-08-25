import { Fragment, useState } from "react";
import { BillingPeriodToggle } from "./BillingPeriodToggle";
import { CheckoutModal } from "./CheckoutModal";
import { OutboundLink } from "./OutboundLink";
import { PriceSkeleton } from "./PriceSkeleton";
import { ApplePodcastsIcon } from "./PlatformIcons";
import { trackEvent } from "../lib/analytics";
import { socialUrls } from "../config/urls";
import { formatMinor, type TierAmounts } from "../lib/currency";
import { usePricing, annualSavingsPct } from "../lib/usePricing";
import type { Tier } from "../data/pricingTiers";

type Plan = "monthly" | "yearly";

// "apple" is not one of our Stripe tiers — it's the same Ark+ audio membership
// bought inside Apple Podcasts, where Apple owns the billing and only the audio
// benefits can be delivered. It has no price here and no checkout of ours.
type ColumnKey = Tier | "apple";

type Column = {
  key: ColumnKey;
  label: string;
  /** Where the plan is bought — only shown where it disambiguates. */
  sublabel?: string;
  featured?: boolean;
};

// Column order mirrors the card grid — Ark+, the Bundle (featured, second),
// Community — with the Apple Podcasts flavour of Ark+ slotted in before it.
const COLUMNS: Column[] = [
  { key: "bundle", label: "Ark+ & Community", featured: true },
  { key: "ark-plus", label: "Ark+", sublabel: "Website" },
  { key: "apple", label: "Ark+", sublabel: "Apple Podcasts" },
  { key: "circle", label: "Community" },
];

// `summary` and `detail` never render inside the table — the rows stay to their
// bare labels so the grid reads cleanly — they feed the Details block below it.
type Row = {
  label: string;
  /**
   * Heads the row below `md`, where the label column is only ~a third of a
   * phone's width. The full label still heads this row's Details entry, so
   * nothing is lost — only the grid gets the abbreviation.
   */
  shortLabel?: string;
  summary?: string;
  detail?: string[];
  tiers: Record<ColumnKey, boolean>;
};
type Group = { rows: Row[] };

// The truthful grant per tier, and the specific shows/items behind each
// benefit. Entitlements themselves are derived server-side from each tier's
// Stripe product; this table is the reader-facing summary. The Apple Podcasts
// column carries only what Apple's own subscription can deliver — the private
// audio feed — so the video, community, and newsletter rows are blank there.
const GROUPS: Group[] = [
  {
    rows: [
      {
        label: "Ad-free podcasts",
        summary: "Every Ark Media show in a private feed, with the ads cut.",
        detail: [
          "Call Me Back",
          "Ark News Daily",
          "For Heaven's Sake",
          "Chosen People Problems",
        ],
        tiers: { "ark-plus": true, apple: true, bundle: true, circle: false },
      },
      {
        label: "Subscriber-exclusive content",
        shortLabel: "Exclusive episodes",
        summary: "Episodes only members hear.",
        detail: [],
        tiers: { "ark-plus": true, apple: true, bundle: true, circle: false },
      },
      {
        label: "Early access",
        summary: "Hear it before everyone else.",
        detail: [],
        tiers: { "ark-plus": true, apple: true, bundle: true, circle: false },
      },
      {
        label: "Ad-free video episodes",
        shortLabel: "Ad-free video",
        summary: "The video editions of the shows, without the ad breaks.",
        tiers: { "ark-plus": true, apple: false, bundle: true, circle: false },
      },
    ],
  },
  {
    rows: [
      {
        label: "Premium access to the Community app",
        shortLabel: "Community app",
        summary: "The Ark Media community app, in full.",
        detail: [
          "Conversations with the hosts and fellow members",
          "Live member events & Q&As",
          "Dan's book club",
          "Members-only spaces",
        ],
        tiers: { "ark-plus": false, apple: false, bundle: true, circle: true },
      },
      {
        label: "Full access to Ark Media newsletters",
        shortLabel: "Newsletters",
        summary: "Both member newsletters, in your inbox.",
        detail: ["Weekly roundup", "Ark+ paid newsletter with Nadav's column"],
        tiers: { "ark-plus": true, apple: false, bundle: true, circle: true },
      },
    ],
  },
];

const ALL_ROWS = GROUPS.flatMap((g) => g.rows);

// Every row that has something to expand on, flattened out of its group — the
// Details block reads as one list, not a repeat of the table's grouping.
const DETAILS = ALL_ROWS.filter((r) => r.summary || r.detail);

// Below `md` the priced footer is dropped, so the featured column's cyan box
// has no bottom edge — it gets capped on the last body row instead.
const LAST_ROW_LABEL = ALL_ROWS[ALL_ROWS.length - 1].label;

// The three tiers we actually sell, in column order (the Bundle leads). Backs
// the stacked buy blocks that replace the table's footer below `md`.
const BUY_COLUMNS = COLUMNS.filter(
  (c): c is Column & { key: Tier } => c.key !== "apple",
);

// Shared by the "Choose" buttons and the Apple Podcasts link so a tier you buy
// from us and one you buy from Apple sit on the same baseline in the CTA row.
const CTA_CLASS =
  "group inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 button-text font-display font-bold tracking-cta transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";
const CTA_ARROW_CLASS =
  "transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1";

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
    <span
      className="mx-auto block h-px w-4 bg-rule-strong"
      aria-hidden="true"
    />
  );
}

// Feature-comparison table. A shared Monthly/Annual toggle sets the billing
// period, and picking a column opens checkout for that tier at that period.
//
// Prices sit above the CTA rather than in the column head — the one place the
// table quotes a number, at the moment of the decision. For the three tiers we
// sell they are a FLOOR ("From $X"): every tier is pay-what-you-choose, so the
// final amount — and the currency — are settled in the checkout modal, which
// sources them live from Stripe. Apple sells the same Ark+ membership at the
// same price but with no pay-more option, so that column quotes the Ark+
// amounts under a "Fixed" label.
//
// Two presentations:
//   "standalone" (/pricing) — the primary buying surface, and the only place
//     these prices appear: a Monthly/Annual toggle, and per column a price and
//     a "Choose" button that opens checkout for that tier at that period.
//   "reference" (/plus)     — sits below the card grid, which already owns the
//     toggle, the prices, and the CTAs. Here the table is purely a read-only
//     summary of what each tier includes: no toggle, no prices, no buttons, and
//     nothing to click or hover.
export function PricingComparison({
  variant = "standalone",
}: {
  variant?: "standalone" | "reference";
}) {
  const reference = variant === "reference";
  const [plan, setPlan] = useState<Plan>("yearly");
  const [checkout, setCheckout] = useState<{ tier: Tier } | null>(null);

  const pricing = usePricing();
  const tiers = pricing.data?.tiers ?? null;
  const currency = pricing.data?.currency ?? "usd";
  const factor = pricing.data?.factor ?? 100;
  // A failed price fetch must not take the comparison down with it: the columns
  // just lose their price line, and checkout — which fetches its own prices —
  // still works. While it loads, the prices are skeletons.
  const showPrices = !reference && pricing.status !== "error";
  const toggleSavings = tiers ? annualSavingsPct(tiers.bundle) : null;

  // Apple sells the same Ark+ membership at the same price, so that column
  // quotes the Ark+ amounts — the difference is that Apple has no pay-more
  // option, which the "Fixed" / "From" label carries.
  const amountsFor = (key: ColumnKey): TierAmounts | null =>
    tiers ? tiers[key === "apple" ? "ark-plus" : key] : null;

  const priceMinor = (key: ColumnKey): number | null => {
    const amounts = amountsFor(key);
    if (!amounts) return null;
    return (
      (plan === "yearly" ? amounts.yearly : amounts.monthly)[currency] ?? null
    );
  };

  const colClass = (c: Column) => (c.featured ? "bg-navy-800/50" : "");

  // Apple is desktop-only. Four columns is what forced the grid off-screen on
  // a phone, and Apple was never a fourth plan — it's Ark+ bought elsewhere,
  // so below `md` it steps out of the table and into the note beneath it.
  const mobileHidden = (c: Column) =>
    c.key === "apple" ? "hidden md:table-cell" : "";

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

        {reference ? null : (
          <div className="mt-8 flex justify-center">
            <BillingPeriodToggle
              plan={plan}
              onChange={selectPeriod}
              savingsPct={toggleSavings}
            />
          </div>
        )}

        {/* Only wide enough to need scrolling from `md` up, where the Apple
            column and the priced footer come back. The region/tabIndex pair
            keeps that scroll reachable from the keyboard (WCAG 2.1.1). */}
        <div
          className="mt-10 overflow-x-auto"
          role="region"
          aria-label="Plan comparison"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-left md:min-w-[44rem]">
            <caption className="sr-only">
              Which benefits are included in each plan
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="w-1/3 py-3 pr-2 align-bottom md:p-4"
                />
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    // `max-md:w-[22%]` only: below `md` the auto layout sizes
                    // each column to its heading, which hands "Ark+ &
                    // Community" three times the width of "Ark+". From `md`
                    // the fixed table width makes that moot.
                    className={`px-1 py-3 text-center align-bottom max-md:w-[22%] md:p-4 ${colClass(c)} ${mobileHidden(c)} ${
                      c.featured ? "border-t-2 border-cyan" : ""
                    }`}
                  >
                    {/* On mobile the stacked buy blocks below carry this flag —
                        it will not fit in a column an inch wide. */}
                    {c.featured ? (
                      <div className="mb-1 hidden button-text font-display font-bold text-cyan md:block">
                        Best value
                      </div>
                    ) : null}
                    <div className="font-display text-xs leading-tight font-bold text-fg-strong md:text-base">
                      {c.label}
                    </div>
                    {/* Only from `md`, where the Apple column exists and the
                        "Website" sublabel has something to disambiguate from.
                        There, always rendered, empty or not, and at a FIXED
                        height rather than a minimum: text, the Apple icon, and
                        nothing at all each measure slightly differently, which
                        would stagger the four column names off their
                        baseline. */}
                    <div className="mt-1.5 hidden h-6 items-center justify-center gap-1.5 text-body-sm text-fg-muted md:flex">
                      {c.key === "apple" ? (
                        <ApplePodcastsIcon className="size-4 shrink-0" />
                      ) : null}
                      {c.sublabel}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((group, index) => (
                <Fragment key={index}>
                  {group.rows.map((row) => (
                    <tr key={row.label} className="border-t border-rule-soft">
                      <th
                        scope="row"
                        className="py-2.5 pr-2 align-middle font-normal md:pr-4"
                      >
                        <span className="block text-body-sm text-fg">
                          {row.shortLabel ? (
                            <>
                              <span className="md:hidden">
                                {row.shortLabel}
                              </span>
                              <span className="hidden md:inline">
                                {row.label}
                              </span>
                            </>
                          ) : (
                            row.label
                          )}
                        </span>
                      </th>
                      {COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          className={`py-2.5 text-center align-middle ${colClass(c)} ${mobileHidden(c)} ${
                            c.featured && row.label === LAST_ROW_LABEL
                              ? "border-b-2 border-cyan md:border-b-0"
                              : ""
                          }`}
                        >
                          <Mark on={row.tiers[c.key]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            {/* Prices and CTAs live in the table only from `md`. Below that
                they would sit at the far end of both axes — a horizontal
                scroll away from the row they belong to — so they become the
                stacked buy blocks under the table instead. */}
            <tfoot className="hidden md:table-footer-group">
              <tr>
                <td />
                {COLUMNS.map((c) => {
                  // Bound to a const so the "apple" check still narrows inside
                  // the button's onClick — a property access wouldn't.
                  const key = c.key;
                  const amounts = amountsFor(key);
                  const minor = priceMinor(key);
                  const savings =
                    plan === "yearly" && amounts
                      ? annualSavingsPct(amounts)
                      : null;
                  return (
                    <td
                      key={key}
                      className={`text-center align-top ${reference ? "p-2" : "p-4"} ${colClass(c)} ${
                        c.featured ? "border-b-2 border-cyan" : ""
                      }`}
                    >
                      {/* The price for the selected period, sat directly above
                          the CTA — the one place the table quotes a price, at
                          the moment of the decision. "From" vs "Fixed" is the
                          real difference between buying here and buying in
                          Apple Podcasts: same amount, but Apple has no
                          pay-more. The height floor keeps the four blocks equal
                          so the buttons share a baseline. */}
                      {showPrices ? (
                        <div className="mb-4 flex min-h-[5.5rem] flex-col items-center justify-end">
                          <span className="meta">
                            {key === "apple" ? "" : "From"}
                          </span>
                          <span className="display-upright mt-1 whitespace-nowrap text-[clamp(1.5rem,2.4vw,2rem)] tabular-nums text-fg-strong">
                            {minor !== null ? (
                              formatMinor(minor, currency, factor)
                            ) : (
                              <PriceSkeleton className="h-[0.8em] w-16" />
                            )}
                          </span>
                          <span className="mt-1.5 text-body-sm">
                            per {plan === "yearly" ? "year" : "month"}
                            {savings !== null ? (
                              <span className="text-cyan">
                                {" "}
                                · Save {savings}%
                              </span>
                            ) : null}
                          </span>
                        </div>
                      ) : null}

                      {/* In the reference variant this row is just the featured
                          column's bottom cap — the CTAs live in the cards above. */}
                      {reference ? null : key === "apple" ? (
                        // Apple sells this one, so the CTA hands off to them
                        // rather than opening our checkout.
                        <OutboundLink
                          href={socialUrls.applePodcasts}
                          platform="apple_podcasts"
                          placement="pricing_table"
                          className={`${CTA_CLASS} border border-cyan text-cyan hover:bg-cyan hover:text-navy`}
                        >
                          Subscribe
                          <span className={CTA_ARROW_CLASS}>→</span>
                        </OutboundLink>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openCheckout(key)}
                          className={`${CTA_CLASS} ${
                            c.featured
                              ? "bg-cyan text-navy hover:bg-fg-strong hover:text-navy-900"
                              : "border border-cyan text-cyan hover:bg-cyan hover:text-navy"
                          }`}
                        >
                          Choose
                          <span className={CTA_ARROW_CLASS}>→</span>
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>

        {/* The mobile buying surface, standing in for the table's footer: one
            full-width block per tier, Bundle first, each with the price for
            the selected period and its own tap target. Same prices, same
            checkout — only the layout differs. */}
        {reference ? null : (
          <div className="mt-8 space-y-4 md:hidden">
            {BUY_COLUMNS.map((c) => {
              const amounts = amountsFor(c.key);
              const minor = priceMinor(c.key);
              const savings =
                plan === "yearly" && amounts ? annualSavingsPct(amounts) : null;
              return (
                <div
                  key={c.key}
                  className={`border p-5 ${
                    c.featured
                      ? "border-cyan bg-navy-800/50"
                      : "border-rule-soft"
                  }`}
                >
                  {c.featured ? (
                    <div className="button-text font-display font-bold text-cyan">
                      Best value
                    </div>
                  ) : null}
                  <div className="text-h5 font-display font-bold text-fg-strong">
                    {c.label}
                  </div>
                  {showPrices ? (
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
                      <span className="meta">From</span>
                      <span className="display-upright whitespace-nowrap text-2xl tabular-nums text-fg-strong">
                        {minor !== null ? (
                          formatMinor(minor, currency, factor)
                        ) : (
                          <PriceSkeleton className="h-[0.8em] w-16" />
                        )}
                      </span>
                      <span className="text-body-sm">
                        per {plan === "yearly" ? "year" : "month"}
                        {savings !== null ? (
                          <span className="text-cyan"> · Save {savings}%</span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => openCheckout(c.key)}
                    className={`${CTA_CLASS} mt-4 ${
                      c.featured
                        ? "bg-cyan text-navy hover:bg-fg-strong hover:text-navy-900"
                        : "border border-cyan text-cyan hover:bg-cyan hover:text-navy"
                    }`}
                  >
                    Choose
                    <span className={CTA_ARROW_CLASS}>→</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* What the dropped Apple column said, in a sentence. The reference
            variant keeps the fact but not the link — that page's CTAs all live
            in the card grid above. */}
        <p className="mt-6 mb-10 text-body-sm md:hidden">
          Ark+ is also available inside Apple Podcasts — audio only, at a fixed
          price.
          {reference ? null : (
            <>
              {" "}
              <OutboundLink
                href={socialUrls.applePodcasts}
                platform="apple_podcasts"
                placement="pricing_table"
                className="text-cyan underline underline-offset-4 transition hover:text-fg-strong"
              >
                Subscribe in Apple Podcasts →
              </OutboundLink>
            </>
          )}
        </p>

        {/* What each row in the table actually gets you. Kept out of the table
            so the grid stays scannable, and read as one flat list — the table's
            grouping does the categorising. */}
        <div className="border-t border-rule pt-5">
          <dl className="mt-5 grid gap-x-10 gap-y-6 sm:grid-cols-2">
            {DETAILS.map((row) => (
              <div key={row.label}>
                <dt className="text-h5 font-display font-bold text-fg-strong">
                  {row.label}
                </dt>
                <dd className="mt-1">
                  {row.summary ? (
                    <p className="text-body-sm">{row.summary}</p>
                  ) : null}
                  {row.detail ? (
                    <ul className="mt-1.5 space-y-1 text-body-sm">
                      {row.detail.map((item) => (
                        <li key={item} className="flex gap-2.5">
                          <span
                            aria-hidden="true"
                            className="mt-2 size-1.5 shrink-0 rounded-full bg-cyan"
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {reference ? null : (
        <CheckoutModal
          open={checkout !== null}
          plan={plan}
          tier={checkout?.tier ?? "bundle"}
          onClose={() => setCheckout(null)}
        />
      )}
    </section>
  );
}
