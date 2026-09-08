import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  getMySubscription,
  reactivateSubscription,
} from "../../lib/auth";
import { isPaidMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { trackEvent } from "../../lib/analytics";
import { formatTimestamp } from "../../../shared/format-date";
import { CancelFlow } from "../../components/account/CancelFlow";

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
  // The tier-aware cancel/debundle flow lives in <CancelFlow>; this just opens it.
  const [flowOpen, setFlowOpen] = useState(false);

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
      if (s.cancelAtPeriodEnd) setScheduledCancelAt(s.cancelAt);
      setPendingChange(Boolean(s.pendingChange));
      setScheduledTier(s.scheduledTier ?? null);
      setPeriodEnd(s.periodEnd ?? null);
      setPlan(s.plan ?? null);
    });
    return () => {
      active = false;
    };
  }, [state]);

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
          <div className="max-w-xl border border-rule bg-navy-800/40 p-8">
            <h2 className="label text-cyan">Cancel</h2>
            <p className="mt-4 max-w-md text-body-sm text-fg">
              {scheduledCancelAt
                ? "Your membership is set to cancel and won't renew."
                : pendingChange
                  ? "Changed your mind? You can undo the scheduled change and keep your full membership, or cancel it entirely."
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
                {status.kept === "ark-plus" ? "Ark+" : "the Fold"} on its
                own. The change takes effect at the end of your current billing
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
                You'll keep access until {formatTimestamp(scheduledCancelAt, "long")}.
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
        </div>
      </section>

      {flowOpen ? (
        <CancelFlow
          tier={flowTier}
          plan={plan}
          onClose={() => setFlowOpen(false)}
          onSaved={() => {
            // The flow's own "Thanks for sticking around" screen shows the
            // confirmation, so we just close + resync here (no status banner).
            setFlowOpen(false);
            setScheduledCancelAt(null);
            // Accepting a save offer releases any pending schedule, so the
            // pending-change banner no longer applies.
            setPendingChange(false);
            setScheduledTier(null);
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
