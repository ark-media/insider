import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  acceptRetentionOffer,
  cancelSubscription,
  getMySubscription,
  getRetentionOffer,
  reactivateSubscription,
} from "../../lib/auth";
import { isPaidMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { Modal } from "../../components/Modal";
import { trackEvent } from "../../lib/analytics";
import { formatCouponDiscount } from "../../lib/currency";
import { CANCELLATION_REASONS } from "../../../shared/cancellation";
import type { RetentionOffer } from "../../../shared/retention";

// "25% off" / "$5 off", plus "for 3 months" when the coupon repeats.
function offerHeadline(o: {
  percentOff: number | null;
  amountOff: number | null;
  durationMonths: number | null;
}): string {
  const amount = formatCouponDiscount(o.percentOff, o.amountOff);
  const duration = o.durationMonths
    ? ` for ${o.durationMonths} month${o.durationMonths === 1 ? "" : "s"}`
    : "";
  return `${amount}${duration}`;
}

export const Route = createFileRoute("/account/billing")({
  component: BillingPage,
});

function BillingPage() {
  const navigate = useNavigate();
  const { state, authError, refresh } = useSubscriberAuth();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "cancelling" }
    | { kind: "applying" }
    | { kind: "reactivating" }
    | { kind: "ok"; until: string }
    | { kind: "saved"; headline: string; nextChargeAt: string }
    | { kind: "resumed"; nextChargeAt: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // The ISO date this membership is already scheduled to cancel, or null when
  // it renews normally. Loaded from Stripe on mount so the "set to cancel"
  // state survives a reload (the post-cancel `status` above is transient).
  const [scheduledCancelAt, setScheduledCancelAt] = useState<string | null>(
    null,
  );
  // A period-end tier/PWYC change is pending (task 14) — surfaced so the member
  // knows a scheduled change is in flight.
  const [pendingChange, setPendingChange] = useState(false);
  // The cancel flow is a stepper inside the existing Modal. Eligible members
  // start at Offer (Offer → Reason → Confirm); everyone else skips straight to
  // Reason → Confirm and never learns an offer existed. `offerShown` drives the
  // offer_outcome we record on cancel.
  const [flowOpen, setFlowOpen] = useState(false);
  const [step, setStep] = useState<"loading" | "offer" | "reason" | "confirm">(
    "loading",
  );
  const [offer, setOffer] = useState<RetentionOffer | null>(null);
  const [offerShown, setOfferShown] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // Inline error for a failed accept, shown on the Offer step so the member can
  // retry or decline without being dropped out of the flow.
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Each step renders its own heading under this id; only one is mounted at a
  // time, so a single ref tracks whichever is live.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The post-flow confirmation message (cancelled or saved). When the modal
  // closes it replaces the trigger button, so the Modal's focus-restore lands
  // on a detached node and falls to <body>; we move focus here instead.
  const confirmationRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // Skip the redirect when "guest" is just an unreachable /api/me.
    if (authError) return;
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
      return;
    }
    if (state.kind === "member" && !isPaidMember(state)) {
      void navigate({ to: "/plus" });
    }
  }, [state, authError, navigate]);

  // Load any pending cancel schedule once we know this is a paying member, so a
  // member who already cancelled lands on the "set to cancel" state rather than
  // the cancel button. Degrades silently to "no pending cancel" on failure.
  useEffect(() => {
    if (!isPaidMember(state)) return;
    let active = true;
    void getMySubscription().then((s) => {
      if (!active) return;
      if (s.cancelAtPeriodEnd) setScheduledCancelAt(s.cancelAt);
      setPendingChange(Boolean(s.pendingChange));
    });
    return () => {
      active = false;
    };
  }, [state]);

  // Move focus to the heading on every step change so keyboard and screen-
  // reader users land on (and hear) the new step instead of losing focus to
  // <body> when the previous step's controls unmount. The heading is
  // tabIndex={-1} so it takes programmatic focus without joining the tab order.
  useEffect(() => {
    if (!flowOpen) return;
    headingRef.current?.focus();
  }, [flowOpen, step]);

  // After the flow closes on success, move focus to the confirmation message
  // (a tabIndex={-1} target) so focus isn't stranded on <body> when the trigger
  // button it would otherwise restore to has been unmounted.
  useEffect(() => {
    if (
      status.kind === "ok" ||
      status.kind === "saved" ||
      status.kind === "resumed"
    ) {
      confirmationRef.current?.focus();
    }
  }, [status.kind]);

  if (authError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900 p-6">
        <div className="w-full max-w-md">
          <ContentError
            message="We couldn't load your billing details. Refresh to try again."
            onRetry={refresh}
          />
        </div>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest" || state.me.tier === "free") return null;

  const me = state.me;

  const openFlow = async () => {
    setReason(null);
    setNote("");
    setOffer(null);
    setOfferShown(false);
    setAcceptError(null);
    setStatus({ kind: "idle" });
    setStep("loading");
    setFlowOpen(true);
    trackEvent("cancel_initiated");
    // Check for a retention offer; a failure degrades to "no offer" so the
    // flow always proceeds to the reason step.
    const { eligible, offer: o } = await getRetentionOffer();
    if (eligible && o) {
      setOffer(o);
      setOfferShown(true);
      setStep("offer");
      trackEvent("retention_offer_shown", {
        kind: o.percentOff != null ? "percent" : "amount",
        percent_off: o.percentOff,
        amount_off_cents: o.amountOff,
        duration_months: o.durationMonths,
      });
    } else {
      setStep("reason");
    }
  };

  const onAccept = async () => {
    // Keep the modal open on the Offer step while applying so a failure can
    // surface inline; only close it once the discount is actually applied.
    setAcceptError(null);
    setStatus({ kind: "applying" });
    const r = await acceptRetentionOffer();
    if (r.ok) {
      trackEvent("retention_offer_accepted", {
        percent_off: r.percentOff ?? null,
        amount_off_cents: r.amountOff ?? null,
        duration_months: r.durationMonths ?? null,
      });
      setFlowOpen(false);
      setStatus({
        kind: "saved",
        headline: offerHeadline({
          percentOff: r.percentOff ?? null,
          amountOff: r.amountOff ?? null,
          durationMonths: r.durationMonths ?? null,
        }),
        nextChargeAt: r.next_charge_at ?? "",
      });
      // Pending cancel was cleared server-side; drop the scheduled state and
      // resync the page's auth state.
      setScheduledCancelAt(null);
      refresh();
    } else {
      // Stay on the Offer step; the member can retry or decline to Reason.
      setStatus({ kind: "idle" });
      setAcceptError(
        r.error ?? "Could not apply your discount — please try again.",
      );
    }
  };

  const onCancel = async () => {
    if (!reason) return; // guarded by the disabled Continue button, belt-and-braces
    setFlowOpen(false);
    setStatus({ kind: "cancelling" });
    const r = await cancelSubscription({
      reason,
      note: note.trim() || undefined,
      offerOutcome: offerShown ? "declined" : "not_offered",
    });
    if (r.ok) {
      trackEvent("subscription_cancelled", {
        reason,
        offer_outcome: offerShown ? "declined" : "not_offered",
      });
      setStatus({ kind: "ok", until: r.access_until ?? "" });
      // Persist the schedule so the "set to cancel" state holds on reload.
      setScheduledCancelAt(r.access_until ?? null);
    } else {
      setStatus({
        kind: "error",
        message: r.error ?? "Could not cancel — please try again.",
      });
    }
  };

  const onReactivate = async () => {
    setStatus({ kind: "reactivating" });
    const r = await reactivateSubscription();
    if (r.ok) {
      trackEvent("subscription_reactivated");
      // Cancel was undone server-side; clear the scheduled state and resync the
      // page's auth state.
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

  return (
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Account", to: "/account" },
            { label: "Billing" },
          ]}
        />
      }
      title="Your membership."
      lede={`Signed in as ${me.email}.`}
    >
      <section>
        <div className="page-section">
          {pendingChange ? (
            <p
              className="mb-6 border border-cyan/50 bg-cyan/10 px-4 py-3 text-body-sm text-fg-strong"
              aria-live="polite"
            >
              A plan change is scheduled and will take effect at the end of your
              current billing period.
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">
                Manage payment & invoices
              </h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                Update your card, change your billing email, or download
                invoices in the Stripe Customer Portal.
              </p>
              <button
                type="button"
                disabled
                className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-muted opacity-60"
              >
                Open Stripe portal →
              </button>
              <p className="mt-3 text-body-sm">
                Stripe portal redirect not yet wired in this preview build.
              </p>
            </div>

            <div className="border border-rule bg-navy-800/40 p-8">
              <h2 className="label text-cyan">
                Cancel
              </h2>
              {/* Tracks the schedule, not the transient status — right after
                  cancelling this already reads "set to cancel", consistent
                  with the confirmation below it. */}
              <p className="mt-4 max-w-md text-body-sm text-fg">
                {scheduledCancelAt
                  ? "Your membership is set to cancel and won't renew."
                  : "Cancel anytime. You'll keep access through the end of your current billing period."}
              </p>
              {/* Lead line: the focus-managed, aria-live confirmation right
                  after an action, otherwise the persistent "keep access until"
                  note while a cancel stays scheduled. */}
              {status.kind === "ok" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  Cancellation confirmed.{" "}
                  {status.until
                    ? `Access continues until ${new Date(status.until).toLocaleDateString()}.`
                    : ""}
                </p>
              ) : status.kind === "saved" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  You're all set — your membership continues with {status.headline}.
                  {status.nextChargeAt
                    ? ` Next charge on ${new Date(status.nextChargeAt).toLocaleDateString()}.`
                    : ""}
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
                    ? `It renews on ${new Date(status.nextChargeAt).toLocaleDateString()}.`
                    : ""}
                </p>
              ) : scheduledCancelAt ? (
                <p className="mt-6 text-body-sm text-cyan" aria-live="polite">
                  You'll keep access until{" "}
                  {new Date(scheduledCancelAt).toLocaleDateString()}.
                </p>
              ) : null}

              {/* Action: Reactivate whenever a cancel is scheduled — so undo is
                  reachable the instant after cancelling, not only after a
                  reload (the schedule outlives the transient "ok" status). The
                  Cancel entry point shows when nothing's scheduled, and nothing
                  during the just-saved / just-resumed confirmations. */}
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
              ) : status.kind === "saved" || status.kind === "resumed" ? null : (
                <button
                  type="button"
                  onClick={openFlow}
                  disabled={status.kind === "cancelling" || status.kind === "applying"}
                  className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
                >
                  {status.kind === "cancelling"
                    ? "Cancelling…"
                    : status.kind === "applying"
                      ? "Applying…"
                      : "Cancel my membership"}
                </button>
              )}
              {status.kind === "error" ? (
                <p
                  className="mt-3 text-body-sm text-danger"
                  aria-live="polite"
                >
                  {status.message}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <Modal
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        className="max-w-md"
        labelledBy="cancel-title"
      >
        {step === "loading" ? (
          <div role="status" aria-live="polite">
            <p className="eyebrow">One moment</p>
            <h2
              ref={headingRef}
              tabIndex={-1}
              id="cancel-title"
              className="display-upright mt-3 text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong focus:outline-none"
            >
              Loading…
            </h2>
          </div>
        ) : step === "offer" && offer ? (
          <>
            <h2
              ref={headingRef}
              tabIndex={-1}
              id="cancel-title"
              className="display-upright text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong focus:outline-none"
            >
              Wait — here's {offerHeadline(offer)}
            </h2>
            <p className="mt-4 text-body-sm text-fg">
              Before you go: stay with Ark+ and we'll apply {offerHeadline(offer)}{" "}
              to your membership. Same access, lower price.
            </p>
            {acceptError ? (
              <p className="mt-4 text-body-sm text-danger" aria-live="polite">
                {acceptError}
              </p>
            ) : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={onAccept}
                disabled={status.kind === "applying"}
                aria-busy={status.kind === "applying"}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-cyan bg-cyan/10 px-4 text-sm font-semibold uppercase tracking-button text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
              >
                {status.kind === "applying" ? "Applying…" : "Keep my discount"}
              </button>
              <button
                type="button"
                onClick={() => {
                  trackEvent("retention_offer_declined");
                  setStep("reason");
                }}
                disabled={status.kind === "applying"}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
              >
                No thanks
              </button>
            </div>
          </>
        ) : step === "reason" ? (
          <>
            <h2
              ref={headingRef}
              tabIndex={-1}
              id="cancel-title"
              className="display-upright text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong focus:outline-none"
            >
              We're sorry to see you go
            </h2>
            <p className="mt-4 text-body-sm text-fg">
              Help us improve by letting us know why you're cancelling:
            </p>
            <fieldset className="mt-6">
              <legend className="sr-only">Reason for cancelling</legend>
              <div className="flex flex-col gap-3">
                {CANCELLATION_REASONS.map((r) => (
                  <label
                    key={r.slug}
                    className="flex cursor-pointer items-start gap-3 text-body-sm text-fg"
                  >
                    <input
                      type="radio"
                      name="cancel-reason"
                      value={r.slug}
                      checked={reason === r.slug}
                      onChange={() => setReason(r.slug)}
                      className="mt-1 h-4 w-4 shrink-0 accent-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                    />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label
              htmlFor="cancel-note"
              className="mt-6 block text-body-sm text-fg-muted"
            >
              Anything else? (optional)
            </label>
            <textarea
              id="cancel-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              className="mt-2 w-full resize-y border border-rule-strong bg-navy-900 px-3 py-2 text-body-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            />
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  // reason is non-null here (button is disabled otherwise).
                  if (reason) trackEvent("cancellation_reason_submitted", { reason });
                  setStep("confirm");
                }}
                disabled={!reason}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-50 disabled:hover:border-rule-strong disabled:hover:text-fg-strong"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={() => setFlowOpen(false)}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Never mind
              </button>
            </div>
          </>
        ) : (
          <>
            <h2
              ref={headingRef}
              tabIndex={-1}
              id="cancel-title"
              className="display-upright text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong focus:outline-none"
            >
              Cancel your Ark+ membership?
            </h2>
            <p className="mt-4 text-body-sm text-fg">
              You'll keep access until the end of your current billing period.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-danger px-4 text-sm font-semibold uppercase tracking-button text-danger transition hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Cancel membership
              </button>
              <button
                type="button"
                onClick={() => setStep("reason")}
                className="inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Back
              </button>
            </div>
          </>
        )}
      </Modal>
    </PageShell>
  );
}
