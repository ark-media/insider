import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { ContentError } from "../components/ContentError";
import {
  fetchActivityDigest,
  fetchCommunityFeed,
  fetchEventStrip,
  fetchSuggestedSpaces,
  type ActivityDigest,
  type CommunityFeedItem,
  type EventStripItem,
  type SuggestedSpace,
} from "../lib/circle";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";
import { CommunityFeed } from "../components/community/CommunityFeed";
import { LiveEventsStrip } from "../components/community/LiveEventsStrip";
import { CommunityAppLinks } from "../components/CommunityAppLinks";

export const Route = createFileRoute("/community")({
  component: CommunityPage,
});

function CommunityPage() {
  const { state } = useSubscriberAuth();

  // The community lives in the Community app, open to Ark+ members. Signed-in
  // subscribers get a personalized read-only feed; everyone else sees the
  // marketing showcase with a join CTA.
  if (state.kind === "loading") return null;

  const isSubscriber = isArkPlusMember(state);

  return isSubscriber ? <SubscriberCommunity /> : <MarketingShowcase />;
}

/** Poll interval for live community data while the tab is visible. */
const POLL_MS = 45_000;

/**
 * Fetch the subscriber feed on load and re-poll ~every 45s while the tab is
 * visible (no websockets — see SPEC). Each poll re-derives live event status
 * against the current instant, so an event going live appears within ~45s.
 */
type CommunityData = {
  events: EventStripItem[];
  feed: CommunityFeedItem[];
  digest: ActivityDigest | null;
  spaces: SuggestedSpace[];
};

function useCommunityData() {
  const [data, setData] = useState<CommunityData | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">(
    "loading",
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;

    // Full load: everything. Used on mount and when the tab is refocused (the
    // feed/spaces may have changed while it was hidden). Any fetch rejecting
    // (Circle unreachable / errored) surfaces the error+retry card.
    const load = async () => {
      try {
        const [events, feed, digest, spaces] = await Promise.all([
          fetchEventStrip(),
          fetchCommunityFeed(),
          fetchActivityDigest(),
          fetchSuggestedSpaces(),
        ]);
        if (!alive) return;
        setData({ events, feed, digest, spaces });
        setStatus("ready");
      } catch {
        if (alive) setStatus("error");
      }
    };

    // The 45s poll only refreshes events — that's the sole surface whose live
    // state changes minute-to-minute; re-fetching the feed/spaces every tick is
    // wasted work. A failed poll surfaces the error so a section that dies
    // mid-session doesn't keep showing stale data silently.
    const loadEvents = async () => {
      try {
        const events = await fetchEventStrip();
        if (alive) setData((prev) => (prev ? { ...prev, events } : prev));
      } catch {
        if (alive) setStatus("error");
      }
    };

    void load();

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void loadEvents();
    }, POLL_MS);
    // Catch up fully when the tab is refocused after being hidden.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nonce]);

  // Reset to loading here (in the handler, not the effect) so retry shows the
  // loading state without the effect resetting on every tab refocus.
  const retry = useCallback(() => {
    setStatus("loading");
    setData(null);
    setNonce((n) => n + 1);
  }, []);

  return { data, status, retry };
}

function SubscriberCommunity() {
  const { data, status, retry } = useCommunityData();

  return (
    <PageShell
      title="Welcome back to the room."
      lede="What's live, what's happening, and what the community is talking about right now. Jump in — every conversation continues in the app."
      aside={<CommunityAppLinks />}
    >
      {status === "error" ? (
        <section>
          <div className="page-gutter py-10">
            <ContentError
              message="We couldn't load your community feed. Refresh to try again."
              onRetry={retry}
            />
          </div>
        </section>
      ) : (
        <section>
          <div className="page-gutter flex flex-col gap-10 py-10">
            <div>
              <h2 className="label text-cyan">Live &amp; upcoming</h2>
              <div className="mt-6">
                <LiveEventsStrip items={data?.events ?? null} />
              </div>
            </div>

            <div>
              <h2 className="label text-cyan">From the community</h2>
              <div className="mt-6">
                <CommunityFeed
                  items={data?.feed ?? null}
                  digest={data?.digest ?? null}
                  spaces={data?.spaces ?? null}
                />
              </div>
            </div>
          </div>
        </section>
      )}
    </PageShell>
  );
}

