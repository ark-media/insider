import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { shows } from "../data/shows";
import { useShowDescriptions } from "../lib/useShowDescription";
import { LinkCard, NumberedRow } from "../components/ContentCard";
import { LatestEpisodes } from "../components/LatestEpisodes";
import { NewsletterSignupForm } from "../components/NewsletterSignupForm";
import { ShowCover } from "../components/ShowCover";
import { Toast } from "../components/Toast";
import { useSubscriberAuth } from "../lib/subscriberAuth";
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

// The newsletter row carries an inline signup form instead of linking out, so
// it's modeled separately from the click-through rows below.
const newsletterRow = {
  eyebrow: "Newsletter",
  title: "In your inbox.",
  body: "Subscribe to our newsletter and get new episodes every Friday.",
};

const linkRows = [
  {
    eyebrow: "Community",
    title: "In the room.",
    to: "/community",
    body: "Nadav, Amit and Tal in conversation with members — in the Community app.",
    cta: "Learn more",
  },
  {
    eyebrow: "Ark+",
    title: "All in.",
    to: "/plus",
    body: "One membership for the paid feed, members-only newsletters, and the community.",
    cta: "Explore Ark+",
  },
];

// `eyebrow` is the section name (Newsletter / Community / Ark+) and leads as the
// prominent title — it inherits NumberedRow's big display size. `title` is the
// punchy tagline, rendered smaller and in cyan inline beside it.
function rowTitle(eyebrow: string, title: string): ReactNode {
  return (
    <>
      {eyebrow}
      <span className="ml-3 align-baseline font-display text-[15px] font-normal text-cyan sm:text-[16px]">
        {title}
      </span>
    </>
  );
}

function AlsoFromArkMedia() {
  const { state } = useSubscriberAuth();
  const { isSubscribed, prefsLoading } = useNewsletterSubscription();

  // Everyone gets the inline signup except a signed-in member we know is
  // already subscribed (free or Ark+). While prefs are still loading we
  // withhold the row so already-subscribed members never see it flash.
  const showNewsletter =
    state.kind !== "member" || (!prefsLoading && !isSubscribed);

  // Build the visible rows, then number them by position so hiding the
  // newsletter row leaves no gap (Community becomes 01, Ark+ becomes 02).
  const rows = [
    ...(showNewsletter
      ? [
          {
            key: "newsletter",
            title: rowTitle(newsletterRow.eyebrow, newsletterRow.title),
            body: newsletterRow.body,
            action: <NewsletterSignupForm slug="ark-daily" />,
          },
        ]
      : []),
    ...linkRows.map((s) => ({
      key: s.to,
      title: rowTitle(s.eyebrow, s.title),
      body: s.body,
      cta: s.cta,
      to: s.to,
    })),
  ];

  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="mb-8">
          <div className="eyebrow text-[18px] sm:text-[22px]">
            Also from Ark Media
          </div>
        </div>
        <div>
          {rows.map((row, i) => (
            <NumberedRow
              key={row.key}
              number={String(i + 1).padStart(2, "0")}
              title={row.title}
              body={row.body}
              cta={"cta" in row ? row.cta : undefined}
              to={"to" in row ? row.to : undefined}
              action={"action" in row ? row.action : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function HomePage() {
  const { gift } = Route.useSearch();
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();
  const descriptions = useShowDescriptions(shows.map((s) => s.slug));
  const isSubscriber =
    state.kind === "member" && state.me.tier === "subscriber";
  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] pb-10 sm:px-10">
          {/* Animated brand mark. The GIF has a baked-in navy background, so it
              sits in a fixed-navy tile (--color-navy doesn't flip with the
              theme) and stays seamless in both light and dark. */}
          {/* <div className="rise rise-1 mb-6 inline-flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-navy ring-1 ring-cyan/30">
            <img
              src="/brand/ark-icon-loop.gif"
              alt="Ark Media"
              width={64}
              height={64}
              className="h-full w-full object-cover"
            />
          </div> */}
          {/* <p className="inside-tab rise rise-1 text-[12px]">Ark Media</p> */}
          <h1 className="mt-10 max-w-4xl text-fg-strong">
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
          <p className="rise rise-5 mt-8 max-w-2xl text-[15px] leading-[1.65] text-fg">
            Ark Media is a podcast network that explores the big questions
            shaping Jewish life, Israel's future, and our rapidly changing
            world. Through conversations with leading Jewish thinkers from
            around the world, Ark Media aims to build a global community driven
            by curiosity and meaningful dialogue.
          </p>
          <div
            className="rise mt-10 flex flex-wrap gap-3"
            style={{ animationDelay: "0.78s" }}
          >
            <Link
              to="/podcasts"
              className="inline-flex min-h-12 items-center gap-2 border border-cyan bg-cyan px-5 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Explore podcasts →
            </Link>
            <Link
              to={isSubscriber ? "/community" : "/plus"}
              className="inline-flex min-h-12 items-center gap-2 border border-rule-strong px-5 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              {isSubscriber ? "Explore community" : "Become an Ark+ member"}
            </Link>
          </div>
        </div>
      </section>

      <LatestEpisodes />

      {/* Podcast row — card grid (good for browsing) */}
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-8 sm:px-10">
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
              className="hidden text-[12px] font-semibold uppercase tracking-button text-fg-muted transition hover:text-cyan sm:inline"
            >
              All podcasts →
            </Link>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {shows.map((show) => (
              <LinkCard
                key={show.slug}
                to={show.route}
                eyebrow={show.shortTitle}
                title={show.title}
                body={descriptions[show.slug] || show.tagline}
                cta="Visit show"
                media={<ShowCover show={show} />}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Also from Ark Media — editorial numbered stack (newsletter signup +
          links to the community and Ark+ hubs) */}
      <AlsoFromArkMedia />

      {gift === "complete" ? (
        <Toast
          message="Gift sent — we emailed your recipient their redemption link to set up their feed."
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
