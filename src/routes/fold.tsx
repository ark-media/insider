import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { ContentError } from "../components/ContentError";
import {
  fetchActivityDigest,
  fetchCommunityFeed,
  fetchEventStrip,
  fetchShowcasePosts,
  fetchSuggestedSpaces,
  type ActivityDigest,
  type CommunityFeedItem,
  type EventStripItem,
  type ShowcasePost,
  type SuggestedSpace,
} from "../lib/circle";
import { isCircleMember, useSubscriberAuth } from "../lib/subscriberAuth";
import { CommunityFeed } from "../components/community/CommunityFeed";
import { LiveEventsStrip } from "../components/community/LiveEventsStrip";
import { CommunityAppLinks } from "../components/CommunityAppLinks";
import { FoldLogo } from "../components/FoldLogo";
import { CheckoutModal } from "../components/CheckoutModal";
import { PriceSkeleton } from "../components/PriceSkeleton";
import { PlayGlyph } from "../components/PlayGlyph";
import { trackEvent } from "../lib/analytics";
import { formatMinor, toMajor } from "../lib/currency";
import { usePricing } from "../lib/usePricing";

export const Route = createFileRoute("/fold")({
  component: CommunityPage,
});

function CommunityPage() {
  const { state } = useSubscriberAuth();

  // The Fold lives on the `circle` axis (Circle or Bundle) — NOT arkPlus.
  // Members with Circle access get the personalized read-only feed; everyone
  // else (including Ark+-only members) sees the marketing showcase + join CTA.
  if (state.kind === "loading") return null;

  const hasCommunity = isCircleMember(state);

  return hasCommunity ? <SubscriberCommunity /> : <MarketingShowcase />;
}

