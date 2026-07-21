import type { ComponentProps } from "react";

// The app's single inline loading spinner. Size (and any extra classes) come in
// via `className`; ARIA/role are left to the caller since usage varies (some
// wrap it in a `role="status"` region, some put the label on a parent button).
export function Spinner({ className = "", ...rest }: ComponentProps<"div">) {
  return (
    <div
      {...rest}
      className={`animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none ${className}`.trim()}
    />
  );
}

// A spinner + polite status label on one row, used by the checkout modals while
// a Stripe transition is in flight.
export function LoadingRow({ label }: { label: string }) {
  return (
    <div
      className="mt-6 flex items-center gap-3 text-sm text-fg"
      role="status"
      aria-live="polite"
    >
      <Spinner className="h-4 w-4" />
      <span>{label}</span>
    </div>
  );
}