function MarketingShowcase() {
  return (
    <PageShell
      title="The room behind the show — in the app."
      lede="Our Community app puts your hosts and other Ark+ members in the room with you: weekly Q&As, live conversations, and thousands of members talking through the day's news. On iOS, Android, and the web."
      aside={<CommunityAppLinks />}
    >
      <section>
        <div className="page-gutter flex flex-col gap-12 py-12 sm:py-16">
          <FeatureBlock
            no="01"
            title="Inside Call Me Back"
            kicker="Weekly Q&As with your favorite Ark Media hosts."
            body="Ask questions. Get actual answers - not a comments section, not a bot. Bring what's on your mind to the people making the show."
            mockup={<QAScreen />}
          />
          <FeatureBlock
            no="02"
            flip
            title="Community Connection"
            kicker="Join conversations with thousands of other members."
            body="The room keeps going between episodes - members debating the news, sharing what they're reading, and starting meetups in their own cities."
            mockup={<FeedScreen />}
          />
          {/* Placeholders — the feature lineup isn't settled yet. Swap the title,
              copy, and mockup as features are confirmed; drop the `badge` to
              promote one to a finalized block. */}
          <FeatureBlock
            no="03"
            badge="Coming soon"
            title="Placeholder feature"
            kicker="Another community feature will live here."
            body="We're still settling the lineup. This slot is reserved for the next app feature once it's confirmed."
            mockup={<PlaceholderScreen label="Feature 03" />}
          />
          <FeatureBlock
            no="04"
            flip
            badge="Coming soon"
            title="Placeholder feature"
            kicker="And one more, to be decided."
            body="A second reserved slot. Same pattern as the blocks above — headline, supporting line, and an app screen."
            mockup={<PlaceholderScreen label="Feature 04" />}
          />
        </div>
      </section>

      <section>
        <div className="page-gutter pb-16">
          <div className="border border-rule bg-navy-800/40 p-8 sm:p-12">
            <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
              <div className="lg:col-span-7">
                <h2 className="max-w-xl">
                  <span className="display-upright block text-[clamp(1.6rem,3.2vw,2.4rem)] text-fg-strong">
                    The community is open to Ark+ members.
                  </span>
                </h2>
                <p className="mt-6 max-w-xl text-body-sm">
                  One Ark+ membership is your way in — the same account opens the
                  app on iOS, Android, and the web. No fragmented platforms, no
                  separate password.
                </p>
              </div>
              <div className="lg:col-span-5">
                <div className="flex flex-col gap-3">
                  <Link
                    to="/plus"
                    hash="pricing"
                    className="inline-flex items-center justify-center border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    Join Ark+
                  </Link>
                  <Link
                    to="/plus/gift"
                    className="inline-flex items-center justify-center border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    Gift Ark+
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function FeatureBlock({
  no,
  title,
  kicker,
  body,
  mockup,
  flip,
  badge,
}: {
  no: string;
  title: string;
  kicker: string;
  body: string;
  mockup: ReactNode;
  flip?: boolean;
  badge?: string;
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12 lg:gap-16">
      <div className={flip ? "lg:order-2 lg:col-span-6" : "lg:col-span-6"}>
        <div className="flex items-center gap-3">
          <span className="display-upright text-[20px] text-cyan sm:text-[22px]">
            {no}
          </span>
          {badge ? (
            <span className="rounded-full border border-rule-strong px-2.5 py-0.5 label text-fg-muted">
              {badge}
            </span>
          ) : null}
        </div>
        <h2 className="mt-4 max-w-xl">
          <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)] text-fg-strong">
            {title}
          </span>
        </h2>
        <p className="mt-6 max-w-md font-display text-[clamp(1.05rem,1.6vw,1.3rem)] font-bold leading-snug text-cyan">
          {kicker}
        </p>
        <p className="mt-4 max-w-md text-body-sm">{body}</p>
      </div>
      <div
        className={
          flip
            ? "flex justify-center lg:order-1 lg:col-span-6"
            : "flex justify-center lg:col-span-6"
        }
      >
        <PhoneFrame>{mockup}</PhoneFrame>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   App mockups. These render with fixed dark colors (not theme tokens) so they
   read as real app screenshots in both the light and dark site themes. Swap the
   inner screens for actual captures when we have them.
--------------------------------------------------------------------------- */

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate w-[270px] shrink-0 sm:w-[300px]">
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-cyan/10 blur-2xl" />
      <div className="relative aspect-[9/19] overflow-hidden rounded-[2.6rem] border border-white/15 bg-[#0b153c] p-2 shadow-2xl ring-1 ring-black/50">
        <div className="relative h-full w-full overflow-hidden rounded-[2.1rem] bg-[#0b153c]">
          {/* notch */}
          <div className="absolute left-1/2 top-[10px] z-20 h-[22px] w-[96px] -translate-x-1/2 rounded-full bg-black/70" />
          {children}
        </div>
      </div>
    </div>
  );
}

