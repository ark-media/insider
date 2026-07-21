import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  getMySubscription,
  reactivateSubscription,
} from "../../lib/auth";
import { isPaidMember, useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { trackEvent } from "../../lib/analytics";
import { CancelFlow } from "./CancelFlow";

export const Route = createFileRoute("/account/billing")({
  component: BillingPage,
});

function BillingPage() {
  const navigate = useNavigate();
  const { state, authError, refresh } = useSubscriberAuth();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "reactivating" }
    | { kind: "ok"; until: string }
    | { kind: "saved"; headline: string; nextChargeAt: string }
    | { kind: "debundled"; kept: "ark-plus" | "circle" }
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
  // knows a scheduled change is in flight. Debundles land here too.
  const [pendingChange, setPendingChange] = useState(false);
  // The member's billing cadence, passed to the cancel flow so it can branch
  // copy by monthly vs annual (Flows A/D). Null until loaded.
  const [plan, setPlan] = useState<"monthly" | "yearly" | null>(null);
  // The tier-aware cancel/debundle flow lives in <CancelFlow>; this just opens it.
  const [flowOpen, setFlowOpen] = useState(false);

  // The post-flow confirmation message (cancelled / saved / debundled). When the
  // flow closes it replaces the trigger button, so focus is moved here.
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

  // Load the pending cancel schedule + cadence once we know this is a paying
  // member. Degrades silently to "no pending cancel" on failure.
  useEffect(() => {
    if (!isPaidMember(state)) return;
    let active = true;
    void getMySubscription().then((s) => {
      if (!active) return;
      if (s.cancelAtPeriodEnd) setScheduledCancelAt(s.cancelAt);
      setPendingChange(Boolean(s.pendingChange));
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
      status.kind === "saved" ||
      status.kind === "debundled" ||
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
  const cancelTier = me.tier as "ark-plus" | "circle" | "bundle";

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
              <h2 className="label text-cyan">Manage payment & invoices</h2>
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
              <h2 className="label text-cyan">Cancel</h2>
              <p className="mt-4 max-w-md text-body-sm text-fg">
                {scheduledCancelAt
                  ? "Your membership is set to cancel and won't renew."
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
              ) : status.kind === "debundled" ? (
                <p
                  ref={confirmationRef}
                  tabIndex={-1}
                  className="mt-6 text-body-sm text-cyan focus:outline-none"
                  aria-live="polite"
                >
                  Done — you'll keep{" "}
                  {status.kept === "ark-plus" ? "Ark+" : "the Community"} on its
                  own. The change takes effect at the end of your current billing
                  period.
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
              ) : status.kind === "saved" ||
                status.kind === "resumed" ||
                status.kind === "debundled" ? null : (
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
                      ? "Cancel Community"
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
        </div>
      </section>

      {flowOpen ? (
        <CancelFlow
          tier={cancelTier}
          plan={plan}
          onClose={() => setFlowOpen(false)}
          onSaved={(headline, nextChargeAt) => {
            setFlowOpen(false);
            setScheduledCancelAt(null);
            setStatus({ kind: "saved", headline, nextChargeAt });
            refresh();
          }}
          onCancelled={(accessUntil) => {
            setFlowOpen(false);
            setScheduledCancelAt(accessUntil || null);
            setStatus({ kind: "ok", until: accessUntil });
          }}
          onDebundled={(retained) => {
            setFlowOpen(false);
            setPendingChange(true);
            setStatus({
              kind: "debundled",
              kept: retained === "kept-ark-plus" ? "ark-plus" : "circle",
            });
            refresh();
          }}
        />
      ) : null}
    </PageShell>
  );
}
