import { useState } from "react";
import { changeTier, type ChangePreview } from "../../lib/auth";
import { formatMinor } from "../../lib/currency";
import { fmtDate } from "../../lib/entitlement-axes";
import { perPeriod } from "../../../shared/billing-copy";
import {
  ChangeAmountField,
  GIFT_BLOCKED_LINE,
} from "./planChange";
import { priceMoveLine, useChangeQuote, whenLine } from "../../lib/planChange";

// The billing page's confirm step for a change to what a member pays without
// changing what they get: monthly ↔ annual, or a new amount on the same plan.
// Same rules as the Bundle upgrade panel: state the move as "$12 a month →
// $120 a year", say what comes off the card today or when the new price
// starts, and let a member who chooses their own amount choose it here.
export function PlanChangePanel({
  heading,
  initial,
  onDone,
  onCancel,
}: {
  heading: string;
  initial: ChangePreview;
  // The confirmation for the page to show once the change has gone through.
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { preview, value, setValue, settled, quoteError } = useChangeQuote(initial);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same plan, same amount: nothing to change yet (the amount panel opens on
  // what they pay today).
  const unchanged =
    preview.plan === preview.currentPlan && preview.amountCents === preview.currentCents;
  const price = `${formatMinor(preview.amountCents, preview.currency, preview.minorFactor)} ${perPeriod(preview.plan)}`;

  const confirm = async () => {
    setWorking(true);
    setError(null);
    const r = await changeTier({
      tier: preview.tier,
      plan: preview.plan,
      // Above the minimum only: at it, the server bills the catalog price.
      ...(preview.amountCents > preview.floorCents
        ? { customAmountCents: preview.amountCents }
        : {}),
    });
    setWorking(false);
    if (!r.ok) {
      setError(r.error ?? "Could not change your plan. Please try again.");
      return;
    }
    if (r.timing === "period_end") {
      const on = fmtDate(r.effective_at ?? preview.startsAt);
      onDone(`Done. You'll pay ${price} from ${on ?? "your next renewal"}.`);
    } else {
      const on = fmtDate(r.next_charge_at ?? preview.renewsAt);
      onDone(`Done. You're now paying ${price}.${on ? ` Your membership renews on ${on}.` : ""}`);
    }
  };

  return (
    <div className="mb-6 max-w-xl border border-cyan/50 bg-cyan/5 px-4 py-4">
      <h3 className="font-display text-[18px] leading-tight text-fg-strong">{heading}</h3>
      <ChangeAmountField preview={initial} value={value} onChange={setValue} />
      <ul className="mt-4 space-y-2 text-body-sm text-fg" aria-live="polite">
        <li>
          <span className="font-semibold text-fg-strong">{priceMoveLine(preview)}</span>
        </li>
        <li>
          {preview.blocked === "gift_extension"
            ? GIFT_BLOCKED_LINE
            : unchanged
              ? "Move the amount to change what you pay."
              : whenLine(preview)}
        </li>
      </ul>
      {quoteError ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {quoteError}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {preview.blocked ? null : (
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={working || !settled || unchanged}
            className="inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {working ? "Changing…" : !settled ? "Updating…" : `Change to ${price}`}
          </button>
        )}
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
