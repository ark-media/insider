import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CommunityAppLinks } from "../components/CommunityAppLinks";
import { useEffect, useState, type ReactNode } from "react";
import { shows, getShow, type ShowSlug } from "../data/shows";
import { useShowDescriptions } from "../lib/useShowDescription";
import { LinkCard } from "../components/ContentCard";
import { formatPostDate, type NewsletterPost } from "../data/newsletters";
import { listPostsPublic } from "../lib/beehiiv";
import { fetchEventStrip, type EventStripItem } from "../lib/circle";
import { formatEventStart, type ArkEvent } from "../data/events";
import { LatestEpisodes } from "../components/LatestEpisodes";
import { NewsletterSignupForm } from "../components/NewsletterSignupForm";
import { ShowCover } from "../components/ShowCover";
import { Toast } from "../components/Toast";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";
import { useNewsletterSubscription } from "../lib/useNewsletterSubscription";

export const Route = createFileRoute("/")({
  // `?gift=complete` lands here after a gift checkout (both the inline flow and
  // Stripe's redirect-based return_url) so we can confirm it with a toast.
  // `gift` is optional — omit the key entirely when absent so the router doesn't
  // treat it as a required search param on every `Link to="/"`.
  validateSearch: (search: Record<string, unknown>): { gift?: "complete" } =>
    search.gift === "complete" ? { gift: "complete" } : {},
  component: HomePage,
});

// Shared CTA style for the feature bands — an outline button that fills cyan on
// hover. Distinct from the hero's solid CTA so these read as peer offerings, not
// a second call to the same action.
const bandCtaClass =
  "mt-7 inline-flex min-h-12 w-fit items-center gap-2 border border-rule-strong px-5 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

