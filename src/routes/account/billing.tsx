import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  getChangePreview,
  getMySubscription,
  reactivateSubscription,
  type CardOnFile,
  type ChangePreview,
} from "../../lib/auth";
import { isPaidMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { trackEvent } from "../../lib/analytics";
import { formatTimestamp } from "../../../shared/format-date";
import { CancelFlow } from "../../components/account/CancelFlow";
import { PaymentMethodPanel } from "../../components/account/PaymentMethodPanel";
import { PlanChangePanel } from "../../components/account/PlanChangePanel";
import { formatMinor } from "../../lib/currency";
import { perPeriod } from "../../../shared/billing-copy";
import { giftEndsAt } from "../../lib/gift";

export const Route = createFileRoute("/account/billing")({
  component: BillingPage,
});

function BillingPage() {
  const navigate = useNavigate();
  const { state, refresh } = useSubscriberAuth();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "reactivating" }
    | { kind: "ok"; until: string }
    | { kind: "debundled"; kept: "ark-plus" | "circle" }
    | { kind: "resumed"; nextChargeAt: string }
    | { kind: "reverted"; nextChargeAt: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // The ISO date this membership is already scheduled to cancel, or null when
  // it renews normally. Loaded from Stripe on mount so the "set to cancel"
  // state survives a reload (the post-cancel `status` above is transient).
  const [scheduledCancelAt, setScheduledCancelAt] = useState<string | null>(
    null,
  );
  // A period-end tier/PWYC change is pending (task 14) — surfaced so the member
  // knows a scheduled change is in flight. Debundles land here too.
  const [pendingChange, setPendingChange] = useState(false);
  // The tier a pending period-end change lands on (e.g. a debundle's ark-plus),
  // so the banner can name the change instead of "a plan change is scheduled".
  const [scheduledTier, setScheduledTier] = useState<
    "ark-plus" | "circle" | "bundle" | "free" | null
  >(null);
  // The current period end (ISO) — the concrete date a pending change/debundle
  // takes effect and through which access continues. Null until loaded / no sub.
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  // The member's billing cadence, passed to the cancel flow so it can branch
  // copy by monthly vs annual (Flows A/D). Null until loaded.
  const [plan, setPlan] = useState<"monthly" | "yearly" | null>(null);
  // The cadence a pending change lands on, for a cancel flow opened on that
  // change's tier (flowPlan below). Null when nothing is scheduled.
  const [scheduledPlan, setScheduledPlan] = useState<"monthly" | "yearly" | null>(null);
  // The card the membership bills to, for the payment-method panel.
  const [card, setCard] = useState<CardOnFile | null>(null);
  // Whether there's a subscription to put a card against. Undefined until the
  // read settles; false for a gifted membership, which has no subscription and
  // so no panel. A failed read (null from getMySubscription) counts as true:
  // the card routes answer for themselves, and hiding the only way to fix a
  // card because Stripe hiccuped once is the worse failure.
  const [billsToCard, setBillsToCard] = useState<boolean | undefined>(
    undefined,
  );
  // When a gift redeemed onto the subscription stops holding its billing off
  // (ISO), or null. Until then that date, not the period end, is when the next
  // charge lands and when a cancel takes effect.
  const [giftExtendedUntil, setGiftExtendedUntil] = useState<string | null>(
    null,
  );
  // The tier-aware cancel/debundle flow lives in <CancelFlow>; this just opens it.
  const [flowOpen, setFlowOpen] = useState(false);
  // What they pay now, for the plan section's summary line.
  const [price, setPrice] = useState<{
    amountCents: number;
    currency: string;
    minorFactor: number;
  } | null>(null);
  // Whether "Change what I pay" is offered (members who chose above the
  // minimum at checkout).
  const [canChangeAmount, setCanChangeAmount] = useState(false);
  // The plan section's switch / amount change, from opening to done.
  const [planPanel, setPlanPanel] = useState<
    | { kind: "idle" }
    | { kind: "loading"; which: "cadence" | "amount" }
    | { kind: "open"; heading: string; preview: ChangePreview }
    | { kind: "error"; message: string }
    | { kind: "done"; message: string }
  >({ kind: "idle" });
  // Bumped after a plan change so the subscription is read again.
  const [reloadKey, setReloadKey] = useState(0);

  // The post-flow confirmation message (cancelled / saved / debundled). When the
  // flow closes it replaces the trigger button, so focus is moved here.
  const confirmationRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // The /account layout already handles the signed-out case; the only extra
    // rule here is that a free reader has no billing to manage.
    if (state.kind === "member" && !isPaidMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  // Load the pending cancel schedule + cadence once we know this is a paying
  // member. Degrades silently to "no pending cancel" on failure.
  useEffect(() => {
    if (!isPaidMember(state)) return;
    let active = true;
    void getMySubscription().then((s) => {
      if (!active) return;
      // null = read failed; leave the state alone (see billsToCard).
      if (!s) {
        setBillsToCard(true);
        return;
      }
      if (s.cancelAtPeriodEnd) setScheduledCancelAt(s.cancelAt);
      setPendingChange(Boolean(s.pendingChange));
      setScheduledTier(s.scheduledTier ?? null);
      setPeriodEnd(s.periodEnd ?? null);
      setPlan(s.plan ?? null);
      setScheduledPlan(s.scheduledPlan ?? null);
      setCard(s.card ?? null);
      setPrice(
        typeof s.amountCents === "number" && s.currency
          ? { amountCents: s.amountCents, currency: s.currency, minorFactor: s.minorFactor ?? 100 }
          : null,
      );
      setCanChangeAmount(Boolean(s.canChangeAmount));
      setGiftExtendedUntil(s.giftExtendedUntil ?? null);
      // Every live subscription has a current period; no subscription reports
      // none. That's the one field here that tells the two apart.
      setBillsToCard(Boolean(s.periodEnd));
    });
    return () => {
      active = false;
    };
  }, [state, reloadKey]);

  // After the flow closes on success, move focus to the confirmation message so
  // focus isn't stranded on <body> when the trigger button it would restore to
  // has been unmounted.
  useEffect(() => {
    if (
      status.kind === "ok" ||
      status.kind === "debundled" ||
      status.kind === "resumed" ||
      status.kind === "reverted"
    ) {
      confirmationRef.current?.focus();
    }
  }, [status.kind]);

  if (state.kind !== "member" || state.me.tier === "free") return null;

  const me = state.me;
  const cancelTier = me.tier as "ark-plus" | "circle" | "bundle";
  // The billing-period-end date, localized, or null when we don't have it — used
  // to turn "the end of your current billing period" into a concrete date.
  // Long form throughout the account section — the plan card one click away
  // states the same date that way, and two formats read as two dates.
  const periodEndLabel = formatTimestamp(periodEnd, "long") || null;
  const giftUntilLabel = formatTimestamp(giftExtendedUntil, "long") || null;
  // A gifted membership with no subscription behind it: nothing to bill or
  // cancel, so the page says so instead of offering either.
  const giftOnly = billsToCard === false;
  const giftEndsLabel = formatTimestamp(giftEndsAt(me), "long") || null;

  // A human noun phrase for a tier, so the pending-change banner can name the
  // change ("from the Ark+ & The Fold bundle to Ark+").
  const tierLabel = (t: "ark-plus" | "circle" | "bundle" | "free") =>
    t === "bundle"
      ? "the Ark+ & The Fold bundle"
      : t === "ark-plus"
        ? "Ark+"
        : t === "circle"
          ? "the Fold"
          : "the free plan";

  // The tier the cancel flow should operate on. Normally the current tier, but
  // when a debundle is already scheduled the bundle is effectively becoming a
  // single product — so cancelling should target that remaining piece
  // (scheduledTier), not re-offer the bundle decision tree.
  const flowTier: "ark-plus" | "circle" | "bundle" =
    pendingChange && (scheduledTier === "ark-plus" || scheduledTier === "circle")
      ? scheduledTier
      : cancelTier;
  // And its cadence: a bundle-yearly member with Ark+ monthly booked is
  // cancelling Ark+ monthly, which is what the server derives offers for.
  const flowPlan =
    flowTier !== cancelTier && scheduledPlan ? scheduledPlan : plan;

  // Open the plan section's confirm step: read what the change would cost
  // first, so the panel states it before anything is billed.
  const openPlanChange = async (which: "cadence" | "amount") => {
    if (!plan) return;
    setPlanPanel({ kind: "loading", which });
    const target = which === "amount" ? plan : plan === "monthly" ? "yearly" : "monthly";
    const r = await getChangePreview({ tier: cancelTier, plan: target });
    if (r.kind === "preview") {
      setPlanPanel({
        kind: "open",
        heading:
          which === "amount"
            ? "Change what you pay"
            : target === "yearly"
              ? "Switch to annual billing"
              : "Switch to monthly billing",
        preview: r.preview,
      });
    } else {
      setPlanPanel({
        kind: "error",
        message:
          r.kind === "error" && r.message
            ? r.message
            : "We couldn't read what this change would cost. Nothing has been charged.",
      });
    }
  };

  // Offered on a membership that renews normally: a booked cancel or a
  // scheduled change has its own actions below, and a gift has no bill.
  const showPlan = Boolean(billsToCard && plan && !scheduledCancelAt && !pendingChange);

  const onReactivate = async () => {
    setStatus({ kind: "reactivating" });
    const r = await reactivateSubscription();
    if (r.ok) {
      trackEvent("subscription_reactivated");
      setScheduledCancelAt(null);
      setStatus({ kind: "resumed", nextChargeAt: r.next_charge_at ?? "" });
      refresh();
    } else {
      setStatus({
        kind: "error",
        message: r.error ?? "Could not reactivate — please try again.",
      });
    }
  };

  // Undo a scheduled period-end change (e.g. a debundle's bundle → Ark+) so the
  // membership continues unchanged. Same endpoint as reactivate — it releases the
  // pending schedule and clears any pending cancel.
  const onUndoChange = async () => {
    setStatus({ kind: "reactivating" });
    const r = await reactivateSubscription();
    if (r.ok) {
      trackEvent("subscription_reactivated");
      setPendingChange(false);
      setScheduledTier(null);
      setStatus({ kind: "reverted", nextChargeAt: r.next_charge_at ?? "" });
      refresh();
    } else {
      setStatus({
        kind: "error",
        message: r.error ?? "Could not undo the change — please try again.",
      });
    }
  };

  return (
    <>
      <section>
        <div className="page-section">
          <Link
            to="/account"
            className="group mb-8 inline-flex items-center gap-2 text-body-sm text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span aria-hidden="true">←</span> Membership
          </Link>
          <h2 className="mb-8 text-h2">Billing</h2>
          {pendingChange ? (
            <p
              className="mb-6 border border-cyan/50 bg-cyan/10 px-4 py-3 text-body-sm text-fg-strong"
              aria-live="polite"
            >
              {scheduledTier && scheduledTier !== me.tier
                ? `Your membership will change from ${tierLabel(cancelTier)} to ${tierLabel(scheduledTier)}${
                    periodEndLabel
                      ? ` on ${periodEndLabel}`
                      : " at the end of your current billing period"
                  }. You'll keep full access until then.`
                : `A plan change is scheduled and will take effect at the end of your current billing period${
                    periodEndLabel ? `, on ${periodEndLabel}` : ""
                  }.`}
            </p>
          ) : null}
          {billsToCard ? (
            <div className="mb-6">
              <PaymentMethodPanel
                card={card}
                // A membership that's set to end has no next charge to name.
                nextChargeLabel={
                  scheduledCancelAt ? null : (giftUntilLabel ?? periodEndLabel)
                }
                onCardChanged={setCard}
              />
            </div>
          ) : null}
          {showPlan || planPanel.kind === "done" ? (
            <div className="mb-6 max-w-xl border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">Your plan</h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                {price && plan
                  ? `You pay ${formatMinor(price.amountCents, price.currency, price.minorFactor)} ${perPeriod(plan)}.`
                  : plan === "yearly"
                    ? "You're billed once a year."
                    : "You're billed every month."}
              </p>
              {planPanel.kind === "open" ? (
                <div className="mt-6">
                  <PlanChangePanel
                    heading={planPanel.heading}
                    initial={planPanel.preview}
                    onDone={(message) => {
                      setPlanPanel({ kind: "done", message });
                      setReloadKey((k) => k + 1);
                      refresh();
                    }}
                    onCancel={() => setPlanPanel({ kind: "idle" })}
                  />
                </div>
              ) : planPanel.kind === "done" ? (
                <p className="mt-6 text-body-sm text-cyan" aria-live="polite">
                  {planPanel.message}
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void openPlanChange("cadence")}
                    disabled={planPanel.kind === "loading"}
                    className="inline-flex items-center justify-center gap-2 border border-cyan bg-cyan/10 px-5 py-3 button-text font-display font-bold text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                  >
                    {planPanel.kind === "loading" && planPanel.which === "cadence"
                      ? "Checking…"
                      : plan === "monthly"
                        ? "Switch to annual billing"
                        : "Switch to monthly billing"}
                  </button>
                  {canChangeAmount ? (
                    <button
                      type="button"
                      onClick={() => void openPlanChange("amount")}
                      disabled={planPanel.kind === "loading"}
                      className="inline-flex items-center justify-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                    >
                      {planPanel.kind === "loading" && planPanel.which === "amount"
                        ? "Checking…"
                        : "Change what I pay"}
                    </button>
                  ) : null}
                </div>
              )}
              {planPanel.kind === "error" ? (
                <p className="mt-3 text-body-sm text-danger" role="alert">
                  {planPanel.message}
                </p>
              ) : null}
            </div>
          ) : null}
          {giftOnly ? (
            <div className="max-w-xl border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">Gift membership</h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                {giftEndsLabel
                  ? `Your membership is a gift, so there's nothing to pay or cancel. It ends on ${giftEndsLabel} and won't renew.`
                  : "Your membership is a gift, so there's nothing to pay or cancel. It won't renew."}
              </p>
            </div>
          ) : (
            <div className="max-w-xl border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">Cancel</h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                {scheduledCancelAt
                  ? "Your membership is set to cancel and won't renew."
                  : pendingChange
                    ? "Changed your mind? You can undo the scheduled change and keep your full membership, or cancel it entirely."
                    : giftUntilLabel
                      ? `Cancel anytime. You'll keep access until ${giftUntilLabel}, when your gift ends, and won't be charged again.`
                      : periodEndLabel
                        ? `Cancel anytime. You'll keep access through the end of your current billing period, on ${periodEndLabel}.`
                        : "Cancel anytime. You'll keep access through the end of your current billing period."}
              </p>

              {status.kind === "ok" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  Cancellation confirmed.{" "}
                  {status.until
                    ? `Access continues until ${formatTimestamp(status.until, "long")}.`
                    : ""}
                </p>
              ) : status.kind === "debundled" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  Done — you'll keep{" "}
                  {status.kept === "ark-plus" ? "Ark+" : "the Fold"} on its own.
                  The change takes effect at the end of your current billing
                  period{periodEndLabel ? `, on ${periodEndLabel}` : ""}.
                </p>
              ) : status.kind === "resumed" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  Your membership is back on.{" "}
                  {status.nextChargeAt
                    ? `It renews on ${formatTimestamp(status.nextChargeAt, "long")}.`
                    : ""}
                </p>
              ) : status.kind === "reverted" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  The scheduled change was cancelled — your membership continues
                  unchanged.{" "}
                  {status.nextChargeAt
                    ? `It renews on ${formatTimestamp(status.nextChargeAt, "long")}.`
                    : ""}
                </p>
              ) : scheduledCancelAt ? (
                <p className="mt-6 text-body-sm text-cyan" aria-live="polite">
                  You'll keep access until{" "}
                  {formatTimestamp(scheduledCancelAt, "long")}.
                </p>
              ) : null}

              {/* Actions reflect the current membership state, not the last
                action: a pending cancel → reactivate; a pending change →
                undo/cancel; otherwise the normal cancel-or-change entry. The
                confirmation message above is what changes per action, so the
                member is never left without a next step (e.g. after accepting
                a save offer or undoing a change). */}
              {scheduledCancelAt ? (
                <button
                  type="button"
                  onClick={onReactivate}
                  disabled={status.kind === "reactivating"}
                  className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan/10 px-5 py-3 button-text font-display font-bold text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  {status.kind === "reactivating"
                    ? "Reactivating…"
                    : "Reactivate membership"}
                </button>
              ) : pendingChange ? (
                // A period-end change is scheduled (e.g. a debundle): the two
                // useful actions are undoing it (keep the full membership) or
                // cancelling outright — not the generic change tree.
                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={onUndoChange}
                    disabled={status.kind === "reactivating"}
                    className="inline-flex items-center justify-center gap-2 border border-cyan bg-cyan/10 px-5 py-3 button-text font-display font-bold text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                  >
                    {status.kind === "reactivating"
                      ? "Undoing…"
                      : `Keep ${tierLabel(cancelTier)}`}
                  </button>
                  <button
                    type="button"
                    disabled={status.kind === "reactivating"}
                    onClick={() => {
                      setStatus({ kind: "idle" });
                      setFlowOpen(true);
                    }}
                    className="inline-flex items-center justify-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                  >
                    Cancel my membership
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setStatus({ kind: "idle" });
                    setFlowOpen(true);
                  }}
                  className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  {cancelTier === "bundle"
                    ? "Cancel or change my membership"
                    : cancelTier === "circle"
                      ? "Cancel the Fold"
                      : "Cancel Ark+"}
                </button>
              )}
              {status.kind === "error" ? (
                <p className="mt-3 text-body-sm text-danger" aria-live="polite">
                  {status.message}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {flowOpen ? (
        <CancelFlow
          tier={flowTier}
          plan={flowPlan}
          onClose={() => setFlowOpen(false)}
          onSaved={() => {
            // The flow's own "Thanks for sticking around" screen shows the
            // confirmation, so we just close + resync here (no status banner).
            setFlowOpen(false);
            setScheduledCancelAt(null);
            // Whether a change is still pending depends on the offer: a coupon
            // on a booked debundle keeps it, a plan switch books one. The
            // refresh re-reads my-subscription (the effect above), so the
            // banner follows the server rather than a guess made here.
            refresh();
          }}
          onCancelled={(accessUntil) => {
            setFlowOpen(false);
            setScheduledCancelAt(accessUntil || null);
            // A full cancel supersedes (and releases) any pending debundle
            // schedule, so clear the pending-change banner.
            setPendingChange(false);
            setScheduledTier(null);
            setStatus({ kind: "ok", until: accessUntil });
          }}
          onDebundled={(retained) => {
            setFlowOpen(false);
            setPendingChange(true);
            // The kept product is the tier the membership lands on at period end,
            // so the banner names the change and a later cancel targets it —
            // without waiting for the getMySubscription reload.
            setScheduledTier(retained === "kept-ark-plus" ? "ark-plus" : "circle");
            setStatus({
              kind: "debundled",
              kept: retained === "kept-ark-plus" ? "ark-plus" : "circle",
            });
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
