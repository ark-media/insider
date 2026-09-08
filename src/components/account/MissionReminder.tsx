import type { Ref } from "react";

// The shared mission reminder shown as step zero of every cancel/debundle flow
// (Flows A–E). One reusable block, one copy source — the reminder that a
// membership is support for independent Jewish media, not just content access.

// The approved mission copy (from the product cancellation-flows design). The
// heading is shared; the body is tier-aware — an Ark+ member is thanked as an
// "Ark+ subscriber", a Fold (Circle) member as a "subscriber". Bundle
// members hold Ark+, so they get the Ark+ wording. One edit point across all
// five flows.
type MissionVariant = "ark-plus" | "circle";

const MISSION_REMINDER_COPY: Record<
  MissionVariant,
  { heading: string; body: string }
> = {
  "ark-plus": {
    heading: "Thanks for being a subscriber!",
    body: "Ark Media is funded in large part by our Ark+ subscribers. They allow us to cover Israel and the Jewish world honestly, without compromise. As an Ark+ subscriber, you make that possible.",
  },
  circle: {
    heading: "Thanks for being a subscriber!",
    body: "Ark Media is funded in large part by our subscribers. They allow us to cover Israel and the Jewish world honestly, without compromise. As a subscriber, you make that possible.",
  },
} as const;

// Rendered first in each flow. The heading doubles as the flow's labelled
// heading when `headingRef`/`headingId` are passed (so the modal's focus
// management and aria-labelledby land on it). `intro` optionally frames the
// specific action under the shared mission copy.
export function MissionReminder({
  variant = "ark-plus",
  headingRef,
  headingId,
  intro,
}: {
  variant?: MissionVariant;
  headingRef?: Ref<HTMLHeadingElement>;
  headingId?: string;
  intro?: string;
}) {
  const copy = MISSION_REMINDER_COPY[variant];
  return (
    <div className="text-body-sm text-fg">
      <h2
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="display-upright text-[clamp(1.25rem,2.6vw,1.6rem)] leading-[1.1] text-fg-strong focus:outline-none"
      >
        {copy.heading}
      </h2>
      <p className="mt-4">{copy.body}</p>
      {intro ? <p className="mt-4 text-fg-muted">{intro}</p> : null}
    </div>
  );
}
