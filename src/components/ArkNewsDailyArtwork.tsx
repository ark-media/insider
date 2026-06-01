/**
 * Ark News Daily cover artwork — mirrors the show's brand identity:
 * deep magenta background with concentric ripples, cyan ark mark,
 * and the "Ark NEWS / DAILY" wordmark.
 */
export function ArkNewsDailyArtwork({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={`${title} — cover art`}
      className={`relative aspect-square overflow-hidden border border-and-purple-500/40 ${
        className ?? "w-full max-w-md"
      }`}
      style={{
        background:
          "radial-gradient(circle at 32% 68%, #6b2380 0%, #4d1758 35%, #2c0d39 70%, #1a0722 100%)",
      }}
    >
      {/* Concentric ripple rings radiating from the ark mark */}
      <svg
        aria-hidden="true"
        viewBox="0 0 400 400"
        className="absolute inset-0 h-full w-full"
      >
        <g
          fill="none"
          stroke="rgba(255, 255, 255, 0.08)"
          strokeWidth="1.6"
          transform="translate(128 268)"
        >
          {Array.from({ length: 14 }).map((_, i) => {
            const r = 40 + i * 26;
            return <circle key={r} cx="0" cy="0" r={r} />;
          })}
        </g>
        <g
          fill="none"
          stroke="rgba(255, 255, 255, 0.04)"
          strokeWidth="1"
          transform="translate(128 268)"
        >
          {Array.from({ length: 14 }).map((_, i) => {
            const r = 53 + i * 26;
            return <circle key={r} cx="0" cy="0" r={r} />;
          })}
        </g>
      </svg>

      {/* Ark mark in cyan, bottom-left */}
      <svg
        aria-hidden="true"
        viewBox="0 0 200 200"
        className="absolute left-[14%] top-[58%] h-[34%] w-[34%] drop-shadow-[0_8px_20px_rgba(0,0,0,0.45)]"
      >
        <defs>
          <linearGradient id="and-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5fd0ff" />
            <stop offset="60%" stopColor="#3eb5f9" />
            <stop offset="100%" stopColor="#1a8fce" />
          </linearGradient>
        </defs>
        {/* Hull base */}
        <path
          fill="url(#and-mark)"
          d="M14 110 C 30 100, 80 96, 100 96 C 120 96, 170 100, 186 110 L 168 142 L 32 142 Z"
        />
        {/* Hull stripe (negative space mid) */}
        <path
          fill="url(#and-mark)"
          d="M24 86 C 44 76, 80 72, 100 72 C 120 72, 156 76, 176 86 L 162 102 L 38 102 Z"
        />
        {/* Topmost wave stripe */}
        <path
          fill="url(#and-mark)"
          d="M34 62 C 52 50, 82 46, 100 46 C 118 46, 148 50, 166 62 L 150 78 L 50 78 Z"
        />
        {/* Bow / cabin */}
        <path
          fill="url(#and-mark)"
          d="M86 14 C 88 14, 112 14, 114 14 L 132 56 L 68 56 Z"
        />
      </svg>

      {/* Ark News Daily wordmark */}
      <div className="absolute right-[7%] top-[8%] flex flex-col items-end leading-none">
        <span
          className="font-display font-black text-white"
          style={{ fontSize: "clamp(2rem, 6.2vw, 3.4rem)", letterSpacing: "-0.01em" }}
        >
          <span style={{ textTransform: "none" }}>Ark</span>{" "}
          <span style={{ textTransform: "uppercase" }}>NEWS</span>
        </span>
        <span
          className="mt-1 font-display font-black"
          style={{
            color: "#3eb5f9",
            fontSize: "clamp(2.6rem, 8.4vw, 4.6rem)",
            letterSpacing: "0.005em",
          }}
        >
          DAILY
        </span>
      </div>

      {/* Ark Media endorsement, bottom-right */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 text-white/70">
        <svg
          aria-hidden="true"
          viewBox="0 0 200 200"
          className="h-4 w-4 opacity-90"
        >
          <path
            fill="rgba(255,255,255,0.9)"
            d="M14 130 C 30 122, 80 118, 100 118 C 120 118, 170 122, 186 130 L 168 158 L 32 158 Z M30 104 C 50 94, 82 90, 100 90 C 118 90, 150 94, 170 104 L 156 120 L 44 120 Z M86 40 L 114 40 L 132 84 L 68 84 Z"
          />
        </svg>
        <span className="label text-white/70">
          Ark Media
        </span>
      </div>
    </div>
  );
}
