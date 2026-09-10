import { formatMinor } from "../../lib/currency";
import { AXIS, fmtDate, settlementOf, type AxisKey } from "../../lib/entitlement-axes";
import type { BundleUpgradePreview } from "../../lib/auth";
import { NOTHING_TO_PAY_TODAY, nextBillLine, perPeriod } from "../../../shared/billing-copy";

// The confirm step for D9. Every line answers a question a member asks at
// exactly this moment, in the order they ask it: what does it cost, when do I
// get it, and what comes off my card right now?
//
// Three rules keep it out of our own vocabulary:
//
//   1. Show the move as "$8 → $25", not as a price plus an argument. The fear
//      here is that the new price is charged ON TOP of the old one, and an
//      arrow between two numbers settles that faster than a sentence can.
//   2. Say "nothing to pay today" out loud. It's the true answer and nobody
//      guesses it, because the change is settled on the next bill instead.
//   3. No "prorated", no "invoice", no "billing period". Members have bills and
//      months; proration is our word for our machinery.
export function BundleConfirm({
  axis,
  alreadyActive,
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
  preview: BundleUpgradePreview;
  working: boolean;
  // A failed attempt, rendered INSIDE the panel, so the numbers the member is
  // deciding on stay on screen to retry from.
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
  const renews = fmtDate(preview.renewsAt);
  const billLine = nextBillLine({
    plan,
    renewsOn: renews,
    settlement: settlementOf(preview),
  });

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
          {NOTHING_TO_PAY_TODAY} {billLine}
        </li>
      </ul>
      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirm}
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
