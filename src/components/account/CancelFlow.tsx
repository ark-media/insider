import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "../Modal";
import { MissionReminder } from "./MissionReminder";
import { trackEvent } from "../../lib/analytics";
import { applyCouponDiscount, formatCouponDiscount } from "../../lib/currency";
import { continuationCopy, introTerm, usd } from "../../lib/debundleCopy";
import {
  CANCELLATION_REASONS,
  OTHER_REASON_SLUG,
} from "../../../shared/cancellation";
import { formatTimestamp } from "../../../shared/format-date";
import {
  acceptSaveOffer,
  cancelSubscription,
  changeTier,
  getBundleBreakdown,
  getSaveOffers,
  submitCancellationSurvey,
  type BundleBreakdown,
} from "../../lib/auth";
import type {
  DebundlePrice,
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

// The product a save offer is measured in. The design words the Circle card
// "of Ark+" too, but a Fold member isn't being offered Ark+ — name what
// they'd actually keep.
const productName = (tier: Tier) => (tier === "circle" ? "the Fold" : "Ark+");

// The struck-through list price next to the discounted one — the design's
// "$8 $6/month". Falls back to the list price alone when the offer carries no
// coupon (e.g. a bare switch to monthly) or the discount doesn't reduce it.
function PricePair({
  listCents,
  offer,
  cadence,
}: {
  listCents: number;
  offer: RetentionOffer;
  cadence: "month" | "year";
}) {
  const discounted = applyCouponDiscount(listCents, offer.percentOff, offer.amountOff);
  return discounted !== null && discounted < listCents ? (
    <>
      <s className="text-fg-muted">{usd(listCents)}</s> {usd(discounted)}/{cadence}
    </>
  ) : (
    <>
      {usd(listCents)}/{cadence}
    </>
  );
}

// A service row's price in the bundle selector: what this product costs if it's
// the one you keep. The intro rate leads with the standalone price struck
// through — "$8.00 $6.50/month" — with its term underneath.
function RowPrice({
  price,
  plan,
}: {
  price: DebundlePrice;
  plan: Plan | null;
}) {
  const cadence = plan === "yearly" ? "year" : "month";
  return price.introCents !== null ? (
    <span className="text-right">
      <span className="text-fg-strong">
        <s className="text-fg-muted">{usd(price.priceCents)}</s>{" "}
        {usd(price.introCents)}/{cadence}
      </span>
      <span className="block text-fg-muted">{introTerm(price, plan)}</span>
    </span>
  ) : (
    <span className="text-fg-muted">
      {usd(price.priceCents)}/{cadence}
    </span>
  );
}

// A readable next-payment date for the success screen; "" for a missing/invalid
// ISO string so the caller can omit the line. A Stripe instant, so it renders
// in the member's own timezone.
function formatDate(iso: string): string {
  return formatTimestamp(iso, "long");
}

// A human headline for a coupon-backed offer, e.g. "20% off for 6 months".
function couponHeadline(o: RetentionOffer): string {
  const amount = formatCouponDiscount(o.percentOff, o.amountOff);
  if (o.durationMonths) {
    return `${amount} for ${o.durationMonths} month${o.durationMonths === 1 ? "" : "s"}`;
  }
  return amount;
}

// How long a coupon-backed rate lasts, as the trailing clause of the design's
// "$8 $6/month for 6 months of Ark+".
function couponTerm(o: RetentionOffer): string {
  if (o.durationMonths) {
    return ` for ${o.durationMonths} month${o.durationMonths === 1 ? "" : "s"}`;
  }
  return "";
}

// Copy for each offer kind's headline + supporting line, per the product
// cancellation-flows design. Amounts come from the resolved offer (Stripe),
// never hardcoded.
function offerCopy(
  o: RetentionOffer,
  tier: Tier,
  plan: Plan | null,
): { heading: string; body: ReactNode } {
  // The member's own billing cadence — what a coupon-backed rate is quoted in.
  const cadence = plan === "yearly" ? "year" : "month";
  switch (o.kind) {
    case "annual_switch": {
      const monthly = o.currentPriceCents ?? 0;
      const yearly = o.targetPriceCents ?? 0;
      const yearOfMonthly = monthly * 12;
      const percent =
        yearOfMonthly > 0
          ? Math.round(((yearOfMonthly - yearly) / yearOfMonthly) * 100)
          : 0;
      return {
        heading: "Get a full year of Ark+ for less",
        body:
          percent > 0
            ? `Save ${percent}% when you switch to annual billing`
            : `Switch to annual billing at ${usd(yearly)}/year`,
      };
    }
    case "monthly_switch": {
      const monthly = o.targetPriceCents;
      if (monthly == null) {
        return { heading: "Cancel any time", body: "Switch to monthly billing" };
      }
      // The hold keeps their annual rate for a set term, then the list price
      // takes over — say so on the card rather than surprise them later.
      const held = applyCouponDiscount(monthly, o.percentOff, o.amountOff);
      return {
        heading: "Cancel any time",
        body: (
          <>
            Switch to monthly billing for{" "}
            <PricePair listCents={monthly} offer={o} cadence="month" />
            {held !== null && held < monthly && o.durationMonths
              ? `${couponTerm(o)}, then ${usd(monthly)}/month`
              : null}
          </>
        ),
      };
    }
    case "supporter_coupon":
    case "affordability_coupon": {
      const list = o.currentPriceCents;
      return {
        heading: `Keep your benefits for ${formatCouponDiscount(o.percentOff, o.amountOff)}`,
        body:
          list != null ? (
            <>
              <PricePair listCents={list} offer={o} cadence={cadence} />
              {couponTerm(o)} of {productName(tier)}
            </>
          ) : (
            `${couponHeadline(o)} of ${productName(tier)}`
          ),
      };
    }
  }
}

// Whether accepting an offer is a plan switch (change-tier) or a coupon attach.
function isSwitch(kind: OfferKind): boolean {
  return kind === "annual_switch" || kind === "monthly_switch";
}

// The accept-button label for an offer card, per the design's CTAs ("Switch to
// annual", "Redeem 20% off discount"); offers are shown stacked, so each card
// names its own action rather than a generic "keep me".
function offerCta(o: RetentionOffer): string {
  switch (o.kind) {
    case "annual_switch":
      return "Switch to annual";
    case "monthly_switch":
      return "Switch to monthly";
    case "supporter_coupon":
    case "affordability_coupon":
      return `Redeem ${formatCouponDiscount(o.percentOff, o.amountOff)} discount`;
  }
}

type Screen =
  | "loading"
  // Bundle entry = the "keep any services?" checkbox selector (Flows C/D/E).
  | "entry"
  | "mission"
  | "offer"
  | "confirm"
  // Post-cancel reasons survey (survey-after-cancel): the cancel has already
  // committed when this shows, so it's non-blocking — the member can submit or skip.
  | "survey"
  // "Thanks for sticking around" — shown after an offer is accepted, with the
  // member's new subscription details. The change has already committed.
  | "saved";

// The terminal action a flow ends in.
type Terminal =
  | { kind: "cancel" }
  | { kind: "debundle"; to: "ark-plus" | "circle"; retained: Retained };

export type CancelFlowProps = {
  tier: Tier;
  plan: Plan | null;
  onClose: () => void;
  // Offer accepted → membership continues (coupon or plan switch). The flow shows
  // its own success screen; this just tells the page to close + resync.
  onSaved: () => void;
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
  // Every flow opens on the mission reminder (step 0); bundle then continues to
  // its "keep any services?" selector, A/B to their save offers.
  const [screen, setScreen] = useState<Screen>("mission");
  // All eligible offers, shown stacked on one "Are you sure?" screen (the
  // product design presents them together, not one at a time).
  const [offers, setOffers] = useState<RetentionOffer[]>([]);
  const [offerShownAny, setOfferShownAny] = useState(false);
  const [standalone, setStandalone] = useState<DebundlePrice | null>(null);
  // Bundle selector: the catalog prices behind the "keep any services?" screen,
  // and which of the two products the member still has checked (both by default).
  const [breakdown, setBreakdown] = useState<BundleBreakdown | null>(null);
  const [keptArkPlus, setKeptArkPlus] = useState(true);
  const [keptCircle, setKeptCircle] = useState(true);
  const [terminal, setTerminal] = useState<Terminal>({ kind: "cancel" });
  // Multi-select survey (checkboxes). Collected after the cancel commits.
  const [reasons, setReasons] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState("");
  // Set once the cancel commits, so the survey step can finish the flow.
  const [surveyId, setSurveyId] = useState<string | number | null>(null);
  const [accessUntil, setAccessUntil] = useState("");
  // Set once an offer is accepted, to render the "Thanks for sticking around"
  // screen. `detail` is the new recurring price (e.g. "$59.99/year").
  const [saved, setSaved] = useState<{
    detail: string;
    nextChargeAt: string;
  } | null>(null);
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

  // Bundle members open on the selector; load its prices once. A null result
  // (no sub / Stripe hiccup) just hides the price/total lines — the checkboxes
  // still work.
  useEffect(() => {
    if (tier !== "bundle") return;
    let live = true;
    void getBundleBreakdown().then((b) => {
      if (live) setBreakdown(b);
    });
    return () => {
      live = false;
    };
  }, [tier]);

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

  // Load the save offers for a flow and enter the stacked offer step. Cancel
  // flows always land on the offer screen (it doubles as the "Are you sure?"
  // step, even with zero cards); debundle flows with no offer skip to `onEmpty`.
  const loadOffers = async (id: FlowId, onEmpty: Screen) => {
    const intent = intentFor(id);
    if (!intent) return;
    setBusy(true);
    setError(null);
    const { offers: got, standalone: std } = await getSaveOffers(intent);
    setBusy(false);
    setOffers(got);
    setStandalone(std);
    if (got.length === 0 && onEmpty !== "offer") {
      setScreen(onEmpty);
      return;
    }
    if (got.length > 0) {
      setOfferShownAny(true);
      for (const o of got) {
        trackEvent("save_offer_shown", { flow: id, tier, offer_kind: o.kind });
      }
    }
    setScreen("offer");
  };

  // Decline every shown offer and proceed to the flow's terminal step — the
  // cancel itself for a cancel flow, the confirm screen for a debundle.
  const declineOffers = () => {
    for (const o of offers) {
      trackEvent("save_offer_declined", { flow: flowId!, tier, offer_kind: o.kind });
    }
    if (terminal.kind === "cancel") void doCancel();
    else setScreen("confirm");
  };

  const acceptOffer = async (offer: RetentionOffer) => {
    if (!offer || !flowId) return;
    const intent = intentFor(flowId);
    setBusy(true);
    setError(null);

    // Plan switches go through change-tier, keeping the member's current tier.
    // They carry no coupon — a switch just changes the billing cadence.
    if (isSwitch(offer.kind)) {
      const targetPlan: Plan = offer.kind === "annual_switch" ? "yearly" : "monthly";
      const r = await changeTier({ tier, plan: targetPlan });
      if (!r.ok) {
        setBusy(false);
        setError(r.error ?? "Could not switch your plan — please try again.");
        return;
      }
      // The monthly switch's quoted rate rests on the discount riding it. If the
      // switch lands but the discount fails to attach the member would be billed
      // the full monthly price, so treat it as required and surface the failure
      // rather than report a false save.
      if (intent && offer.kind === "monthly_switch" && offer.couponId) {
        const h = await acceptSaveOffer(intent, offer.kind);
        if (!h.ok) {
          setBusy(false);
          setError(
            h.error ??
              "Your plan was switched but we couldn't apply your discount — please try again or contact support.",
          );
          return;
        }
      }
      setBusy(false);
      trackEvent("save_offer_accepted", {
        flow: flowId,
        tier,
        offer_kind: offer.kind,
      });
      // New recurring price = the figure the accepted offer quoted, so the
      // success screen matches what they just agreed to.
      const cadence = targetPlan === "yearly" ? "year" : "month";
      const list = offer.targetPriceCents;
      // A held rate bills below list for its term — quote what they'll pay next.
      const rate =
        list == null
          ? null
          : (applyCouponDiscount(list, offer.percentOff, offer.amountOff) ?? list);
      const detail = rate != null ? `${usd(rate)}/${cadence}` : "";
      setSaved({ detail, nextChargeAt: r.effective_at ?? "" });
      setScreen("saved");
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
      // "New subscription details" wants a price: the discounted rate the card
      // quoted. Without a resolved list price to discount, the headline (e.g.
      // "20% off for 6 months") stands in.
      const list = offer.currentPriceCents;
      const discounted =
        list != null
          ? applyCouponDiscount(list, offer.percentOff, offer.amountOff)
          : null;
      setSaved({
        detail:
          discounted !== null
            ? `${usd(discounted)}/${plan === "yearly" ? "year" : "month"}`
            : couponHeadline(offer),
        nextChargeAt: r.next_charge_at ?? "",
      });
      setScreen("saved");
    } else {
      setError(r.error ?? "Could not apply your offer — please try again.");
    }
  };

  // Commit the cancel, then show the reasons survey (survey-after-cancel). The
  // member sees "your subscription has been cancelled" before we ask why; the
  // survey is optional and can't fail the cancel. `id` defaults to the active
  // flow, but the bundle selector passes "E" explicitly since it sets flowId and
  // cancels in the same handler (state hasn't flushed yet).
  const doCancel = async (id: FlowId | null = flowId) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    const outcome = offerShownAny ? "declined" : "not_offered";
    const r = await cancelSubscription({ offerOutcome: outcome });
    setBusy(false);
    if (r.ok) {
      trackEvent("subscription_cancelled", {
        offer_outcome: outcome,
        flow: id,
        retained_product: "full-exit",
      });
      setAccessUntil(r.access_until ?? "");
      setSurveyId(r.survey_id ?? null);
      setScreen("survey");
    } else {
      setError(r.error ?? "Could not cancel — please try again.");
    }
  };

  // Finish a cancel: attach the survey reasons (when we have a row to update),
  // then hand control back to the billing page. `skip` submits nothing. The
  // reason analytics fire only when we actually persist, so every
  // cancellation_reason_submitted event has a backing survey row — no phantom
  // events in a DB-less preview env (surveyId === null) or on an empty submit.
  const finishSurvey = async (skip: boolean) => {
    const chosen = skip ? [] : [...reasons];
    const hasInput = chosen.length > 0 || note.trim().length > 0;
    if (flowId && surveyId !== null && !skip && hasInput) {
      for (const slug of chosen) {
        trackEvent("cancellation_reason_submitted", { reason: slug, flow: flowId });
      }
      setBusy(true);
      await submitCancellationSurvey({
        surveyId,
        reasons: chosen,
        note: note.trim() || undefined,
      });
      setBusy(false);
    }
    onCancelled(accessUntil);
  };

  const toggleReason = (slug: string) => {
    setReasons((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const doDebundle = async (to: "ark-plus" | "circle", retained: Retained) => {
    if (!plan || !flowId) return;
    setBusy(true);
    setError(null);
    // Record whether a save offer was shown-and-declined before this debundle,
    // so the win-back row reads 'declined' vs 'not_offered' like a full cancel.
    const r = await changeTier({
      tier: to,
      plan,
      retainedProduct: retained,
      offerOutcome: offerShownAny ? "declined" : "not_offered",
    });
    setBusy(false);
    if (r.ok) {
      trackEvent("subscription_debundled", { flow: flowId, retained_product: retained });
      onDebundled(retained);
    } else {
      setError(r.error ?? "Could not update your plan — please try again.");
    }
  };

  // Act on the bundle selector's current selection. Keeping both is a no-op
  // (the "Keep Bundle" button); keeping one debundles to it (via its save
  // offer, then confirm); keeping none cancels everything.
  const applySelection = () => {
    if (keptArkPlus && keptCircle) {
      onClose();
    } else if (keptArkPlus) {
      // Remove the Fold, keep Ark+ → Flow D.
      flow("D");
      setTerminal({ kind: "debundle", to: "ark-plus", retained: "kept-ark-plus" });
      void loadOffers("D", "confirm");
    } else if (keptCircle) {
      // Remove Ark+, keep the Fold → Flow C.
      flow("C");
      setTerminal({ kind: "debundle", to: "circle", retained: "kept-circle" });
      void loadOffers("C", "confirm");
    } else {
      // Keep nothing → cancel everything (Flow E). Pass the id explicitly: flowId
      // state hasn't flushed by the time doCancel reads it.
      flow("E");
      setTerminal({ kind: "cancel" });
      void doCancel("E");
    }
  };

  // Dismissing the modal from a terminal screen must finalize, not just hide it:
  // the change already committed server-side, so the billing page needs to
  // refresh. On `saved` → onSaved; on `survey` → onCancelled (a skip); otherwise
  // a plain close.
  const handleModalClose = () => {
    if (screen === "saved") onSaved();
    else if (screen === "survey") onCancelled(accessUntil);
    else onClose();
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
    <Modal open onClose={handleModalClose} className="max-w-md" labelledBy="cancel-title">
      {screen === "loading" ? (
        <div role="status" aria-live="polite">
          <p className="eyebrow">One moment</p>
          {heading("Loading…")}
        </div>
      ) : screen === "entry" ? (
        // Bundle: "keep any services?" — checkbox per product with live total.
        // Keep both = no change; keep one = debundle; keep none = cancel all.
        (() => {
          const cadence = plan === "yearly" ? "year" : "month";
          const count = (keptArkPlus ? 1 : 0) + (keptCircle ? 1 : 0);
          // The single product being kept, when exactly one is checked — the
          // price the summary line and the primary button both quote.
          const keptOne = !breakdown
            ? null
            : count !== 1
              ? null
              : keptArkPlus
                ? breakdown.arkPlus
                : breakdown.circle;
          const keptOneName = keptArkPlus ? "Ark+" : "The Fold";
          // What the primary button charges: the bundle unchanged, or the kept
          // product at whatever it actually bills first (its intro rate).
          const buttonCents = !breakdown
            ? null
            : count === 2
              ? breakdown.bundleCents
              : (keptOne?.introCents ?? keptOne?.priceCents ?? null);
          const row =
            "flex cursor-pointer items-center justify-between gap-3 border border-rule p-4 text-body-sm";
          const box =
            "h-4 w-4 shrink-0 accent-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";
          return (
            <>
              {heading("Do you want to keep any services?")}
              <p className="mt-4 text-body-sm text-fg">
                {breakdown
                  ? `Your membership includes these services for ${usd(breakdown.bundleCents)}/${cadence}. Choose any individual services you'd like to keep.`
                  : "Your membership includes both of these. Choose any you'd like to keep — uncheck the rest."}
              </p>
              <fieldset className="mt-6">
                <legend className="sr-only">Services to keep</legend>
                <div className="flex flex-col gap-3">
                  <label className={row}>
                    <span className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={keptArkPlus}
                        onChange={() => setKeptArkPlus((v) => !v)}
                        className={box}
                      />
                      <span className="text-fg-strong">Ark+</span>
                    </span>
                    {breakdown ? (
                      <RowPrice price={breakdown.arkPlus} plan={plan} />
                    ) : null}
                  </label>
                  <label className={row}>
                    <span className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={keptCircle}
                        onChange={() => setKeptCircle((v) => !v)}
                        className={box}
                      />
                      <span className="text-fg-strong">The Fold</span>
                    </span>
                    {breakdown ? (
                      <RowPrice price={breakdown.circle} plan={plan} />
                    ) : null}
                  </label>
                </div>
              </fieldset>
              {/* What the selection means, spelled out — the intro rate and the
                  price it reverts to, so the term is never only in the fine
                  print. Nothing to say when the bundle is unchanged. */}
              <p className="mt-6 border-t border-rule pt-4 text-body-sm text-fg-muted">
                {count === 0
                  ? "Your membership ends at the end of your current billing period."
                  : count === 1
                    ? continuationCopy(keptOne, plan, keptOneName)
                    : "Keeping both — your membership is unchanged."}
              </p>
              {errorLine}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                {/* Primary carries the resulting count + price (the Apple One
                    pattern); at two services it's the no-change state, so it's
                    disabled rather than hidden — the row stays put as the member
                    toggles. */}
                <button
                  type="button"
                  disabled={busy || count === 2}
                  className={count === 0 ? dangerBtn : secondaryBtn}
                  onClick={applySelection}
                >
                  {busy
                    ? "…"
                    : count === 0
                      ? "Cancel all services"
                      : buttonCents !== null
                        ? `${count} service${count === 1 ? "" : "s"}: ${usd(buttonCents)}/${cadence}`
                        : `Keep ${count} service${count === 1 ? "" : "s"}`}
                </button>
                <button type="button" className={primaryBtn} onClick={onClose}>
                  Keep bundle
                </button>
              </div>
            </>
          );
        })()
      ) : screen === "mission" ? (
        <>
          <MissionReminder
            variant={tier === "circle" ? "circle" : "ark-plus"}
            headingRef={headingRef}
            headingId="cancel-title"
          />
          {errorLine}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button type="button" className={primaryBtn} onClick={onClose}>
              {tier === "bundle" ? "Keep my bundle" : "Keep my subscription"}
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => {
                // A/B → their save offers (the offer screen doubles as "Are you
                // sure?"); bundle → the "keep any services?" selector.
                if (flowId === "A") void loadOffers("A", "offer");
                else if (flowId === "B") void loadOffers("B", "offer");
                else setScreen("entry");
              }}
            >
              {busy ? "…" : tier === "bundle" ? "Continue" : "Continue to cancel"}
            </button>
          </div>
        </>
      ) : screen === "offer" ? (
        // All eligible offers, stacked on one "Are you sure?" screen. Each card
        // names its own action; a single terminal action declines them all.
        <>
          {heading(
            terminal.kind === "cancel"
              ? "Are you sure you want to cancel?"
              : "Before you go — a couple of options.",
          )}
          <p className="mt-4 text-body-sm text-fg">
            Your subscription helps make Ark Media's work possible.
          </p>
          {offers.length > 0 ? (
            <div className="mt-6 flex flex-col gap-4">
              {offers.map((offer) => {
                const copy = offerCopy(offer, tier, plan);
                return (
                  <div key={offer.kind} className="border border-rule p-4">
                    <p className="font-display text-fg-strong">{copy.heading}</p>
                    <p className="mt-2 text-body-sm text-fg">{copy.body}</p>
                    <button
                      type="button"
                      disabled={busy}
                      aria-busy={busy}
                      className={`mt-4 ${primaryBtn}`}
                      onClick={() => void acceptOffer(offer)}
                    >
                      {busy ? "Applying…" : offerCta(offer)}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {errorLine}
          {/* The design closes this screen with the single decline action — the
              offer cards are the way to stay, and the modal's close button is
              the way out. Debundles aren't in the design and keep their pair. */}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              className={terminal.kind === "cancel" ? dangerBtn : secondaryBtn}
              onClick={declineOffers}
            >
              {terminal.kind === "cancel"
                ? busy
                  ? "Cancelling…"
                  : "No thanks, just cancel"
                : "Continue"}
            </button>
            {terminal.kind === "cancel" ? null : (
              <button type="button" className={secondaryBtn} onClick={onClose}>
                Keep my bundle
              </button>
            )}
          </div>
        </>
      ) : screen === "survey" ? (
        // Post-cancel: the subscription is already cancelled; ask why (optional).
        <>
          {heading("Your subscription has been cancelled")}
          <p className="mt-4 text-body-sm text-fg">
            Help us improve by letting us know why you're cancelling
          </p>
          <fieldset className="mt-6">
            <legend className="sr-only">Reasons for cancelling</legend>
            <div className="flex flex-col gap-3">
              {CANCELLATION_REASONS.map((r) => (
                <label
                  key={r.slug}
                  className="flex cursor-pointer items-start gap-3 text-body-sm text-fg"
                >
                  <input
                    type="checkbox"
                    value={r.slug}
                    checked={reasons.has(r.slug)}
                    onChange={() => toggleReason(r.slug)}
                    className="mt-1 h-4 w-4 shrink-0 accent-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {reasons.has(OTHER_REASON_SLUG) ? (
            <>
              <label
                htmlFor="cancel-note"
                className="mt-6 block text-body-sm text-fg-muted"
              >
                Tell us more
              </label>
              <textarea
                id="cancel-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                className="mt-2 w-full resize-y border border-rule-strong bg-navy-900 px-3 py-2 text-body-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              />
            </>
          ) : null}
          {errorLine}
          {/* One button, as designed: the cancel has already committed, so an
              empty Submit is simply a skip (finishSurvey persists nothing when
              nothing was checked). */}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              className={primaryBtn}
              onClick={() => void finishSurvey(false)}
            >
              {busy ? "Submitting…" : "Submit"}
            </button>
          </div>
        </>
      ) : screen === "saved" && saved ? (
        // "Thanks for sticking around" — the offer is already applied.
        <>
          {heading("Thanks for sticking around")}
          <p className="mt-4 text-body-sm text-fg">
            Your subscription helps make Ark Media's work possible.
          </p>
          <dl className="mt-6 border border-rule p-4 text-body-sm">
            {saved.detail ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-fg-muted">New subscription details</dt>
                <dd className="font-display text-fg-strong">{saved.detail}</dd>
              </div>
            ) : null}
            {formatDate(saved.nextChargeAt) ? (
              <div className="mt-3 flex items-baseline justify-between gap-4">
                <dt className="text-fg-muted">Next payment date</dt>
                <dd className="text-fg-strong">
                  {formatDate(saved.nextChargeAt)}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button type="button" className={primaryBtn} onClick={onSaved}>
              Done
            </button>
          </div>
        </>
      ) : (
        // confirm — terminal debundle only (cancels commit from the offer or
        // selector screens straight into the post-cancel survey).
        terminal.kind === "debundle" ? (
          <>
            {heading(
              terminal.to === "circle"
                ? "Remove Ark+ and keep the Fold?"
                : "Remove the Fold and keep Ark+?",
            )}
            <p className="mt-4 text-body-sm text-fg">
              {continuationCopy(
                standalone,
                plan,
                terminal.to === "circle" ? "The Fold" : "Ark+",
              )}
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
        ) : null
      )}
    </Modal>
  );
}
