import type { ReactNode } from "react";

export function SuccessMark({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-3">
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="square"
          className="text-cyan"
        >
          <path className="draw-check" d="M5 14.5l5.5 5L23 8.5" />
        </svg>
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Confirmed
        </span>
      </div>
      <h3 className="display-upright mt-5 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-fg-strong">
        {title}
      </h3>
      <div
        aria-hidden="true"
        className="draw-rule mt-5 h-px w-16 origin-left bg-cyan"
        style={{ animationDelay: "0.55s" }}
      />
      {children ? (
        <div className="mt-5 text-[14px] leading-[1.6] text-fg">
          {children}
        </div>
      ) : null}
    </div>
  );
}
