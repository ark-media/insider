type Variant = "primary" | "secondary";

/**
 * Single source for a host portrait. Prefers a real `photo`; without one it
 * renders the cyan-radial initials placeholder (previously duplicated across
 * Hosts, ShowPage, and hosts/* routes). Two variants so adjacent placeholders
 * don't look identical: primary leans top-left, secondary leans bottom-right.
 */
export function HostArtwork({
  initials,
  role,
  variant = "primary",
  className,
  photo,
  name,
}: {
  initials: string;
  role?: string;
  variant?: Variant;
  className?: string;
  /** Portrait served from /public. When present it replaces the initials art. */
  photo?: string;
  /** Used for the photo's alt text; falls back to a generic label. */
  name?: string;
}) {
  const frame = `relative aspect-[4/5] overflow-hidden bg-navy-900 ring-1 ring-rule ${className ?? ""}`;

  if (photo) {
    return (
      <div className={frame}>
        <img
          src={photo}
          alt={name ? `${name} — portrait` : "Host portrait"}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        {role ? (
          <>
            {/* Fixed-navy scrim (not the themed token) so the white role label
                stays legible over any portrait in both light and dark themes. */}
            <div
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-navy/85 to-transparent"
            />
            <div className="absolute bottom-5 left-5 label tracking-[0.2em] text-white/90">
              {role}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  const gradient =
    variant === "primary"
      ? "radial-gradient(ellipse 60% 50% at 30% 20%, rgb(62 181 249 / 0.32) 0%, transparent 65%)"
      : "radial-gradient(ellipse 55% 45% at 75% 80%, rgb(62 181 249 / 0.28) 0%, transparent 60%)";

  return (
    <div className={frame}>
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