/** Poll interval for live Fold data while the tab is visible. */
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
      brand={<FoldLogo className="h-9 sm:h-11" />}
      title="Real People, Real Conversations, Real Connection"
      lede="What's live, what's happening, and what the Fold is talking about right now. Jump in — every conversation continues in the app."
      aside={<CommunityAppLinks />}
      heroClassName="fold-bg grain-overlay overflow-hidden"
    >
      {status === "error" ? (
        <section>
          <div className="page-gutter py-10">
            <ContentError
              message="We couldn't load your Fold feed. Refresh to try again."
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
              <h2 className="label text-cyan">From the Fold</h2>
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
/* ---------------------------------------------------------------------------
   Marketing showcase — the public /fold page, shown to anyone without Circle
   access. It has one job: explain what the Fold is and sell a membership, so
   every band ends within reach of a join CTA.

   Prices are never hardcoded here: the Fold sells on the `circle` tier and the
   amounts come from Stripe via /api/pricing, same as the /plus card grid.
--------------------------------------------------------------------------- */

// The join card leads with a monthly price, so checkout opens on the monthly
// plan. Annual lives on /plus, linked under the card.
const MARKETING_PLAN = "monthly" as const;

// The hero headline runs to two full clauses, so it steps down from the default
// text-h1 scale to keep the whole lockup — logo, headline, CTA — above the fold.
const HERO_LINE = "text-[clamp(1.9rem,4vw,3rem)]";

function MarketingShowcase() {
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const pricing = usePricing();
  const data = pricing.status === "ready" ? pricing.data : null;
  const currency = data?.currency ?? "usd";
  const factor = data?.factor ?? 100;
  const foldMinor = data?.tiers.circle?.monthly[currency] ?? null;
  const bundleMinor = data?.tiers.bundle?.monthly[currency] ?? null;

  const openCheckout = useCallback(() => {
    trackEvent("checkout_opened", {
      plan: MARKETING_PLAN,
      tier: "circle",
      amount: foldMinor !== null ? toMajor(foldMinor, factor) : null,
      is_custom_amount: false,
    });
    setCheckoutOpen(true);
  }, [foldMinor, factor]);

  return (
    <>
      <PageShell
        brand={
          <div>
            <FoldLogo className="h-9 sm:h-11" />
            <p className="mt-7 label text-fg-muted">
              Ark Media curates. The members make it valuable.
            </p>
          </div>
        }
        title={
          <>
            <span className={`${HERO_LINE} block`}>
              A private community defined by{" "}
              <span className="display text-cyan">a shared curiosity</span>{" "}
              about the Jewish experience
            </span>
            <span className={`${HERO_LINE} mt-3 block`}>
              <span className="display text-cyan">
                and by great conversations with
              </span>{" "}
              people you haven't met yet…
            </span>
          </>
        }
        actions={
          <button type="button" onClick={openCheckout} className={JOIN_PRIMARY}>
            Join the Fold
          </button>
        }
        aside={
          // Art, not instruction — hidden on narrow screens the way the /plus
          // hero hides its cover, so the headline and CTA own the first screen.
          <div className="hidden lg:block">
            <PhoneFrame className="w-[250px]">
              <FeedScreen />
            </PhoneFrame>
          </div>
        }
        heroClassName="fold-bg grain-overlay overflow-hidden"
      >
        <WhatToPack />
        <InviteVideo />
        <InsideTheApp />
        <ThreeRooms onJoin={openCheckout} />
        <WhyDifferent />
        <StatementBand />
        <JoinCta
          status={pricing.status}
          foldMinor={foldMinor}
          bundleMinor={bundleMinor}
          currency={currency}
          factor={factor}
          onJoin={openCheckout}
        />
      </PageShell>

      <CheckoutModal
        open={checkoutOpen}
        plan={MARKETING_PLAN}
        tier="circle"
        onClose={() => setCheckoutOpen(false)}
      />
    </>
  );
}

/* --- Shared CTA styling ---------------------------------------------------
   Both variants keep the site's button contract: filled cyan inverts to an
   outline on hover, outlined cyan fills on hover. The class pairs matter —
   light mode swaps the fill to a deep navy via `.bg-cyan.text-navy` and
   `.hover\:bg-cyan.hover\:text-navy`, so don't split them apart.
-------------------------------------------------------------------------- */

const JOIN_BASE =
  "inline-flex min-h-12 items-center justify-center px-6 button-text font-display font-bold tracking-cta transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

const JOIN_PRIMARY = `${JOIN_BASE} border border-cyan bg-cyan text-navy hover:bg-transparent hover:text-cyan`;

const JOIN_SECONDARY = `${JOIN_BASE} border border-cyan text-cyan hover:bg-cyan hover:text-navy`;

/* --- Before you arrive ---------------------------------------------------- */

const PACKING_LIST = [
  "Encounter people whose experiences and perspectives are different from your own.",
  "Stay with important conversations long enough for them to deepen.",
  "Get to know the people behind the ideas.",
  "Bring your questions and convictions.",
];

function WhatToPack() {
  return (
    <section>
      <div className="page-gutter grid gap-10 py-14 sm:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <div className="label text-cyan">Before you arrive</div>
          <h2 className="mt-6 display-upright text-[clamp(2rem,4vw,3.2rem)] text-fg-strong">
            What to pack?
          </h2>
        </div>
        <ul className="border-b border-rule lg:col-span-7">
          {PACKING_LIST.map((item) => (
            <li key={item} className="border-t border-rule py-6 text-body-lg">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --- You are invited ------------------------------------------------------ */

function InviteVideo() {
  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <h2 className="display-upright text-center text-[clamp(2rem,4.4vw,3.2rem)] text-fg-strong">
          You are invited.
        </h2>
        {/* Placeholder frame until the captioned welcome video is supplied —
            swap the inner block for the <video> and drop the caption. */}
        <div className="mx-auto mt-10 flex aspect-video max-w-4xl flex-col items-center justify-center gap-5 border border-rule bg-navy-800/40">
          <span
            aria-hidden="true"
            className="flex size-16 items-center justify-center rounded-full bg-cyan text-navy"
          >
            <span className="ml-1 block scale-[2.2]">
              <PlayGlyph />
            </span>
          </span>
          <span className="meta px-6 text-center">
            Welcome video — captioned, to be supplied
          </span>
        </div>
      </div>
    </section>
  );
}

/* --- You might do inside the Fold app -------------------------------------
   Real posts, pulled live from the three conversational rooms in Circle via
   /api/circle/showcase. The grid used to be six hand-written samples.

   The "placeholders" caption below is deliberate and stays, even though the
   names and avatars under it are now real members. Hannah's call. Don't
   "correct" it to match the data — if it changes, it changes because the copy
   owner changed it.

   The cards deliberately do NOT link through to Circle. A visitor reading this
   section is not a member yet, so a click would land them on Circle's own
   login wall rather than our checkout — the Join CTAs are the way in.
-------------------------------------------------------------------------- */

function InsideTheApp() {
  const [posts, setPosts] = useState<ShowcasePost[] | null>(null);

  useEffect(() => {
    let alive = true;
    // fetchShowcasePosts never rejects — an outage arrives as an empty array.
    void fetchShowcasePosts().then((p) => {
      if (alive) setPosts(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Nothing real to show (still loading, Circle unreachable, or every room
  // genuinely empty) → no section at all. An empty grid under "You might do"
  // sells the community worse than silence does.
  if (!posts || posts.length === 0) return null;

  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <h2 className="display-upright max-w-3xl text-[clamp(2rem,4.4vw,3.2rem)]">
          <span className="block text-fg-strong">You might do</span>
          <span className="mt-2 block text-cyan">inside the Fold app:</span>
        </h2>
        <p className="meta mt-6">Member names and avatars are placeholders</p>

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The card's activity line. Replies are the signal worth leading with; likes
 * stand in when a post has none yet. A post with neither renders an empty
 * span, which keeps "Reply" pushed right by the row's justify-between.
 */
function activityLabel(post: ShowcasePost): string {
  if (post.replyCount > 0) {
    return post.replyCount === 1 ? "1 reply" : `${post.replyCount} replies`;
  }
  if (post.likeCount > 0) {
    return post.likeCount === 1 ? "1 like" : `${post.likeCount} likes`;
  }
  return "";
}

function PostCard({ post }: { post: ShowcasePost }) {
  return (
    <article className="flex flex-col border border-rule bg-navy-800/40 p-6">
      <div className="flex items-center gap-3">
        <Avatar name={post.authorName} src={post.authorAvatarUrl} />
        <div className="min-w-0">
          <div className="text-h6">{post.authorName}</div>
          {post.authorLocation ? (
            <div className="text-body-sm">{post.authorLocation}</div>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <RoomChip name={post.roomName} />
      </div>

      <p className="mt-4 grow text-body">{post.text}</p>

      <div className="mt-6 flex items-center justify-between border-t border-rule pt-4 text-body-sm">
        <span>{activityLabel(post)}</span>
        {/* Illustrative app UI, not a control — the real Reply lives in the app. */}
        <span>Reply</span>
      </div>
    </article>
  );
}

/**
 * The member's Circle avatar, falling back to their initial. Circle serves
 * avatars from signed active_storage redirects, so a URL that has gone stale
 * drops back to the initial rather than leaving a broken image on the page.
 */
function Avatar({ name, src }: { name: string; src?: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-navy-600/80 text-sm font-bold text-fg-strong"
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}

// Rooms read as outlined cyan tags, labelled with the space's own Circle name
// so renaming a room in Circle renames it here.
function RoomChip({ name }: { name: string }) {
  return (
    <span className="shrink-0 border border-cyan/40 px-2.5 py-1 label text-cyan">
      {name}
    </span>
  );
}

/* --- Three rooms, one community ------------------------------------------- */

const ROOMS = [
  {
    title: "The Conversation",
    tagline: "Think together",
    body: "Discussion, debate, reflection, and sensemaking.",
  },
  {
    title: "Ask & Share",
    tagline: "Help each other",
    body: "Questions, recommendations, resources, and advice.",
  },
  {
    title: "The Lounge",
    tagline: "Enjoy each other",
    body: "Culture, humor, personal stories, and everyday Jewish life.",
  },
];

function ThreeRooms({ onJoin }: { onJoin: () => void }) {
  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="label text-cyan">Three rooms, one community</h2>
          <button type="button" onClick={onJoin} className={JOIN_SECONDARY}>
            Join the Fold
          </button>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {ROOMS.map((room) => (
            <div
              key={room.title}
              className="border border-rule bg-navy-800/40 p-7 sm:p-8"
            >
              <h3 className="display-upright text-[clamp(1.5rem,2.4vw,1.9rem)] text-fg-strong">
                {room.title}
              </h3>
              <p className="mt-3 font-display text-lg italic text-cyan">
                {room.tagline}
              </p>
              <p className="mt-4 text-body">{room.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --- What makes the Fold different ---------------------------------------- */

function WhyDifferent() {
  return (
    <section>
      <div className="page-gutter grid gap-10 py-14 sm:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-6">
          <div className="label text-cyan">What makes the Fold different</div>
          <h2 className="mt-6 max-w-md display-upright text-[clamp(2rem,4vw,3.2rem)] text-fg-strong">
            Good conversation does not happen by accident.
          </h2>
        </div>

        <div className="lg:col-span-6">
          <p className="text-body-lg">
            We're building the Fold with the same standards that shape Ark's
            conversations: curiosity, substance, intellectual honesty, and the
            ability to disagree in good faith.
          </p>
          <p className="mt-6 text-body-lg">
            The Fold is for you if you care more about understanding than
            winning.
          </p>
          <div className="mt-8 h-px bg-cyan" />
          <p className="mt-8 font-display text-lg font-bold text-fg-strong">
            We expect your grace and welcome your grit.
          </p>
        </div>
      </div>
    </section>
  );
}

/* --- Closing statement ----------------------------------------------------- */

function StatementBand() {
  return (
    <section>
      <div className="page-gutter py-16 sm:py-24">
        {/* A statement, not a section heading — kept out of the outline so the
            page's heading structure stays meaningful. */}
        <p className="display-upright text-[clamp(1.5rem,3.6vw,3rem)] text-fg-strong">
          <span className="block">There are more people worth knowing.</span>
          <span className="mt-3 block">More perspectives worth hearing.</span>
          <span className="display mt-3 block text-cyan">
            More conversations worth having.
          </span>
        </p>
      </div>
    </section>
  );
}

/* --- Join the Fold --------------------------------------------------------- */

function JoinCta({
  status,
  foldMinor,
  bundleMinor,
  currency,
  factor,
  onJoin,
}: {
  status: "loading" | "error" | "ready";
  foldMinor: number | null;
  bundleMinor: number | null;
  currency: string;
  factor: number;
  onJoin: () => void;
}) {
  // A pricing outage must not take the join CTA down with it — checkout fetches
  // its own prices, so the card drops the amounts and keeps the button.
  const priced = status !== "error";

  return (
    <section>
      <div className="page-gutter py-14 text-center sm:py-20">
        <div className="flex justify-center">
          <FoldLogo className="h-10 sm:h-12" />
        </div>
        <h2 className="mt-8 display-upright text-[clamp(2rem,4.4vw,3.2rem)] text-fg-strong">
          Join the Fold
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-body-lg">
          A private community from Ark Media, for people who take these
          questions seriously.
        </p>

        <div className="mx-auto mt-12 max-w-2xl border border-rule bg-navy-800/40 p-7 text-left sm:p-9">
          <div className="flex items-baseline justify-between gap-4">
            <div className="label text-cyan">Membership</div>
            {priced ? <div className="meta">Starting at</div> : null}
          </div>

          {priced ? (
            <>
              <div className="mt-5 flex items-baseline gap-2 text-fg-strong">
                <span className="display-upright text-[clamp(2.4rem,6vw,3.2rem)] leading-none">
                  {foldMinor !== null ? (
                    formatMinor(foldMinor, currency, factor)
                  ) : (
                    <PriceSkeleton className="h-[0.7em] w-28" />
                  )}
                </span>
                <span className="text-body-sm">/ month</span>
              </div>

              <div className="mt-6 border-t border-rule pt-6 text-body">
                {bundleMinor !== null ? (
                  <>
                    <span className="font-bold text-fg-strong">
                      {formatMinor(bundleMinor, currency, factor)} / month
                    </span>{" "}
                    when you bundle it with Ark+
                  </>
                ) : (
                  <PriceSkeleton className="h-4 w-56" />
                )}
              </div>
            </>
          ) : null}

          <button
            type="button"
            onClick={onJoin}
            className={`${JOIN_PRIMARY} mt-8 w-full`}
          >
            Join the Fold
          </button>

          <div className="mt-5 text-center">
            <Link to="/plus" className="episode-action hover:underline">
              See all membership options
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   App mockup. Renders with fixed dark colors (not theme tokens) so it reads as
   a real app screenshot in both the light and dark site themes. Swap the inner
   screen for an actual capture when we have one.
--------------------------------------------------------------------------- */
function PhoneFrame({
  children,
  className = "w-[270px] sm:w-[300px]",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative isolate shrink-0 ${className}`}>
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

function FeedScreen() {
  return (
    <div className="flex h-full flex-col text-white">
      <StatusBar />
      {/* header */}
      <div className="mt-5 flex items-center justify-between border-b border-white/10 px-5 pb-4">
        <div className="text-[15px] font-bold text-white/95">The Fold</div>
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