function PlaceholderScreen({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col text-white">
      <StatusBar />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-white/25 text-[18px] text-white/40">
          +
        </span>
        <div>
          <div className="text-[13px] font-bold text-white/80">{label}</div>
          <div className="mt-1 text-[11px] text-white/45">Screen TBD</div>
        </div>
        <div className="mt-2 flex w-full max-w-[180px] flex-col gap-2">
          <span className="h-2.5 w-full rounded-full bg-white/[0.06]" />
          <span className="h-2.5 w-4/5 rounded-full bg-white/[0.06]" />
          <span className="h-2.5 w-3/5 rounded-full bg-white/[0.06]" />
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="flex items-center justify-between px-5 pt-3 text-[11px] font-semibold text-white/90">
      <span>9:41</span>
      <div className="flex items-center gap-1.5">
        <span className="flex items-end gap-[2px]">
          <span className="h-[5px] w-[3px] rounded-sm bg-white/90" />
          <span className="h-[7px] w-[3px] rounded-sm bg-white/90" />
          <span className="h-[9px] w-[3px] rounded-sm bg-white/90" />
          <span className="h-[11px] w-[3px] rounded-sm bg-white/40" />
        </span>
        <span className="ml-0.5 flex h-[11px] w-[20px] items-center rounded-[3px] border border-white/60 px-[2px]">
          <span className="h-[6px] w-[12px] rounded-[1px] bg-white/90" />
        </span>
      </div>
    </div>
  );
}

