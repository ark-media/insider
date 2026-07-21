import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { MissionReminder } from "./MissionReminder";
import { trackEvent } from "../../lib/analytics";
import { formatCouponDiscount, formatMinor } from "../../lib/currency";
import {
  CANCELLATION_REASONS,
  OTHER_REASON_SLUG,
} from "../../../shared/cancellation";
import {
  acceptSaveOffer,
  cancelSubscription,
  changeTier,
  getSaveOffers,
  submitCancellationSurvey,
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

// A readable next-payment date for the success screen; "" for a missing/invalid
// ISO string so the caller can omit the line.
function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

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

// The accept-button label for an offer card. Mirrors the product design's CTAs
// ("Switch to annual", "Redeem discount"); offers are shown stacked, so each
// card names its own action rather than a generic "keep me".
function offerCta(kind: OfferKind): string {
  switch (kind) {
    case "annual_switch":
      return "Switch to annual";
    case "monthly_switch":
      return "Switch to monthly";
    case "circle_free_months":
      return "Add free months";
    case "supporter_coupon":
    case "affordability_coupon":
    case "perpetual_discount":
      return "Redeem this offer";
  }
}

type Screen =
  | "loading"
  | "entry"
  | "mission"
  | "bundle-value"
  | "keep-one"
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
  const [screen, setScreen] = useState<Screen>(() =>
    tier === "bundle" ? "entry" : "mission",
  );
  // All eligible offers, shown stacked on one "Are you sure?" screen (the
  // product design presents them together, not one at a time).
  const [offers, setOffers] = useState<RetentionOffer[]>([]);
  const [offerShownAny, setOfferShownAny] = useState(false);
  const [standalone, setStandalone] = useState<StandalonePrice | null>(null);
  // Flow E keep-just-one standalone prices for each single product.
  const [keepOne, setKeepOne] = useState<{
    arkPlus: StandalonePrice | null;
    circle: StandalonePrice | null;
  }>({ arkPlus: null, circle: null });
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

    // Plan switches go through change-tier (keeping the member's current tier);
    // the perpetual monthly_switch also attaches its forever coupon.
    if (isSwitch(offer.kind)) {
      const targetPlan: Plan = offer.kind === "annual_switch" ? "yearly" : "monthly";
      const r = await changeTier({ tier, plan: targetPlan });
      if (!r.ok) {
        setBusy(false);
        setError(r.error ?? "Could not switch your plan — please try again.");
        return;
      }
      // The perpetual monthly_switch's whole promise ("keep your annual rate")
      // rests on its forever coupon. If the switch lands but the coupon fails to
      // attach, the member would be billed full monthly price — so treat the
      // attach as required and surface the failure instead of a false "saved".
      if (intent && offer.kind === "monthly_switch" && offer.couponId) {
        const c = await acceptSaveOffer(intent, offer.kind);
        if (!c.ok) {
          setBusy(false);
          setError(
            c.error ??
              "Your plan was switched but we couldn't lock in your rate — please try again or contact support.",
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
      const detail =
        offer.targetPriceCents != null
          ? `${usd(offer.targetPriceCents)}/${cadence}`
          : "";
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
      // For a coupon we don't hold the resolved amount, so the discount headline
      // (e.g. "$6/mo for 6 months") stands in for the new details.
      setSaved({ detail: couponHeadline(offer), nextChargeAt: r.next_charge_at ?? "" });
      setScreen("saved");
    } else {
      setError(r.error ?? "Could not apply your offer — please try again.");
    }
  };

  // Commit the cancel, then show the reasons survey (survey-after-cancel). The
  // member sees "your subscription has been cancelled" before we ask why; the
  // survey is optional and can't fail the cancel.
  const doCancel = async () => {
    if (!flowId) return;
    setBusy(true);
    setError(null);
    const outcome = offerShownAny ? "declined" : "not_offered";
    const r = await cancelSubscription({ offerOutcome: outcome });
    setBusy(false);
    if (r.ok) {
      trackEvent("subscription_cancelled", {
        offer_outcome: outcome,
        flow: flowId,
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
          <MissionReminder
            variant={tier === "circle" ? "circle" : "ark-plus"}
            headingRef={headingRef}
            headingId="cancel-title"
          />
          {errorLine}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button type="button" className={primaryBtn} onClick={onClose}>
              Keep my subscription
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => {
                // A/B → their save offers (the offer screen doubles as "Are you
                // sure?"); C/D → the bundle-value popup first; E → keep-just-one.
                if (flowId === "A") void loadOffers("A", "offer");
                else if (flowId === "B") void loadOffers("B", "offer");
                else if (flowId === "C" || flowId === "D") setScreen("bundle-value");
                else if (flowId === "E") void enterKeepOne();
              }}
            >
              {busy ? "…" : "Continue to cancel"}
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
              onClick={() => void doCancel()}
            >
              No — cancel everything
            </button>
          </div>
          {errorLine}
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
                const copy = offerCopy(offer);
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
                      {busy ? "Applying…" : offerCta(offer.kind)}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {errorLine}
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
            <button type="button" className={secondaryBtn} onClick={onClose}>
              {tier === "bundle" ? "Keep my bundle" : "Keep my subscription"}
            </button>
          </div>
        </>
      ) : screen === "survey" ? (
        // Post-cancel: the subscription is already cancelled; ask why (optional).
        <>
          {heading("Your subscription has been cancelled.")}
          <p className="mt-4 text-body-sm text-fg">
            Help us improve by letting us know why you're cancelling:
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
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              // Nothing checked ⇒ Submit would be indistinguishable from Skip, so
              // disable it and let the member Skip explicitly instead.
              disabled={busy || reasons.size === 0}
              className={primaryBtn}
              onClick={() => void finishSurvey(false)}
            >
              {busy ? "Submitting…" : "Submit"}
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondaryBtn}
              onClick={() => void finishSurvey(true)}
            >
              Skip
            </button>
          </div>
        </>
      ) : screen === "saved" && saved ? (
        // "Thanks for sticking around" — the offer is already applied.
        <>
          {heading("Thanks for sticking around.")}
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
        // confirm — terminal debundle only (cancels commit from the offer/
        // keep-one screens straight into the post-cancel survey).
        terminal.kind === "debundle" ? (
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
        ) : null
      )}
    </Modal>
  );
}
