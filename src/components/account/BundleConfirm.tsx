import { useState } from "react";
import { formatMinor } from "../../lib/currency";
import { AXIS, dueTodayOf, fmtDate, type AxisKey } from "../../lib/entitlement-axes";
import type { BundleUpgradePreview } from "../../lib/auth";
import { dueTodayLine, perPeriod, renewsLine } from "../../../shared/billing-copy";
import { AGE_STATEMENT, type AgeAttestation } from "../../../shared/checkout-consent";

// The confirm step for D9. Every line answers a question a member asks at
// exactly this moment, in the order they ask it: what does it cost, when do I
// get it, and what comes off my card right now?
//
// Three rules keep it out of our own vocabulary:
//
//   1. Show the move as "$8 → $25", not as a price plus an argument. The fear
//      here is that the new price is charged ON TOP of the old one, and an
//      arrow between two numbers settles that faster than a sentence can.
//   2. Say what comes off the card today, with the figure. The switch charges
//      now and restarts the billing cycle from today, so the renewal date
//      moves too — say that as well.
//   3. No "prorated", no "invoice", no "billing period". Members have bills and
//      months; proration is our word for our machinery.
export function BundleConfirm({
  axis,
  alreadyActive,
  age,
  preview,
  working,
  error,
  onConfirm,
  onCancel,
}: {
  axis: AxisKey;
  // True on the near-expiry banner's entry point, where the member already has
  // this axis on a gift: the switch secures it rather than unlocking it.
  alreadyActive: boolean;
  // The 18+ confirmation, when this switch is what puts the member in the Fold.
  // Null for the other direction (adding Ark+ to a membership that already has
  // the Fold), which reaches nothing new to confirm.
  age: AgeAttestation | null;
  preview: BundleUpgradePreview;
  working: boolean;
  // A failed attempt, rendered INSIDE the panel, so the numbers the member is
  // deciding on stay on screen to retry from.
  error: string | null;
  // Handed the exact sentence the member ticked, so what we record is the copy
  // that was on screen rather than a second copy assembled by the caller. Null
  // when nothing was asked.
  onConfirm: (ageStatement: string | null) => void;
  onCancel: () => void;
}) {
  // The checkout modals fold this clause into the terms box, which they already
  // require. There is no terms box here — an existing member agreed to those
  // when they subscribed, and this change doesn't re-ask — so on this surface
  // the confirmation is a box of its own.
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [ageMissing, setAgeMissing] = useState(false);
  const meta = AXIS[axis];
  const { currency, minorFactor, plan } = preview;
  const bundle =
    preview.bundleCents === null
      ? null
      : formatMinor(preview.bundleCents, currency, minorFactor);
  const current =
    preview.currentCents === null
      ? null
      : formatMinor(preview.currentCents, currency, minorFactor);
  const billLine = `${dueTodayLine(dueTodayOf(preview))} ${renewsLine({
    plan,
    renewsOn: fmtDate(preview.renewsAt),
  })}`;

  return (
    <div className="mb-6 border border-cyan/50 bg-cyan/5 px-4 py-4">
      <h3 className="font-display text-[18px] leading-tight text-fg-strong">
        Add {meta.inline} to your membership
      </h3>
      <ul className="mt-3 space-y-2 text-body-sm text-fg">
        <li>
          {bundle ? (
            <>
              {current ? (
                <span className="font-semibold text-fg-strong">
                  {current} → {bundle} {perPeriod(plan)}.
                </span>
              ) : (
                <span className="font-semibold text-fg-strong">
                  {bundle} {perPeriod(plan)}.
                </span>
              )}{" "}
              One price for everything.
            </>
          ) : (
            <>One price for everything, not a second subscription.</>
          )}
        </li>
        <li>
          {alreadyActive
            ? `${meta.label} is yours to keep — no gap when the gift runs out.`
            : axis === "circle"
              ? "You're in right away."
              : "Your private feed is ready right away."}
        </li>
        <li>
          {billLine}
        </li>
      </ul>
      {age ? (
        <label
          className={`mt-4 flex cursor-pointer items-start gap-3 text-body-sm ${
            ageMissing && !confirmedAge ? "text-danger" : "text-fg-muted"
          }`}
        >
          <input
            type="checkbox"
            checked={confirmedAge}
            aria-invalid={ageMissing && !confirmedAge}
            onChange={(e) => setConfirmedAge(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          />
          <span>{AGE_STATEMENT[age]}</span>
        </label>
      ) : null}
      {ageMissing && !confirmedAge ? (
        <p className="mt-2 text-body-sm text-danger" role="alert">
          Please tick the box above to continue.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          // The button stays enabled while the box is empty, as in checkout, so
          // pressing it can say what's missing instead of leaving a member
          // guessing at a control that does nothing.
          onClick={() => {
            if (age && !confirmedAge) {
              setAgeMissing(true);
              return;
            }
            setAgeMissing(false);
            onConfirm(age ? AGE_STATEMENT[age] : null);
          }}
          disabled={working}
          className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
        >
          {working
            ? "Switching…"
            : bundle
              ? `Switch to ${bundle} ${perPeriod(plan)}`
              : `Add ${meta.inline}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={working}
          className="inline-flex items-center px-2 py-2 text-body-sm text-fg-muted underline-offset-4 transition hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
