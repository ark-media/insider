import { useEffect, useRef, useState } from "react";
import { getChangePreview, type ChangePreview } from "../../lib/auth";
import { formatMinor, toMajor, toMinor } from "../../lib/currency";
import { dueTodayOf, fmtDate } from "../../lib/entitlement-axes";
import { dueTodayLine, perPeriod, renewsLine } from "../../../shared/billing-copy";
import { AmountPicker, resolveAmount } from "../AmountPicker";

// The shared parts of every confirm step that changes what a member pays: the
// amount picker for members who choose their own amount, the re-quote as it
// moves, and the sentences that say what happens to the card.

// The picker's value for an amount: "" at the minimum, the major-unit figure
// above it.
function valueFor(amountCents: number, preview: ChangePreview): string {
  return amountCents <= preview.floorCents
    ? ""
    : String(toMajor(amountCents, preview.minorFactor));
}

// Re-quote the change as the member moves the amount. Starts from the quote
// the panel opened with, which is already at the pre-filled amount, and
// debounces so a slider drag asks once it settles. Stale answers are dropped.
export function useChangeQuote(initial: ChangePreview) {
  const [preview, setPreview] = useState(initial);
  const [value, setValue] = useState(() => valueFor(initial.amountCents, initial));
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const latest = useRef(0);

  const { effectiveMajor } = resolveAmount(value, initial.floorCents, initial.minorFactor);
  const wantCents =
    effectiveMajor === null ? initial.floorCents : toMinor(effectiveMajor, initial.minorFactor);

  useEffect(() => {
    if (!initial.pwyc) return;
    if (wantCents === preview.amountCents) {
      // Back on the amount already quoted: drop any answer still in flight.
      latest.current++;
      setQuoting(false);
      return;
    }
    const ticket = ++latest.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      const r = await getChangePreview({
        tier: initial.tier,
        plan: initial.plan,
        customAmountCents: wantCents,
      });
      if (ticket !== latest.current) return;
      setQuoting(false);
      if (r.kind === "preview") {
        setPreview(r.preview);
        setQuoteError(null);
      } else {
        setQuoteError(
          r.kind === "error" && r.message
            ? r.message
            : "We couldn't update the price. Please try again.",
        );
      }
    }, 400);
    return () => clearTimeout(t);
  }, [wantCents, preview.amountCents, initial.pwyc, initial.tier, initial.plan]);

  // Settled means the numbers on screen are for the amount on the picker.
  const settled = !quoting && wantCents === preview.amountCents;
  return { preview, value, setValue, settled, quoteError };
}

// The amount picker, for a member who chooses their own amount. Nothing for
// everyone else: their change is at the minimum.
export function ChangeAmountField({
  preview,
  value,
  onChange,
}: {
  preview: ChangePreview;
  value: string;
  onChange: (value: string) => void;
}) {
  if (!preview.pwyc) return null;
  return (
    <div className="mt-4 border-t border-rule pt-4">
      <span className="eyebrow text-fg-muted">Choose your amount</span>
      <AmountPicker
        plan={preview.plan}
        currency={preview.currency}
        factor={preview.minorFactor}
        floorMinor={preview.floorCents}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

// "$12 a month → $120 a year." The arrow settles the fear that the new price
// is charged on top of the old one faster than a sentence can.
export function priceMoveLine(preview: ChangePreview): string {
  const next = `${formatMinor(preview.amountCents, preview.currency, preview.minorFactor)} ${perPeriod(preview.plan)}`;
  if (preview.currentCents === null || !preview.currentPlan) return `${next}.`;
  const now = `${formatMinor(preview.currentCents, preview.currency, preview.minorFactor)} ${perPeriod(preview.currentPlan)}`;
  return `${now} → ${next}.`;
}

// What happens to the card: charged today with the cycle restarted, or the new
// price starting at the end of what's already paid for.
export function whenLine(preview: ChangePreview): string {
  if (preview.timing === "immediate") {
    return `${dueTodayLine(dueTodayOf(preview))} ${renewsLine({
      plan: preview.plan,
      renewsOn: fmtDate(preview.renewsAt),
    })}`;
  }
  const on = fmtDate(preview.startsAt);
  return on
    ? `Nothing to pay today. The new price starts on ${on}, when your current plan ends.`
    : "Nothing to pay today. The new price starts when your current plan ends.";
}

export const GIFT_BLOCKED_LINE =
  "Your gifted membership time is still running, so this change can’t be made yet. Please contact us and we’ll help.";
