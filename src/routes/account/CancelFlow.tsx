import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { MissionReminder } from "./MissionReminder";
import { trackEvent } from "../../lib/analytics";
import { formatCouponDiscount, formatMinor } from "../../lib/currency";
import { CANCELLATION_REASONS } from "../../../shared/cancellation";
import {
  acceptSaveOffer,
  cancelSubscription,
  changeTier,
  getSaveOffers,
  type StandalonePrice,
} from "../../lib/auth";
import type {
  OfferKind,
  RetentionOffer,
  SaveIntent,
} from "../../../shared/retention";

type Tier = "ark-plus" | "circle" | "bundle";
type Plan = "monthly" | "yearly";
type FlowId = "A" | "B" | "C" | "D" | "E";

// The tier this flow's terminal action leaves the member on, for the win-back
// record + analytics. Debundles keep one product; full cancels keep none.
type Retained = "kept-ark-plus" | "kept-circle";

// USD-cents helper: the catalog is priced in USD, so save-offer + standalone
// amounts are USD minor units (2-decimal).
const usd = (cents: number) => formatMinor(cents, "usd", 100);

// A human headline for a coupon-backed offer, e.g. "$6/mo for 12 months".
function couponHeadline(o: RetentionOffer): string {
  const amount = formatCouponDiscount(o.percentOff, o.amountOff);
  if (o.durationMonths) {
    return `${amount} for ${o.durationMonths} month${o.durationMonths === 1 ? "" : "s"}`;
  }
  if (o.forever) return `${amount}, for as long as you stay`;
  return amount;
}

// Copy for each offer kind's headline + supporting line. Amounts come from the
// resolved offer (Stripe), never hardcoded.
function offerCopy(o: RetentionOffer): { heading: string; body: string } {
  switch (o.kind) {
    case "annual_switch": {
      const monthly = o.currentPriceCents ?? 0;
      const yearly = o.targetPriceCents ?? 0;
      const savings = monthly * 12 - yearly;
      return {
        heading: "Switch to annual and save.",
        body:
          savings > 0
            ? `Pay ${usd(yearly)} a year instead of ${usd(monthly)} a month — that's ${usd(savings)} less over a year, same full access.`
            : `Move to the annual plan at ${usd(yearly)} a year for the same full access.`,
      };
    }
    case "monthly_switch": {
      const monthly = o.targetPriceCents ?? 0;
      return {
        heading: "Prefer to pay monthly?",
        body: `Switch to monthly billing and keep your annual rate of about ${usd(monthly)} a month — the flexibility of monthly, none of the extra cost.`,
      };
    }
    case "supporter_coupon":
      return {
        heading: `Stay for ${couponHeadline(o)}.`,
        body: "Keep everything you have now at a supporter rate — our thank-you for continuing to fund independent Jewish media.",
      };
    case "affordability_coupon":
      return {
        heading: `Make it easier to stay: ${couponHeadline(o)}.`,
        body: "We'd love to keep you in the community. Here's a lower rate so cost isn't what decides it.",
      };
    case "circle_free_months":
      return {
        heading: `${couponHeadline(o)} of the Community, on us.`,
        body: "Before you drop the Community, take a few months free — stay connected and decide later.",
      };
    case "perpetual_discount":
      return {
        heading: `Keep your rate: ${couponHeadline(o)}.`,
        body: "Continue at your current rate for as long as you stay a member.",
      };
  }
}

// Whether accepting an offer is a plan switch (change-tier) or a coupon attach.
function isSwitch(kind: OfferKind): boolean {
  return kind === "annual_switch" || kind === "monthly_switch";
}

type Screen =
  | "loading"
  | "entry"
  | "mission"
  | "bundle-value"
  | "keep-one"
  | "offer"
  | "reason"
  | "confirm";

// The terminal action a flow ends in.
type Terminal =
  | { kind: "cancel" }
  | { kind: "debundle"; to: "ark-plus" | "circle"; retained: Retained };

export type CancelFlowProps = {
  tier: Tier;
  plan: Plan | null;
  onClose: () => void;
  // Offer accepted → membership continues (coupon or plan switch).
  onSaved: (headline: string, nextChargeAt: string) => void;
  // Full cancel scheduled at period end.
  onCancelled: (accessUntil: string) => void;
  // Debundled → kept one product; the account state should refresh.
  onDebundled: (retained: Retained) => void;
};

