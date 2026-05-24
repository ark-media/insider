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
      eyebrow="Events"
      title="Live conversations, in person and online."
      lede="Audio rooms, AMAs, watch parties, and the occasional gathering in New York or Tel Aviv. Most events live in the Ark+ community; some are open to all."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Upcoming
          </h2>
          {events === null ? (
            <p className="mt-8 text-[14px] text-fg-muted" role="status">Loading…</p>
          ) : events.length === 0 ? (
            <p className="mt-8 text-[14px] text-fg-muted">
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
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          {formatEventStart(event.startsAt)}
        </div>
        <p className="mt-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
          {FORMAT_LABEL[event.format]}
          {event.venue ? ` · ${event.venue}` : ""}
        </p>
      </div>
      <div className="lg:col-span-6">
        <h3 className="font-display text-[20px] leading-tight text-fg-strong">
          {event.title}
        </h3>
        <p className="mt-2 text-[13.5px] leading-[1.6] text-fg-muted">
          {event.description}
        </p>
        <p className="mt-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
          with {event.hosts.join(" · ")}
        </p>
      </div>
      <div className="lg:col-span-3 lg:text-right">
        <span
          className={`inline-block border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${
            isMemberOnly
              ? "border-cyan/60 text-cyan"
              : "border-rule-strong text-fg-muted"
          }`}
        >
          {isMemberOnly ? "Ark+ only" : "Open to all"}
        </span>
        <a
          href={circleEventLink(event.id)}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 inline-flex items-center gap-2 border border-cyan bg-cyan px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {isMemberOnly ? "Open in Circle" : "RSVP in Circle"} →
        </a>
      </div>
    </div>
  );
}
