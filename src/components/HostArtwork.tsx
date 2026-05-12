type Variant = "primary" | "secondary";

/**
 * Single source for the cyan-radial host placeholder. Previously duplicated
 * across Hosts, ShowPage, and hosts/* routes. Two variants so adjacent
 * portraits don't look identical: primary leans top-left, secondary
 * leans bottom-right.
 */
export function HostArtwork({
  initials,
  role,
  variant = "primary",
  className,
}: {
  initials: string;
  role?: string;
  variant?: Variant;
  className?: string;
}) {
  const gradient =
    variant === "primary"
      ? "radial-gradient(ellipse 60% 50% at 30% 20%, rgb(62 181 249 / 0.32) 0%, transparent 65%)"
      : "radial-gradient(ellipse 55% 45% at 75% 80%, rgb(62 181 249 / 0.28) 0%, transparent 60%)";

  return (
    <div
      className={`relative aspect-[4/5] overflow-hidden bg-navy-900 ring-1 ring-rule ${className ?? ""}`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-70"
        style={{ background: gradient }}
      />
      {/* Editorial: a faint hairline frame inside the ring to vary from a
          generic glow-card. */}
      <div
        aria-hidden="true"
        className="absolute inset-4 border border-rule-soft"
      />
      <div
        aria-hidden="true"
        className={`display absolute leading-none text-fg-strong/[0.06] ${
          variant === "primary"
            ? "right-2 bottom-0 text-[240px]"
            : "left-2 top-0 text-[240px]"
        }`}
      >
        {initials}
      </div>
      {role ? (
        <div className="eyebrow absolute bottom-5 left-5">{role}</div>
      ) : null}
    </div>
  );
}
