type EventAccess = "ark-plus" | "public";

export type EventFormat = "audio-room" | "video-ama" | "watch-party" | "in-person";

export type ArkEvent = {
  id: string;
  title: string;
  /** ISO timestamp — UTC */
  startsAt: string;
  durationMinutes: number;
  format: EventFormat;
  /**
   * Human label for the format. Set when a source (e.g. Circle's `location_type`)
   * carries a label that doesn't map cleanly onto `format`; the UI prefers it
   * over `FORMAT_LABEL[format]` when present.
   */
  formatLabel?: string;
  access: EventAccess;
  hosts: string[];
  description: string;
  /** Where the event lives. Always Circle for member events; mixed for public ones. */
  location: "circle-app" | "youtube-live" | "in-person";
  /** Optional venue (for in-person) */
  venue?: string;
  /**
   * Ready-to-use deep link into the app for this event (already SSO-wrapped by
   * the data layer). Present for real Circle events; absent for mock events,
   * where the UI falls back to the events-space link.
   */
  deepLink?: string;
};

const dayMs = 24 * 60 * 60 * 1000;

const today = new Date("2026-04-30T12:00:00Z");

function offsetIso(days: number, hour = 18, minute = 0): string {
  const d = new Date(today.getTime() + days * dayMs);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const events: ArkEvent[] = [
  {
    id: "evt-2026-05-04-cmb-live",
    title: "Call Me Back Live — Coalition Roundtable",
    startsAt: offsetIso(4, 23),
    durationMinutes: 75,
    format: "audio-room",
    access: "ark-plus",
    hosts: ["Dan Senor", "Amit Segal", "Nadav Eyal"],
    description:
      "An audio roundtable in the Fold on the latest coalition geometry. Members can submit questions live.",
    location: "circle-app",
  },
  {
    id: "evt-2026-05-08-fhs-ama",
    title: "For Heaven's Sake — Members AMA",
    startsAt: offsetIso(8, 22),
    durationMinutes: 60,
    format: "video-ama",
    access: "ark-plus",
    hosts: ["Donniel Hartman", "Yossi Klein Halevi"],
    description:
      "A monthly video AMA with Donniel and Yossi. Bring the questions you'd have asked them after a podcast.",
    location: "circle-app",
  },
  {
    id: "evt-2026-05-12-watch-party",
    title: "Knesset session watch party",
    startsAt: offsetIso(12, 17),
    durationMinutes: 120,
    format: "watch-party",
    access: "ark-plus",
    hosts: ["Ark Media newsroom"],
    description:
      "We watch the Knesset session together with live commentary in the Fold.",
    location: "circle-app",
  },
  {
    id: "evt-2026-05-19-public",
    title: "Open conversation: a year of Ark Media",
    startsAt: offsetIso(19, 23),
    durationMinutes: 60,
    format: "audio-room",
    access: "public",
    hosts: ["Dan Senor", "Donniel Hartman"],
    description:
      "An open audio conversation marking a year of Ark Media. Open to everyone — RSVP in the Fold.",
    location: "circle-app",
  },
  {
    id: "evt-2026-06-05-nyc",
    title: "Ark Media in New York — a live recording",
    startsAt: offsetIso(36, 23, 30),
    durationMinutes: 90,
    format: "in-person",
    access: "ark-plus",
    hosts: ["Dan Senor"],
    description:
      "A live recording of Call Me Back in New York. Ark+ members get first access to tickets.",
    location: "in-person",
    venue: "92NY, New York",
  },
];

type EventStatus = "live" | "upcoming";

export type EventWithStatus = { event: ArkEvent; status: EventStatus };

/**
 * Classify events for the Fold's "live + upcoming" strip. An event is:
 *   - `live`     when `now` falls within [startsAt, startsAt + duration)
 *   - `upcoming` when it starts in the future
 *   - excluded   once it has ended
 * Sorted live-first, then soonest-starting. `now` is injectable so polling can
 * re-derive against the current instant (and tests can pin a fixed clock).
 */
export function classifyLiveUpcoming(
  source: ArkEvent[],
  now: Date = new Date(),
): EventWithStatus[] {
  const ms = now.getTime();
  return source
    .map((event): EventWithStatus | null => {
      const start = new Date(event.startsAt).getTime();
      if (Number.isNaN(start)) return null;
      const end = start + event.durationMinutes * 60 * 1000;
      if (ms >= end) return null;
      return { event, status: ms >= start ? "live" : "upcoming" };
    })
    .filter((x): x is EventWithStatus => x !== null)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "live" ? -1 : 1;
      return (
        new Date(a.event.startsAt).getTime() -
        new Date(b.event.startsAt).getTime()
      );
    });
}

export function liveAndUpcomingEvents(now: Date = new Date()): EventWithStatus[] {
  return classifyLiveUpcoming(events, now);
}

export function formatEventStart(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
