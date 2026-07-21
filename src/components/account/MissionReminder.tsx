import type { Ref } from "react";

// The shared mission reminder shown as step zero of every cancel/debundle flow
// (Flows A–E). One reusable block, one copy source — the reminder that a
// membership is support for independent Jewish media, not just content access.

// The approved mission copy lives here, in one exported constant, so there is a
// single edit point across all five flows.
export const MISSION_REMINDER_COPY = {
  heading: "Before you go — a reminder of what your membership makes possible.",
  body: "Your subscription is more than access to content. It directly funds independent Jewish media — the reporting, storytelling, and community Ark Media exists to sustain. Every subscriber makes that work possible.",
} as const;

// Rendered first in each flow. The heading doubles as the flow's labelled
// heading when `headingRef`/`headingId` are passed (so the modal's focus
// management and aria-labelledby land on it). `intro` optionally frames the
// specific action under the shared mission copy.
export function MissionReminder({
  headingRef,
  headingId,
  intro,
}: {
  headingRef?: Ref<HTMLHeadingElement>;
  headingId?: string;
  intro?: string;
}) {
  return (
    <div className="text-body-sm text-fg">
      <h2
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="display-upright text-[clamp(1.25rem,2.6vw,1.6rem)] leading-[1.1] text-fg-strong focus:outline-none"
      >
        {MISSION_REMINDER_COPY.heading}
      </h2>
      <p className="mt-4">{MISSION_REMINDER_COPY.body}</p>
      {intro ? <p className="mt-4 text-fg-muted">{intro}</p> : null}
    </div>
  );
}
