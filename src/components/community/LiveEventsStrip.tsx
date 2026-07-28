import { circleEventLink, type EventStripItem } from "../../lib/circle";
import { formatEventStart, type ArkEvent } from "../../data/events";
import { OutboundLink } from "../OutboundLink";

const FORMAT_LABEL: Record<ArkEvent["format"], string> = {
  "audio-room": "Audio room",
  "video-ama": "Video AMA",
  "watch-party": "Watch party",
  "in-person": "In person",
};

/**
 * The live + upcoming events strip. Read-only: each card deep-links into the
 * the app to join or RSVP — nothing happens on the web. `items === null`
 * means still loading.
 */
export function LiveEventsStrip({ items }: { items: EventStripItem[] | null }) {
  if (items === null) {
    return (
      <p className="text-body-sm text-fg-muted" role="status">
        Loading events…
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-body-sm text-fg-muted">
        No live or upcoming events right now — we'll surface the next one here.
      </p>
    );
  }

  return (
    <ul className="flex gap-4 overflow-x-auto pb-2">
      {items.map(({ event, status }) => (
        <li key={event.id} className="w-[280px] shrink-0">
          <OutboundLink
            href={event.deepLink ?? circleEventLink()}
            platform="circle"
            placement={status === "live" ? "events_strip_live" : "events_strip_upcoming"}
            context={event.id}
            className="group flex h-full flex-col border border-rule bg-navy-800/40 p-5 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <div className="flex items-center gap-2">
              {status === "live" ? (
                <span className="inline-flex items-center gap-1.5 label text-cyan">
                  <span className="inline-block h-[7px] w-[7px] animate-pulse rounded-full bg-cyan" />
                  Live now
                </span>
              ) : (
                <span className="label text-fg-muted">
                  {formatEventStart(event.startsAt)}
                </span>
              )}
            </div>
            <h3 className="mt-3 text-h3 leading-tight text-fg-strong">
              {event.title}
            </h3>
            <p className="mt-2 meta">
              {event.formatLabel ?? FORMAT_LABEL[event.format]}
              {event.venue ? ` · ${event.venue}` : ""}
            </p>
            <p className="mt-auto pt-4 button-text font-display font-bold text-cyan">
              {status === "live" ? "Join in the app" : "Open in the app"} →
            </p>
          </OutboundLink>
        </li>
      ))}
    </ul>
  );
}
