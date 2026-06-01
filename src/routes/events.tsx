import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import {
  circleEventLink,
  fetchUpcomingEvents,
} from "../lib/circle";
import { formatEventStart, type ArkEvent } from "../data/events";

export const Route = createFileRoute("/events")({
  component: EventsPage,
});

const FORMAT_LABEL: Record<ArkEvent["format"], string> = {
  "audio-room": "Audio room",
  "video-ama": "Video AMA",
  "watch-party": "Watch party",
  "in-person": "In person",
};

function EventsPage() {
  const [events, setEvents] = useState<ArkEvent[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchUpcomingEvents().then((e) => live && setEvents(e));
    return () => {
      live = false;
    };
  }, []);

  return (
    <PageShell
      title="Live conversations, in person and online."
      lede="Audio rooms, AMAs, watch parties, and the occasional gathering in New York or Tel Aviv. Most events live in the Ark+ community; some are open to all."
    >
      <section>
        <div className="page-section">
          <h2 className="label text-cyan">
            Upcoming
          </h2>
          {events === null ? (
            <p className="mt-8 text-body-sm" role="status">Loading…</p>
          ) : events.length === 0 ? (
            <p className="mt-8 text-body-sm">
              No upcoming events on the calendar — check back soon.
            </p>
          ) : (
            <ul className="mt-10 divide-y divide-rule border-y border-rule">
              {events.map((e) => (
                <li key={e.id} className="py-6">
                  <EventRow event={e} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </PageShell>
  );
}

function EventRow({ event }: { event: ArkEvent }) {
  const isMemberOnly = event.access === "ark-plus";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-8">
      <div className="lg:col-span-3">
        <div className="label text-cyan">
          {formatEventStart(event.startsAt)}
        </div>
        <p className="mt-2 meta">
          {FORMAT_LABEL[event.format]}
          {event.venue ? ` · ${event.venue}` : ""}
        </p>
      </div>
      <div className="lg:col-span-6">
        <h3 className="text-h3 leading-tight">
          {event.title}
        </h3>
        <p className="mt-2 text-body-sm">
          {event.description}
        </p>
        <p className="mt-2 meta">
          with {event.hosts.join(" · ")}
        </p>
      </div>
      <div className="lg:col-span-3 lg:text-right">
        <span
          className={`inline-block border px-2 py-0.5 label ${
            isMemberOnly
              ? "border-cyan/60 text-cyan"
              : "border-rule-strong text-fg-muted"
          }`}
        >
          {isMemberOnly ? "Ark+ only" : "Open to all"}
        </span>
        <a
          href={circleEventLink()}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 button-text inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {isMemberOnly ? "Open in the app" : "RSVP in the app"} →
        </a>
      </div>
    </div>
  );
}