export function CancelFlow({
  tier,
  plan,
  onClose,
  onSaved,
  onCancelled,
  onDebundled,
}: CancelFlowProps) {
  // ark-plus → Flow A, circle → Flow B (both open on the mission); bundle → the
  // entry choice. Derived once from the (stable) tier prop.
  const [flowId, setFlowId] = useState<FlowId | null>(() =>
    tier === "ark-plus" ? "A" : tier === "circle" ? "B" : null,
  );
  const [screen, setScreen] = useState<Screen>(() =>
    tier === "bundle" ? "entry" : "mission",
  );
  const [offers, setOffers] = useState<RetentionOffer[]>([]);
  const [offerIndex, setOfferIndex] = useState(0);
  const [offerShownAny, setOfferShownAny] = useState(false);
  const [standalone, setStandalone] = useState<StandalonePrice | null>(null);
  // Flow E keep-just-one standalone prices for each single product.
  const [keepOne, setKeepOne] = useState<{
    arkPlus: StandalonePrice | null;
    circle: StandalonePrice | null;
  }>({ arkPlus: null, circle: null });
  const [terminal, setTerminal] = useState<Terminal>({ kind: "cancel" });
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);

  // Fire the flow-entry analytics once. A/B are known from the tier at mount;
  // the bundle flows fire cancel_initiated per choice (see `flow`).
  useEffect(() => {
    if (tier === "ark-plus") trackEvent("cancel_initiated", { flow: "A", tier });
    else if (tier === "circle") trackEvent("cancel_initiated", { flow: "B", tier });
  }, [tier]);

  // Move focus to the live heading on each screen change (a11y): one heading is
  // mounted at a time, tabIndex={-1} so it takes focus without joining tab order.
  useEffect(() => {
    headingRef.current?.focus();
  }, [screen]);

  const flow = (id: FlowId) => {
    setFlowId(id);
    trackEvent("cancel_initiated", { flow: id, tier });
  };

  // The save-offers intent for the active flow.
  const intentFor = (id: FlowId): SaveIntent | null => {
    switch (id) {
      case "A":
        return "cancel-ark-plus";
      case "B":
        return "cancel-circle";
      case "C":
        return "debundle-remove-ark-plus";
      case "D":
        return "debundle-remove-circle";
      case "E":
        return null;
    }
  };

  // Load the ordered save offers for a flow and enter the offer step (or skip to
  // the terminal step when there are none).
  const loadOffers = async (id: FlowId, onEmpty: Screen) => {
    const intent = intentFor(id);
    if (!intent) return;
    setBusy(true);
    setError(null);
    const { offers: got, standalone: std } = await getSaveOffers(intent);
    setBusy(false);
    setOffers(got);
    setStandalone(std);
    setOfferIndex(0);
    if (got.length > 0) {
      setOfferShownAny(true);
      setScreen("offer");
      trackEvent("save_offer_shown", {
        flow: id,
        tier,
        offer_kind: got[0].kind,
      });
    } else {
      setScreen(onEmpty);
    }
  };

  // Advance past the current offer: show the next one, or fall through to the
  // flow's terminal step (reason for a cancel, confirm for a debundle).
  const declineOffer = () => {
    const current = offers[offerIndex];
    if (current) {
      trackEvent("save_offer_declined", {
        flow: flowId!,
        tier,
        offer_kind: current.kind,
      });
    }
    const next = offerIndex + 1;
    if (next < offers.length) {
      setOfferIndex(next);
      trackEvent("save_offer_shown", {
        flow: flowId!,
        tier,
        offer_kind: offers[next].kind,
      });
    } else {
      setScreen(terminal.kind === "cancel" ? "reason" : "confirm");
    }
  };

  const acceptOffer = async () => {
    const offer = offers[offerIndex];
    if (!offer || !flowId) return;
    const intent = intentFor(flowId);
    setBusy(true);
    setError(null);

    // Plan switches go through change-tier (keeping the member's current tier);
    // the perpetual monthly_switch also attaches its forever coupon.
    if (isSwitch(offer.kind)) {
      const targetPlan: Plan = offer.kind === "annual_switch" ? "yearly" : "monthly";
      const r = await changeTier({ tier, plan: targetPlan });
      if (r.ok && intent && offer.kind === "monthly_switch" && offer.couponId) {
        await acceptSaveOffer(intent, offer.kind);
      }
      setBusy(false);
      if (r.ok) {
        trackEvent("save_offer_accepted", {
          flow: flowId,
          tier,
          offer_kind: offer.kind,
        });
        onSaved(offerCopy(offer).heading, r.effective_at ?? "");
      } else {
        setError(r.error ?? "Could not switch your plan — please try again.");
      }
      return;
    }

    // Coupon-backed offer: the server re-derives + attaches it.
    if (!intent) {
      setBusy(false);
      return;
    }
    const r = await acceptSaveOffer(intent, offer.kind);
    setBusy(false);
    if (r.ok) {
      trackEvent("save_offer_accepted", {
        flow: flowId,
        tier,
        offer_kind: offer.kind,
      });
      onSaved(couponHeadline(offer), r.next_charge_at ?? "");
    } else {
      setError(r.error ?? "Could not apply your offer — please try again.");
    }
  };

  const doCancel = async () => {
    if (!reason || !flowId) return;
    setBusy(true);
    setError(null);
    const r = await cancelSubscription({
      reason,
      note: note.trim() || undefined,
      offerOutcome: offerShownAny ? "declined" : "not_offered",
    });
    setBusy(false);
    if (r.ok) {
      trackEvent("subscription_cancelled", {
        reason,
        offer_outcome: offerShownAny ? "declined" : "not_offered",
        flow: flowId,
        retained_product: "full-exit",
      });
      onCancelled(r.access_until ?? "");
    } else {
      setError(r.error ?? "Could not cancel — please try again.");
    }
  };

  const doDebundle = async (to: "ark-plus" | "circle", retained: Retained) => {
    if (!plan || !flowId) return;
    setBusy(true);
    setError(null);
    const r = await changeTier({ tier: to, plan, retainedProduct: retained });
    setBusy(false);
    if (r.ok) {
      trackEvent("subscription_debundled", { flow: flowId, retained_product: retained });
      onDebundled(retained);
    } else {
      setError(r.error ?? "Could not update your plan — please try again.");
    }
  };

  // Enter Flow E's keep-just-one step, loading both single-product prices.
  const enterKeepOne = async () => {
    setBusy(true);
    setError(null);
    const [arkPlusRes, circleRes] = await Promise.all([
      getSaveOffers("debundle-remove-circle"), // keep Ark+ → its standalone price
      getSaveOffers("debundle-remove-ark-plus"), // keep Community → its standalone price
    ]);
    setBusy(false);
    setKeepOne({ arkPlus: arkPlusRes.standalone, circle: circleRes.standalone });
    setScreen("keep-one");
  };

  const heading = (text: string) => (
    <h2
      ref={headingRef}
      tabIndex={-1}
      id="cancel-title"
      className="display-upright mt-4 text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.05] text-fg-strong focus:outline-none"
    >
      {text}
    </h2>
  );

  const errorLine = error ? (
    <p className="mt-4 text-body-sm text-danger" aria-live="polite">
      {error}
    </p>
  ) : null;

  const primaryBtn =
    "inline-flex min-h-12 flex-1 items-center justify-center border border-cyan bg-cyan/10 px-4 text-sm font-semibold uppercase tracking-button text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";
  const secondaryBtn =
    "inline-flex min-h-12 flex-1 items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";
  const dangerBtn =
    "inline-flex min-h-12 flex-1 items-center justify-center border border-danger px-4 text-sm font-semibold uppercase tracking-button text-danger transition hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

  return (
    <Modal open onClose={onClose} className="max-w-md" labelledBy="cancel-title">
      {screen === "loading" ? (
        <div role="status" aria-live="polite">
          <p className="eyebrow">One moment</p>
          {heading("Loading…")}
        </div>
      ) : screen === "entry" ? (
        // Bundle-only decision tree → Flows C / D / E.
        <>
          {heading("What would you like to do?")}
          <p className="mt-4 text-body-sm text-fg">
            You have Ark+ and the Community together. You can drop one and keep
            the other, or cancel everything.
          </p>
          <div className="mt-8 flex flex-col gap-3">
            <button
              type="button"
              className={secondaryBtn}
              onClick={() => {
                flow("C");
                setTerminal({ kind: "debundle", to: "circle", retained: "kept-circle" });
                setScreen("mission");
              }}
            >
              Remove Ark+, keep the Community
            </button>
            <button
              type="button"
              className={secondaryBtn}
              onClick={() => {
                flow("D");
                setTerminal({ kind: "debundle", to: "ark-plus", retained: "kept-ark-plus" });
                setScreen("mission");
              }}
            >
              Remove the Community, keep Ark+
            </button>
            <button
              type="button"
              className={dangerBtn}
              onClick={() => {
                flow("E");
                setTerminal({ kind: "cancel" });
                setScreen("mission");
              }}
            >
              Cancel everything
            </button>
          </div>
        </>
      ) : screen === "mission" ? (
        <>
          <MissionReminder headingRef={headingRef} headingId="cancel-title" />
          {errorLine}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => {
                // A/B → their save offers; C/D → the bundle-value popup first;
                // E → the keep-just-one step.
                if (flowId === "A") void loadOffers("A", "reason");
                else if (flowId === "B") void loadOffers("B", "reason");
                else if (flowId === "C" || flowId === "D") setScreen("bundle-value");
                else if (flowId === "E") void enterKeepOne();
              }}
            >
              {busy ? "…" : "Continue"}
            </button>
            <button type="button" className={secondaryBtn} onClick={onClose}>
              Never mind
            </button>
          </div>
        </>
      ) : screen === "bundle-value" ? (
        // Flows C/D: the value of the combined subscription before separating.
        <>
          {heading("Your bundle saves you money.")}
          <p className="mt-4 text-body-sm text-fg">
            Ark+ and the Community are cheaper together than apart. Separating
            them means giving up that combined value —{" "}
            {flowId === "C"
              ? "the Community continues on its own at its standalone price."
              : "Ark+ continues on its own at its standalone price."}
          </p>
          {errorLine}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => {
                if (flowId === "C") void loadOffers("C", "confirm");
                else void loadOffers("D", "confirm");
              }}
            >
              {busy ? "…" : "Continue"}
            </button>
            <button type="button" className={primaryBtn} onClick={onClose}>
              Keep my bundle
            </button>
          </div>
        </>
      ) : screen === "keep-one" ? (
        // Flow E: keep just one product before cancelling both.
        <>
          {heading("Would you keep just one?")}
          <p className="mt-4 text-body-sm text-fg">
            Instead of leaving entirely, you can keep one at its standalone
            price:
          </p>
          <div className="mt-8 flex flex-col gap-3">
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => void doDebundle("ark-plus", "kept-ark-plus")}
            >
              Keep Ark+
              {keepOne.arkPlus ? ` — ${usd(keepOne.arkPlus.priceCents)}/${plan === "yearly" ? "yr" : "mo"}` : ""}
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => void doDebundle("circle", "kept-circle")}
            >
              Keep the Community
              {keepOne.circle ? ` — ${usd(keepOne.circle.priceCents)}/${plan === "yearly" ? "yr" : "mo"}` : ""}
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerBtn}
              onClick={() => setScreen("reason")}
            >
              No — cancel everything
            </button>
          </div>
          {errorLine}
        </>
      ) : screen === "offer" && offers[offerIndex] ? (
        (() => {
          const offer = offers[offerIndex];
          const copy = offerCopy(offer);
          return (
            <>
              {heading(copy.heading)}
              <p className="mt-4 text-body-sm text-fg">{copy.body}</p>
              {errorLine}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  className={primaryBtn}
                  onClick={() => void acceptOffer()}
                >
                  {busy ? "Applying…" : "Yes, keep me"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={secondaryBtn}
                  onClick={declineOffer}
                >
                  No thanks
                </button>
              </div>
            </>
          );
        })()
      ) : screen === "reason" ? (
        <>
          {heading("We're sorry to see you go.")}
          <p className="mt-4 text-body-sm text-fg">
            Help us improve by letting us know why you're leaving:
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
          <label htmlFor="cancel-note" className="mt-6 block text-body-sm text-fg-muted">
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
              disabled={!reason}
              className={secondaryBtn}
              onClick={() => {
                if (reason && flowId) {
                  trackEvent("cancellation_reason_submitted", { reason, flow: flowId });
                }
                setScreen("confirm");
              }}
            >
              Continue
            </button>
            <button type="button" className={secondaryBtn} onClick={onClose}>
              Never mind
            </button>
          </div>
        </>
      ) : (
        // confirm — terminal cancel or debundle.
        <>
          {terminal.kind === "cancel" ? (
            <>
              {heading("Cancel your membership?")}
              <p className="mt-4 text-body-sm text-fg">
                You'll keep access until the end of your current billing period.
              </p>
              {errorLine}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  disabled={busy}
                  className={dangerBtn}
                  onClick={() => void doCancel()}
                >
                  {busy ? "Cancelling…" : "Cancel membership"}
                </button>
                <button
                  type="button"
                  className={secondaryBtn}
                  onClick={() => setScreen("reason")}
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              {heading(
                terminal.to === "circle"
                  ? "Remove Ark+ and keep the Community?"
                  : "Remove the Community and keep Ark+?",
              )}
              <p className="mt-4 text-body-sm text-fg">
                {standalone
                  ? `Your ${terminal.to === "circle" ? "Community" : "Ark+"} membership will continue on its own at ${usd(standalone.priceCents)}/${plan === "yearly" ? "yr" : "mo"}, starting at the end of your current billing period.`
                  : "The remaining membership continues on its own at its standalone price, starting at the end of your current billing period."}
              </p>
              {errorLine}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  disabled={busy}
                  className={dangerBtn}
                  onClick={() => void doDebundle(terminal.to, terminal.retained)}
                >
                  {busy ? "Updating…" : "Confirm"}
                </button>
                <button type="button" className={primaryBtn} onClick={onClose}>
                  Keep my bundle
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
