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
  const loop = [...items, ...items];
  return (
    <div className="relative overflow-hidden border-y border-white/8 bg-navy-800 py-4">
      <div className="marquee-track flex w-max gap-10 whitespace-nowrap">
        {loop.map((t, i) => (
          <span
            key={i}
            className={`display-upright text-[22px] ${
              t === "★" ? "text-cyan" : "text-white"
            }`}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
