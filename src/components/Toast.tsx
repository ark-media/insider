import { useEffect, useState } from "react";

/**
 * A single transient notification pinned to the bottom of the viewport. It
 * slides in on mount, auto-dismisses after `duration`, and can be dismissed
 * manually. `onDismiss` fires once the exit transition has played so the parent
 * can unmount it (and, e.g., clear the URL param that triggered it).
 */
export function Toast({
  message,
  onDismiss,
  duration = 5000,
}: {
  message: string;
  onDismiss: () => void;
  duration?: number;
}) {
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Slide in on the next frame, then arm the auto-dismiss timer.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    const timer = setTimeout(() => setLeaving(true), duration);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [duration]);

  // Once we start leaving, let the exit transition play, then unmount.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onDismiss, 300);
    return () => clearTimeout(timer);
  }, [leaving, onDismiss]);

  const visible = entered && !leaving;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-x-3 bottom-6 z-50 mx-auto flex max-w-lg items-start gap-4 overflow-hidden border border-cyan/60 bg-navy-900 px-5 py-4 text-fg-strong shadow-2xl ring-1 ring-cyan/25 transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none sm:bottom-8 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      {/* Cyan accent rail — the brand's signature hairline, turned vertical. */}
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-cyan" />
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center bg-cyan text-navy">
        <svg
          width="22"
          height="22"
          viewBox="0 0 28 28"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
        >
          <path className="draw-check" d="M5 14.5l5.5 5L23 8.5" />
        </svg>
      </span>
      <div className="flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Confirmed
        </p>
        <p className="mt-1.5 text-sm leading-[1.5]">{message}</p>
      </div>
      <button
        type="button"
        onClick={() => setLeaving(true)}
        aria-label="Dismiss"
        className="-mr-1.5 -mt-1.5 inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center text-fg-faint transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        >
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  );
}
