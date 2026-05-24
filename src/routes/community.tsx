import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import {
  CIRCLE_OPEN_LINKS,
  circleEventLink,
  fetchPublicBroadcasts,
  fetchUpcomingEvents,
} from "../lib/circle";
import type { CommunityBroadcast } from "../data/communityBroadcasts";
import { formatEventStart, type ArkEvent } from "../data/events";
import { useSubscriberAuth } from "../lib/subscriberAuth";

const EVENT_FORMAT_LABEL: Record<ArkEvent["format"], string> = {
  "audio-room": "Audio room",
  "video-ama": "Video AMA",
  "watch-party": "Watch party",
  "in-person": "In person",
};

export const Route = createFileRoute("/community")({
  component: CommunityPage,
});

function CommunityPage() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();
  const [broadcasts, setBroadcasts] = useState<CommunityBroadcast[] | null>(null);
  const [events, setEvents] = useState<ArkEvent[] | null>(null);

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, navigate]);

  useEffect(() => {
    let live = true;
    void fetchPublicBroadcasts()
      .then((b) => live && setBroadcasts(b))
      .catch(() => live && setBroadcasts([]));
    void fetchUpcomingEvents()
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, []);

  if (state.kind === "loading" || state.kind === "guest") return null;

  return (
    <PageShell
      eyebrow="Community"
      title="The room behind the show."
      lede="Dan, Donniel, and Yossi in conversation with members — on the day's news, the week's reading, and what didn't make the cut. In the Circle app."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              What happens in the community
            </h2>
            <ul className="mt-8 space-y-5 text-[14.5px] leading-[1.7] text-fg">
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-fg-strong">Episode discussion threads.</strong>{" "}
                  When an episode drops, members talk it through with the host
                  in the thread. Often the hosts post things that didn't make
                  the cut.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-fg-strong">Live audio rooms.</strong>{" "}
                  Weekly conversations on the Knesset, the polls, and the news.
                  Recorded and posted for members who couldn't make it live.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-fg-strong">Member-organized meetups.</strong>{" "}
                  Coffee mornings in Jerusalem, dinners in New York,
                  walking-and-talking in London — all started by members.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-fg-strong">Long-form posts.</strong>{" "}
                  Members write, often well, often at length. The best of it
                  finds its way into the next show.
                </span>
              </li>
            </ul>
          </div>
          <div className="lg:col-span-5">
            <div className="border border-rule bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Open in the Circle app
              </div>
              <p className="mt-4 text-[14px] leading-[1.6] text-fg">
                Members open the community in the Circle app — iOS, Android, or
                the web. Sign in with your Ark+ account; no second login.
              </p>
              <div className="mt-6 flex flex-col gap-3">
                <a
                  href={CIRCLE_OPEN_LINKS.ios}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Open on iOS
                </a>
                <a
                  href={CIRCLE_OPEN_LINKS.android}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-rule-strong px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Open on Android
                </a>
                <a
                  href={CIRCLE_OPEN_LINKS.web}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-rule-strong px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Open on web
                </a>
              </div>
              <p className="mt-6 text-[12px] leading-snug text-fg-muted">
                Not yet a member?{" "}
                <Link to="/plus" className="text-cyan underline-offset-4 hover:underline">
                  See Ark+
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex items-end justify-between gap-6">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Upcoming events
              </h2>
              <p className="mt-3 max-w-2xl text-[13px] text-fg-muted">
                Audio rooms, AMAs, watch parties, and the occasional gathering
                in New York or Tel Aviv. Most live in the Ark+ community.
              </p>
            </div>
            <Link
              to="/events"
              className="hidden shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted transition hover:text-cyan sm:inline"
            >
              See all events →
            </Link>
          </div>
          {events === null ? (
            <p className="mt-8 text-[14px] text-fg-muted" role="status">Loading…</p>
          ) : events.length === 0 ? (
            <p className="mt-8 text-[14px] text-fg-muted">
              Nothing on the calendar right now — check back soon.
            </p>
          ) : (
            <ul className="mt-10 divide-y divide-rule border-y border-rule">
              {events.slice(0, 4).map((e) => (
                <li key={e.id} className="py-6">
                  <CommunityEventRow event={e} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            From the room — selected member posts
          </h2>
          <p className="mt-3 max-w-2xl text-[13px] text-fg-muted">
            Posts members chose to share publicly.
          </p>
          {broadcasts === null ? (
            <p className="mt-8 text-[14px] text-fg-muted" role="status">Loading…</p>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {broadcasts.map((b) => (
                <article
                  key={b.id}
                  className="flex flex-col gap-4 border border-rule bg-navy-800/40 p-6"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                    {b.authorName} · {b.authorRole}
                  </div>
                  <p className="font-display text-[18px] leading-[1.25] text-fg-strong">
                    {b.excerpt}
                  </p>
                  <p className="text-[13px] leading-[1.6] text-fg-muted">
                    {b.body}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </PageShell>
  );
}

function CommunityEventRow({ event }: { event: ArkEvent }) {
  const isMemberOnly = event.access === "ark-plus";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-8">
      <div className="lg:col-span-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          {formatEventStart(event.startsAt)}
        </div>
        <p className="mt-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
          {EVENT_FORMAT_LABEL[event.format]}
          {event.venue ? ` · ${event.venue}` : ""}
        </p>
      </div>
      <div className="lg:col-span-7">
        <h3 className="font-display text-[18px] leading-tight text-fg-strong">
          {event.title}
        </h3>
        <p className="mt-2 text-[13px] leading-[1.6] text-fg-muted">
          with {event.hosts.join(" · ")}
        </p>
      </div>
      <div className="lg:col-span-2 lg:text-right">
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
          className="mt-3 inline-flex items-center gap-2 border border-rule-strong px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {isMemberOnly ? "Open in Circle" : "RSVP"} →
        </a>
      </div>
    </div>
  );
}
