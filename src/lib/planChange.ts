import { useEffect, useRef, useState } from "react";
import { getChangePreview, type ChangePreview } from "./auth";
import { formatMinor, toMajor, toMinor } from "./currency";
import { dueTodayOf, fmtDate } from "./entitlement-axes";
import { dueTodayLine, perPeriod, renewsLine } from "../../shared/billing-copy";
import { resolveAmount } from "./pwycAmount";

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
  const [value, setValueState] = useState(() => valueFor(initial.amountCents, initial));
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const latest = useRef(0);

  const { effectiveMajor } = resolveAmount(value, initial.floorCents, initial.minorFactor);
  const wantCents =
    effectiveMajor === null ? initial.floorCents : toMinor(effectiveMajor, initial.minorFactor);

  const setValue = (next: string) => {
    const { effectiveMajor: nextMajor } = resolveAmount(
      next,
      initial.floorCents,
      initial.minorFactor,
    );
    const nextCents =
      nextMajor === null ? initial.floorCents : toMinor(nextMajor, initial.minorFactor);
    setQuoting(nextCents !== preview.amountCents);
    setValueState(next);
  };

  useEffect(() => {
    if (!initial.pwyc) return;
    if (wantCents === preview.amountCents) {
      // Back on the amount already quoted: drop any answer still in flight.
      latest.current++;
      return;
    }
    const ticket = ++latest.current;
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
