import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import {
  CIRCLE_OPEN_LINKS,
  fetchPublicBroadcasts,
} from "../lib/circle";
import type { CommunityBroadcast } from "../data/communityBroadcasts";
import { useSubscriberAuth } from "../lib/subscriberAuth";

export const Route = createFileRoute("/community")({
  component: CommunityPage,
});

function CommunityPage() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();
  const [broadcasts, setBroadcasts] = useState<CommunityBroadcast[] | null>(null);

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
    return () => {
      live = false;
    };
  }, []);

  if (state.kind === "loading" || state.kind === "guest") return null;

  return (
    <PageShell
      eyebrow="Community"
      title="The room behind the show."
      lede="The Ark+ community lives in the Circle app — Dan, Donniel, and Yossi in conversation with members on the day's news, the week's reading, and what didn't make the cut."
    >
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              What happens in the community
            </div>
            <ul className="mt-8 space-y-5 text-[14.5px] leading-[1.7] text-white/80">
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-white">Episode discussion threads.</strong>{" "}
                  When an episode drops, members talk it through with the host
                  in the thread. Often the hosts post things that didn't make
                  the cut.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-white">Live audio rooms.</strong>{" "}
                  Weekly conversations on the Knesset, the polls, and the news.
                  Recorded and posted for members who couldn't make it live.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-white">Member-organized meetups.</strong>{" "}
                  Coffee mornings in Jerusalem, dinners in New York,
                  walking-and-talking in London — all started by members.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="mt-[10px] h-px w-5 bg-cyan" />
                <span>
                  <strong className="text-white">Long-form posts.</strong>{" "}
                  Members write, often well, often at length. The best of it
                  finds its way into the next show.
                </span>
              </li>
            </ul>
          </div>
          <div className="lg:col-span-5">
            <div className="border border-white/15 bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Open in the Circle app
              </div>
              <p className="mt-4 text-[14px] leading-[1.6] text-white/70">
                Members open the community in the Circle app — iOS, Android, or
                the web. Sign in with your Ark+ account; no second login.
              </p>
              <div className="mt-6 flex flex-col gap-3">
                <a
                  href={CIRCLE_OPEN_LINKS.ios}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
                >
                  Open on iOS
                </a>
                <a
                  href={CIRCLE_OPEN_LINKS.android}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-white/25 px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan"
                >
                  Open on Android
                </a>
                <a
                  href={CIRCLE_OPEN_LINKS.web}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center justify-center border border-white/25 px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan"
                >
                  Open on web
                </a>
              </div>
              <p className="mt-6 text-[12px] leading-snug text-white/45">
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

      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            From the room — selected member posts
          </div>
          <p className="mt-3 max-w-2xl text-[13px] text-white/55">
            Posts members chose to share publicly.
          </p>
          {broadcasts === null ? (
            <p className="mt-8 text-[14px] text-white/45">Loading…</p>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {broadcasts.map((b) => (
                <article
                  key={b.id}
                  className="flex flex-col gap-4 border border-white/12 bg-navy-800/40 p-6"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                    {b.authorName} · {b.authorRole}
                  </div>
                  <p className="font-display text-[18px] leading-[1.25] text-white">
                    {b.excerpt}
                  </p>
                  <p className="text-[13px] leading-[1.6] text-white/65">
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
