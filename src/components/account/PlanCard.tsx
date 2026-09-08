import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  createBillingPortalSession,
  type CardOnFile,
  type MySubscription,
} from "../../lib/auth";
import { formatMinor } from "../../lib/currency";
import { formatTimestamp } from "../../../shared/format-date";
import { TIERS } from "../../data/pricingTiers";

// The membership tab's headline card: what the member is on, what it costs,
// when it renews, and what card it comes off.
//
// Every cell here degrades independently. `amountCents` is null whenever the
// subscription's price is quoted in a currency it doesn't bill in, `card` is
// null whenever Stripe can't tell us one, and a gifted member has no
// subscription at all — so each cell is dropped rather than filled with a
// placeholder. A card that says "—" where the money goes is worse than a card
// that doesn't raise the question.

type PaidTier = "ark-plus" | "circle" | "bundle";

export function PlanCard({
  tier,
  subscription,
  loading,
}: {
  tier: PaidTier;
  // Null while the subscription is still loading; a resolved object after.
  subscription: MySubscription | null;
  loading: boolean;
}) {
  const [portal, setPortal] = useState<
    { kind: "idle" } | { kind: "opening" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const meta = TIERS.find((t) => t.key === tier);
  const sub = subscription;
  const cadence = sub?.plan === "yearly" ? "/year" : "/month";

  const price =
    sub && typeof sub.amountCents === "number" && sub.currency
      ? formatMinor(sub.amountCents, sub.currency, sub.minorFactor ?? 100)
      : null;

  // The renewal line answers one of three different questions depending on
  // what's scheduled, so the label changes with it rather than always saying
  // "renews" over a date that is really an ending.
  const renewal = renewalCell(sub);

  const onChangeCard = async () => {
    setPortal({ kind: "opening" });
    const result = await createBillingPortalSession();
    if (result.ok) {
      // A full navigation, not a new tab: the portal returns the member to
      // /account when they're done, so this reads as one continuous errand.
      window.location.href = result.url;
      return;
    }
    setPortal({ kind: "error", message: result.error });
  };

  return (
    <div className="border border-rule bg-navy-800/40">
      <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8 sm:p-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-display text-[22px] font-bold leading-tight text-fg-strong">
              {meta?.label ?? "Your membership"}
            </h2>
            <StatusBadge subscription={sub} loading={loading} />
          </div>
          {meta ? (
            <p className="mt-2 text-body-sm text-fg">{meta.blurb}</p>
          ) : null}
        </div>
        {price ? (
          <p className="shrink-0 whitespace-nowrap font-display text-[28px] font-bold leading-none text-fg-strong">
            {price}
            <span className="text-body-sm font-normal text-fg-muted">
              {cadence}
            </span>
          </p>
        ) : null}
      </div>

      {/* The facts row. Cells are only rendered when we have something true to
          put in them, so a gifted member (no subscription) gets no empty grid. */}
      {renewal || price || sub?.card ? (
        <dl className="grid grid-cols-1 border-t border-rule sm:grid-cols-3">
          {renewal ? (
            <Cell label={renewal.label}>{renewal.value}</Cell>
          ) : null}
          {price && renewal?.kind !== "ending" ? (
            <Cell label="Next charge">{price}</Cell>
          ) : null}
          {sub?.card ? (
            <Cell
              label="Payment method"
              action={
                <button
                  type="button"
                  onClick={onChangeCard}
                  disabled={portal.kind === "opening"}
                  className="text-body-sm font-semibold text-cyan underline-offset-4 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  {portal.kind === "opening" ? "Opening…" : "Change card"}
                </button>
              }
            >
              {cardLine(sub.card)}
            </Cell>
          ) : null}
        </dl>
      ) : null}

      {portal.kind === "error" ? (
        <p className="border-t border-rule px-6 py-3 text-body-sm text-danger sm:px-8" role="alert">
          {portal.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-4 border-t border-rule p-6 sm:flex-row sm:items-center sm:p-8">
        <Link
          to="/account/billing"
          className="inline-flex min-h-12 shrink-0 items-center justify-center border border-rule-strong px-6 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Manage billing →
        </Link>
        <p className="text-body-sm text-fg-muted">
          Invoices, receipts, and cancellation.
        </p>
      </div>
    </div>
  );
}

function Cell({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-rule px-6 py-5 last:border-b-0 sm:border-b-0 sm:border-r sm:px-8 sm:last:border-r-0">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="label text-fg-muted">{label}</dt>
        {action}
      </div>
      <dd className="mt-2 text-body-sm text-fg-strong">{children}</dd>
    </div>
  );
}

// "Visa ending 4242 · exp 04/28". The brand comes off Stripe lowercase
// ('visa', 'amex'), and month is a plain number that has to be zero-padded to
// look like an expiry rather than a typo.
function cardLine(card: CardOnFile): string {
  const brand = card.brand
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const mm = String(card.expMonth).padStart(2, "0");
  const yy = String(card.expYear).slice(-2);
  return `${brand} ending ${card.last4} · exp ${mm}/${yy}`;
}

// What the date on this card actually means. A membership that's set to cancel
// is not "renewing", and a pending debundle lands on a date that is neither a
// renewal nor an ending — so the label follows the state.
function renewalCell(
  sub: MySubscription | null,
): { kind: "renews" | "ending" | "changing"; label: string; value: string } | null {
  if (!sub) return null;
  // Long form ("September 18, 2026") to match the per-axis access rows
  // directly below it — the same date in two formats on one screen reads as
  // two different dates.
  if (sub.cancelAtPeriodEnd) {
    const until =
      formatTimestamp(sub.cancelAt, "long") ||
      formatTimestamp(sub.periodEnd, "long");
    return until
      ? { kind: "ending", label: "Access until", value: until }
      : null;
  }
  const on = formatTimestamp(sub.periodEnd, "long");
  if (!on) return null;
  return sub.pendingChange
    ? { kind: "changing", label: "Changes on", value: on }
    : { kind: "renews", label: "Renews", value: on };
}

function StatusBadge({
  subscription,
  loading,
}: {
  subscription: MySubscription | null;
  loading: boolean;
}) {
  // No badge at all while we're still reading Stripe: "Active" that flips to
  // "Ending" a beat later is worse than a badge that arrives late.
  if (loading) return null;

  const { text, tone } = subscription?.cancelAtPeriodEnd
    ? { text: "Ending", tone: "border-danger/50 bg-danger/10 text-danger" }
    : subscription?.pendingChange
      ? { text: "Change scheduled", tone: "border-cyan/50 bg-cyan/10 text-cyan" }
      : { text: "Active", tone: "border-cyan/50 bg-cyan/10 text-cyan" };

  return (
    <span
      className={`inline-flex items-center border px-2 py-1 text-[11px] font-semibold uppercase tracking-button ${tone}`}
    >
      {text}
    </span>
  );
}
