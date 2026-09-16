import { useRef, type KeyboardEvent } from "react";

export type Plan = "monthly" | "yearly";

const PERIODS = ["monthly", "yearly"] as const;

// The monthly/annual billing-period toggle used on the pricing surfaces. It is a
// roving-tabindex `radiogroup`: arrow keys move to and select the adjacent
// option, Home/End jump to the ends. The caller owns state + analytics (its
// `onChange` fires `trackEvent("plan_selected")`); an optional `savingsPct`
// renders the annual-discount badge on the yearly option.
export function BillingPeriodToggle({
  plan,
  onChange,
  savingsPct = null,
}: {
  plan: Plan;
  onChange: (p: Plan) => void;
  savingsPct?: number | null;
}) {
  const periodRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      next = (index + 1) % PERIODS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (index - 1 + PERIODS.length) % PERIODS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = PERIODS.length - 1;
    else return;
    e.preventDefault();
    onChange(PERIODS[next]);
    periodRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="inline-flex border border-rule-strong p-1"
    >
      {PERIODS.map((p, i) => (
        <button
          key={p}
          ref={(el) => {
            periodRefs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={plan === p}
          tabIndex={plan === p ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => onChange(p)}
          className={`relative inline-flex min-h-11 items-center justify-center px-6 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
            plan === p
              ? "bg-cyan text-navy"
              : "text-fg-muted hover:text-fg-strong"
          }`}
        >
          {p === "yearly" ? "Annual" : "Monthly"}
          {p === "yearly" && savingsPct && savingsPct > 0 ? (
            <span
              className={`ml-2 text-xs ${plan === p ? "opacity-80" : "text-cyan"}`}
            >
              −{savingsPct}%
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