// ---------------------------------------------------------------------------
// Newsletter visual — styled to read like an actual email/newsletter: a navy
// masthead over a white "paper" body with a real issue (latest free ark-daily
// post). Fixed colors (not theme tokens) so it reads as a real email in both
// the light and dark site themes — the same convention the app mockups use.
// ---------------------------------------------------------------------------
function NewsletterVisual() {
  const [post, setPost] = useState<NewsletterPost | null>(null);

  useEffect(() => {
    let alive = true;
    void listPostsPublic("ark-daily").then((posts) => {
      if (alive && posts.length) setPost(posts[0]);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="relative isolate mx-auto w-full max-w-md">
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-cyan/10 blur-2xl" />
      <div className="overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
        {/* Masthead */}
        <div className="bg-navy px-6 py-6 text-center">
          <div className="text-[10px] font-semibold uppercase tracking-[0.32em] text-cyan">
            The Ark Media Newsletter
          </div>
          <div className="mt-2 font-display text-[26px] font-bold leading-none text-white">
            Ark Media
          </div>
          <div className="mx-auto mt-3 h-px w-10 bg-cyan/60" />
        </div>

        {/* Issue body — real latest issue, with an evergreen fallback. */}
        <div className="bg-white px-6 py-6">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[#0b153c]/45">
            {post ? formatPostDate(post.publishedAt) : "Weekly dispatch"}
          </div>
          <h4 className="mt-2 font-display text-[19px] font-bold leading-snug text-[#0b153c]">
            {post ? post.title : "This week from Ark Media"}
          </h4>
          <p className="mt-3 line-clamp-4 text-[12.5px] leading-relaxed text-[#0b153c]/65">
            {post
              ? post.excerpt
              : "The through-lines from this week's interviews — and what they tell us about the week ahead."}
          </p>
          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-navy px-4 py-2 text-[11px] font-bold text-white">
            Read the issue →
          </div>
        </div>

        {/* Email footer */}
        <div className="border-t border-black/[0.08] bg-[#f5f6f9] px-6 py-3 text-center text-[10px] text-[#0b153c]/40">
          You&apos;re reading the free weekly edition ·{" "}
          <span className="underline">Unsubscribe</span>
        </div>
      </div>
    </div>
  );
}

const FORMAT_LABEL: Record<ArkEvent["format"], string> = {
  "audio-room": "Audio room",
  "video-ama": "Video AMA",
  "watch-party": "Watch party",
  "in-person": "In person",
};

// A phone shell mirroring the app mockups on /community — fixed dark colors so
// it reads as a real screenshot in both themes. `bleed` top-anchors the device
// in a capped window that fades out at the bottom, so it reads as "rising into
// frame" instead of dominating the band with its full height.
function PhoneFrame({
  children,
  bleed = false,
}: {
  children: ReactNode;
  bleed?: boolean;
}) {
  const frame = (
    <div className="relative aspect-[9/19] overflow-hidden rounded-[2.4rem] border border-white/15 bg-[#0b153c] p-2 shadow-2xl ring-1 ring-black/50">
      <div className="relative h-full w-full overflow-hidden rounded-[2.1rem] bg-[#0b153c]">
        {/* notch */}
        <div className="absolute left-1/2 top-[10px] z-20 h-[20px] w-[88px] -translate-x-1/2 rounded-full bg-black/70" />
        {children}
      </div>
    </div>
  );
  return (
    <div className="relative isolate mx-auto w-[212px] shrink-0 sm:w-[232px]">
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-cyan/10 blur-2xl" />
      {bleed ? (
        <div className="relative h-[380px] overflow-hidden [-webkit-mask-image:linear-gradient(to_bottom,#000_70%,transparent)] [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]">
          {frame}
        </div>
      ) : (
        frame
      )}
    </div>
  );
}

function PhoneStatusBar() {
  return (
    <div className="flex items-center justify-between px-5 pt-3 text-[11px] font-semibold text-white/90">
      <span>9:41</span>
      <span className="ml-0.5 flex h-[11px] w-[20px] items-center rounded-[3px] border border-white/60 px-[2px]">
        <span className="h-[6px] w-[12px] rounded-[1px] bg-white/90" />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Community visual — the community app on a phone. Shows the next real
// live/upcoming event as an in-app card, with an evergreen fallback.
// ---------------------------------------------------------------------------
function CommunityVisual() {
  const [item, setItem] = useState<EventStripItem | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchEventStrip().then((items) => {
      if (alive && items.length) setItem(items[0]);
    });
    return () => {
      alive = false;
    };
  }, []);

  const ev = item?.event;
  const isLive = item?.status === "live";

  return (
    <PhoneFrame bleed>
      <div className="flex h-full flex-col text-white">
        <PhoneStatusBar />

        {/* App header */}
        <div className="flex items-center justify-between px-5 pt-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
              Ark+ Community
            </div>
            <div className="mt-0.5 text-[17px] font-bold">In the room</div>
          </div>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-[12px] font-bold">
            A
          </span>
        </div>

        {/* Live / upcoming event card */}
        <div className="mt-4 px-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-white/45">
            Live &amp; upcoming
          </div>
          <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.06] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white/55">
                {ev ? (ev.formatLabel ?? FORMAT_LABEL[ev.format]) : "Live room"}
              </span>
              {isLive ? (
                <span className="rounded-full bg-cyan px-2 py-[2px] text-[9px] font-bold uppercase tracking-wide text-navy">
                  Live
                </span>
              ) : (
                <span className="rounded-full border border-white/25 px-2 py-[2px] text-[9px] font-bold uppercase tracking-wide text-white/55">
                  Upcoming
                </span>
              )}
            </div>
            <div className="mt-2 line-clamp-2 text-[14px] font-bold leading-snug">
              {ev ? ev.title : "Live Q&A with the hosts"}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/60">
              <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-cyan" />
              {ev ? formatEventStart(ev.startsAt) : "This week"}
            </div>
            <div className="mt-3 w-full rounded-full bg-cyan py-2 text-center text-[11px] font-bold text-navy">
              {isLive ? "Join now" : "RSVP"}
            </div>
          </div>
        </div>

        {/* From-the-community snippet */}
        <div className="mt-4 flex-1 px-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-white/45">
            From the community
          </div>
          <div className="mt-2 flex items-start gap-2.5">
            <img
              src="/hosts/dan-senor.jpg"
              alt=""
              className="h-7 w-7 rounded-full object-cover"
            />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-white/85">
                Dan Senor
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/55">
                Thanks for all the questions on tonight&apos;s vote — recording
                the bonus segment now.
              </p>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center justify-around border-t border-white/10 px-6 py-3">
          <span className="h-[7px] w-[7px] rounded-full bg-cyan" />
          <span className="h-[7px] w-[7px] rounded-full bg-white/25" />
          <span className="h-[7px] w-[7px] rounded-full bg-white/25" />
        </div>
      </div>
    </PhoneFrame>
  );
}

// A small framed tile for the Ark+ "what's included" checklist. Uses theme
// tokens so it adapts to light and dark.
const plusIncludes = [
  "The ad-free paid feed",
  "Members-only newsletters",
  "The full network, ad-free",
];

function PlusVisual() {
  return (
    <div className="relative isolate mx-auto w-full max-w-sm">
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-cyan/10 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-rule bg-navy-800/40 p-6 shadow-xl">
        <div className="eyebrow text-[10px] text-cyan">Ark+ membership</div>
        <div className="mt-2 font-display text-[20px] font-bold text-fg-strong">
          Everything, included.
        </div>
        <ul className="mt-5 space-y-3">
          {plusIncludes.map((item) => (
            <li
              key={item}
              className="flex items-center gap-3 text-[13px] text-fg-muted"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan/15 text-cyan">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className="h-3 w-3"
                  aria-hidden="true"
                >
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero visual — the four show covers fanned like a deck, giving the hero a
// right-side anchor that mirrors the feature bands below. The covers are
// decorative here (the "Four shows" grid further down is the real browse path),
// so the stack is aria-hidden and not interactive. Each card rises in on its
// own delay, continuing the hero's staggered entrance.
// ---------------------------------------------------------------------------
const heroFan: {
  slug: ShowSlug;
  x: number;
  y: number;
  r: number;
  z: number;
}[] = [
  { slug: "for-heavens-sake", x: -52, y: -6, r: -14, z: 10 },
  { slug: "whats-your-number", x: 52, y: -2, r: 13, z: 20 },
  { slug: "ark-news-daily", x: -24, y: 12, r: -6, z: 30 },
  { slug: "call-me-back", x: 22, y: 6, r: 5, z: 40 },
];

function HeroShowStack() {
  return (
    // The whole deck rises in as a single unit (one `rise`, no per-card stagger)
    // so all four covers always appear together — never a partial 2-of-4 while
    // late-delayed cards are still fading in.
    <div
      aria-hidden="true"
      className="rise relative isolate mx-auto aspect-square w-full max-w-[340px] sm:max-w-[400px]"
    >
      <div className="absolute inset-[14%] -z-10 rounded-full bg-cyan/15 blur-3xl" />
      {heroFan.map(({ slug, x, y, r, z }) => {
        const show = getShow(slug);
        if (!show) return null;
        return (
          <div
            key={slug}
            className="absolute inset-0 flex items-center justify-center"
            style={{ zIndex: z }}
          >
            <div
              className="w-1/2 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/10"
              style={{ transform: `translate(${x}%, ${y}%) rotate(${r}deg)` }}
            >
              {/* Half the width of a deck capped at 340px (400px from `sm`). */}
              <ShowCover
                show={show}
                priority
                sizes="(min-width: 640px) 200px, 170px"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Each offering is its own top-level <section> so it picks up the page's zebra
// striping. Bands alternate sides via `flip` to give the stack rhythm — text and
// visual stay in reading order in the DOM (text first), and only their on-screen
// columns swap at `lg`, so mobile always leads with the copy. The newsletter band
// passes `action` (the inline signup form) in place of a CTA.
function FeatureBand({
  eyebrow,
  title,
  body,
  visual,
  cta,
  to,
  action,
  flip = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  visual: ReactNode;
  cta?: string;
  to?: string;
  action?: ReactNode;
  flip?: boolean;
}) {
  return (
    <section>
      <div className="page-section">
        <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
          <div className={`flex flex-col${flip ? " lg:order-2" : ""}`}>
            <div className="eyebrow text-[18px] text-cyan sm:text-[22px]">
              {eyebrow}
            </div>
            <h2 className="mt-3 display-upright text-[clamp(1.9rem,3.6vw,2.8rem)] leading-[1.04] text-fg-strong">
              {title}
            </h2>
            <p className="mt-5 max-w-md text-body-lg text-fg-muted">{body}</p>
            {action ? (
              <div className="mt-7 max-w-md">{action}</div>
            ) : cta && to ? (
              <Link to={to} className={bandCtaClass}>
                {cta} →
              </Link>
            ) : null}
          </div>
          <div className={`w-full${flip ? " lg:order-1" : ""}`}>{visual}</div>
        </div>
      </div>
    </section>
  );
}

function AlsoFromArkMedia() {
  const { state } = useSubscriberAuth();
  const { isSubscribed, prefsLoading } = useNewsletterSubscription();

  const isMember = state.kind === "member";
  // Guests and signed-in readers not on the Beehiiv list get the inline signup.
  // Beehiiv subscribers see a link to recent issues instead. While prefs load
  // for a member we withhold both so the form never flashes.
  const showSignup = !isMember || (!prefsLoading && !isSubscribed);

  return (
    <>
      <FeatureBand
        eyebrow="Newsletter"
        title="In your inbox."
        body="Subscribe to our newsletter and get new episodes every Friday."
        visual={<NewsletterVisual />}
        {...(showSignup
          ? { action: <NewsletterSignupForm slug="ark-daily" /> }
          : isMember && !prefsLoading
            ? { cta: "Read newsletters", to: "/newsletters" }
            : {})}
      />
      <FeatureBand
        eyebrow="Community"
        title="In the room."
        body="Nadav, Amit and Tal in conversation with members — in the Community app."
        visual={<CommunityVisual />}
        action={
          <div className="flex flex-col gap-5">
            <CommunityAppLinks />
            <Link
              to="/community"
              className="inline-flex min-h-11 w-fit items-center gap-2 button-text font-display font-bold text-cyan underline-offset-4 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Learn more →
            </Link>
          </div>
        }
        flip
      />
      <FeatureBand
        eyebrow="Ark+"
        title="All in."
        body="The paid feed and members-only newsletters. Add the community, or get both in the bundle."
        visual={<PlusVisual />}
        cta="Explore Ark+"
        to="/plus"
      />
    </>
  );
}

function HomePage() {
  const { gift } = Route.useSearch();
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();
  const descriptions = useShowDescriptions(shows.map((s) => s.slug));
  const isSubscriber = isArkPlusMember(state);
  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-8 pb-8 lg:pt-10">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div>
              <h1 className="max-w-4xl text-fg-strong">
                <span className="rise rise-2 display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
                  Connecting Jewish{" "}
                  <span className="display text-cyan">Voices</span>,
                </span>
                <span className="rise rise-3 display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
                  Near and Far.
                </span>
              </h1>
              <div
                aria-hidden="true"
                className="draw-rule mt-10 h-px w-24 origin-left bg-cyan"
                style={{ animationDelay: "0.7s" }}
              />
              <p className="rise rise-5 mt-8 max-w-2xl text-body-lg">
                Ark Media is a podcast network that explores the big questions
                shaping Jewish life, Israel's future, and our rapidly changing
                world. Through conversations with leading Jewish thinkers from
                around the world, Ark Media aims to build a global community
                driven by curiosity and meaningful dialogue.
              </p>
              <div
                className="rise mt-10 flex flex-wrap gap-3"
                style={{ animationDelay: "0.78s" }}
              >
                <Link
                  to={isSubscriber ? "/community" : "/plus"}
                  className="inline-flex min-h-12 items-center gap-2 border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  {isSubscriber ? "Explore community" : "Become an Ark+ member"}{" "}
                  →
                </Link>
              </div>
            </div>
            <div className="hidden lg:block">
              <HeroShowStack />
            </div>
          </div>
        </div>
      </section>

      <LatestEpisodes />

      {/* Podcast row — card grid (good for browsing) */}
      <section>
        <div className="page-section">
          <div className="flex items-end justify-between">
            <div>
              <div className="eyebrow text-[18px] sm:text-[22px]">Podcasts</div>
              <h2 className="mt-3 text-fg-strong">
                <span className="display-upright block text-[clamp(1.8rem,3.5vw,2.6rem)]">
                  Four shows.
                </span>
              </h2>
            </div>
            <Link
              to="/podcasts"
              className="hidden button-text font-semibold text-fg-muted transition hover:text-cyan sm:inline"
            >
              All podcasts →
            </Link>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-4">
            {shows.map((show) => (
              <LinkCard
                key={show.slug}
                to={show.route}
                title={show.title}
                body={descriptions[show.slug] || show.tagline}
                cta="Visit show"
                media={
                  // Two-up grid at every width; within the card the cover is
                  // full-width until `lg`, where CardBody splits it 50/50.
                  <ShowCover
                    show={show}
                    sizes="(min-width: 1024px) 25vw, 50vw"
                  />
                }
              />
            ))}
          </div>
        </div>
      </section>

      {/* Also from Ark Media — full-width feature bands giving the newsletter,
          community, and Ark+ offerings equal weight beside the podcasts */}
      <AlsoFromArkMedia />

      {gift === "complete" ? (
        <Toast
          message="Gift sent — we emailed your recipient a link to start their membership."
          onDismiss={() =>
            void navigate({
              to: "/",
              search: (() => ({})) as never,
              replace: true,
            })
          }
        />
      ) : null}
    </main>
  );
}
