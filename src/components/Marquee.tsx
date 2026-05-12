import { useState } from "react";

const items = [
  "After the cameras stop rolling",
  "★",
  "Subscriber debriefs",
  "★",
  "Full-length interviews",
  "★",
  "Ad-free feed",
  "★",
  "Q&A episodes",
  "★",
  "The Insider",
  "★",
];

export function Marquee() {
  const [paused, setPaused] = useState(false);
  const loop = [...items, ...items];
  return (
    <div className="relative overflow-hidden border-y border-rule-soft bg-navy-800 py-4">
      <div
        className="marquee-track flex w-max gap-10 whitespace-nowrap"
        data-paused={paused ? "true" : undefined}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {loop.map((t, i) => (
          <span
            key={`${t}-${i}`}
            className={`display-upright text-[22px] leading-none ${
              t === "★" ? "text-[14px] text-cyan" : "text-fg-strong"
            }`}
            aria-hidden={i >= items.length}
          >
            {t}
          </span>
        ))}
      </div>
      {/* Pause/play affordance for users who don't have OS reduced-motion on. */}
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-label={paused ? "Resume marquee animation" : "Pause marquee animation"}
        aria-pressed={paused}
        className="absolute right-2 top-1/2 inline-flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center bg-navy-900/80 text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <span aria-hidden="true" className="text-[12px]">
          {paused ? "▶" : "❚❚"}
        </span>
      </button>
    </div>
  );
}