function Initials({ name, bg }: { name: string; bg: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-[#0b153c]"
      style={{ background: bg }}
    >
      {initials}
    </span>
  );
}

function QAScreen() {
  return (
    <div className="flex h-full flex-col text-white">
      <StatusBar />
      {/* header */}
      <div className="mt-5 flex items-center gap-3 border-b border-white/10 px-5 pb-4">
        <img
          src="/hosts/dan-senor.jpg"
          alt=""
          className="h-9 w-9 rounded-full object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold text-white/95">
            Call Me Back
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-white/55">
            <span className="inline-block h-[6px] w-[6px] rounded-full bg-[#3eb5f9]" />
            Live Q&A · with Dan Senor
          </div>
        </div>
        <span className="rounded-full bg-[#3eb5f9] px-2 py-[3px] text-[9px] font-bold uppercase tracking-wide text-[#0b153c]">
          Live
        </span>
      </div>

      {/* thread */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
        <div className="flex items-start gap-2">
          <Initials name="Rachel B" bg="#f2b705" />
          <div className="rounded-2xl rounded-tl-sm bg-white/[0.07] px-3 py-2">
            <div className="text-[10px] font-semibold text-white/60">
              Rachel B.
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-white/90">
              What are you watching for in tonight's coalition vote?
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <img
            src="/hosts/dan-senor.jpg"
            alt=""
            className="mt-0.5 h-7 w-7 rounded-full object-cover"
          />
          <div className="rounded-2xl rounded-tl-sm border border-[#3eb5f9]/40 bg-[#3eb5f9]/[0.12] px-3 py-2">
            <div className="text-[10px] font-bold text-[#3eb5f9]">
              Dan Senor · Host
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-white/95">
              Great question. Watch the smaller parties — that's where this
              actually gets decided. I'll break it down on Thursday's show.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <Initials name="Yossi M" bg="#7bd389" />
          <div className="rounded-2xl rounded-tl-sm bg-white/[0.07] px-3 py-2">
            <div className="text-[10px] font-semibold text-white/60">
              Yossi M.
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-white/90">
              Any chance of a guest from the negotiating room?
            </p>
          </div>
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-2">
          <span className="flex-1 text-[11px] text-white/45">
            Ask a question…
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3eb5f9] text-[12px] font-bold text-[#0b153c]">
            ↑
          </span>
        </div>
      </div>
    </div>
  );
}

function FeedScreen() {
  return (
    <div className="flex h-full flex-col text-white">
      <StatusBar />
      {/* header */}
      <div className="mt-5 flex items-center justify-between border-b border-white/10 px-5 pb-4">
        <div className="text-[15px] font-bold text-white/95">Community</div>
        <div className="flex items-center gap-1.5 text-[10px] text-white/55">
          <span className="inline-block h-[6px] w-[6px] rounded-full bg-[#7bd389]" />
          2,847 online
        </div>
      </div>

      {/* feed */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
        <FeedPost
          name="Maya L."
          bg="#f2b705"
          meta="Tel Aviv · 12m"
          text="Just finished today's episode. The point about the budget timeline reframed the whole thing for me."
          likes={48}
          replies={12}
        />
        <FeedPost
          name="David R."
          bg="#9d8df1"
          meta="New York · 1h"
          text="Anyone going to the listener meetup next week? Trying to coordinate a group from the Upper West Side."
          likes={31}
          replies={27}
        />
        <FeedPost
          name="Sarah K."
          bg="#7bd389"
          meta="London · 3h"
          text="Sharing the long-read Nadav mentioned — worth every minute."
          likes={64}
          replies={9}
        />
      </div>

      {/* tab bar */}
      <div className="flex items-center justify-around border-t border-white/10 px-4 py-3 text-[9px] font-semibold uppercase tracking-wide">
        <span className="text-[#3eb5f9]">Feed</span>
        <span className="text-white/45">Events</span>
        <span className="text-white/45">Rooms</span>
        <span className="text-white/45">Profile</span>
      </div>
    </div>
  );
}

function FeedPost({
  name,
  bg,
  meta,
  text,
  likes,
  replies,
}: {
  name: string;
  bg: string;
  meta: string;
  text: string;
  likes: number;
  replies: number;
}) {
  return (
    <div className="rounded-xl bg-white/[0.05] p-3">
      <div className="flex items-center gap-2">
        <Initials name={name} bg={bg} />
        <div>
          <div className="text-[11px] font-bold text-white/90">{name}</div>
          <div className="text-[9px] text-white/45">{meta}</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-white/85">{text}</p>
      <div className="mt-2 flex items-center gap-4 text-[10px] text-white/50">
        <span className="flex items-center gap-1">
          <span className="text-[#3eb5f9]">♥</span> {likes}
        </span>
        <span className="flex items-center gap-1">💬 {replies}</span>
      </div>
    </div>
  );
}
