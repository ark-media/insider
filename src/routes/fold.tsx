import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { FoldLogo, ProductMarks } from "../components/FoldLogo";
import { BookCover } from "../components/BookCover";
import { CheckoutModal } from "../components/CheckoutModal";
import { OutboundLink } from "../components/OutboundLink";
import { PriceSkeleton } from "../components/PriceSkeleton";
import { PlayGlyph } from "../components/PlayGlyph";
import {
  BillingPeriodToggle,
  type Plan,
} from "../components/BillingPeriodToggle";
import { formatPickMonth, getCurrentPick } from "../data/bookClub";
import { TIERS, type Tier } from "../data/pricingTiers";
import { trackEvent } from "../lib/analytics";
import { formatMinor, toMajor, type TierAmounts } from "../lib/currency";
import {
  fetchUpcomingOpenHouses,
  type OpenHouseSession,
} from "../lib/openHouses";
import { annualSavingsPct, usePricing } from "../lib/usePricing";
import { formatEventParts } from "../../shared/format-date";

export const Route = createFileRoute("/fold")({
  component: FoldPage,
});

/**
 * `/fold` is a marketing page for everyone — signed out, signed in, Ark+-only,
 * or a paid-up Fold member. It renders the same thing for all of them.
 *
 * The website does not pull data out of the Fold, for a member's own eyes or
 * anyone else's. The Fold is private, and this is a public marketing page.
 *
 * Two consequences worth keeping:
 *   - There is NO auth gate here, so the page paints immediately instead of
 *     holding a blank frame until the session resolves.
 *   - Members already holding the Fold still see the join CTAs. Their way into
 *     the app is /account/fold, which is the one surface that hands off to
 *     Circle. Don't add a member branch here to "fix" that.
 */
function FoldPage() {
  return <MarketingShowcase />;
}

/* ---------------------------------------------------------------------------
   Marketing showcase — the public /fold page, shown to everyone. It has one
   job: explain what the Fold is and sell a membership, so every band ends
   within reach of a join CTA.

   The order below is the argument, not a layout accident: what this is (hero)
   → hear it in our own voice (video) → what's actually inside (three rooms) →
   why the conversation is different (curation) → come and look before you buy
   (open houses) → one more reason to want in (book club) → join. Moving a band
   reorders the pitch.

   What is deliberately NOT here: real member posts. The Fold is private and
   posts carry personal detail, so nothing from inside it is published on this
   page.

   Prices are never hardcoded here: the Fold sells on the `circle` tier and the
   amounts come from Stripe via /api/pricing, same as the /plus card grid.
--------------------------------------------------------------------------- */

/**
 * The two SKUs that grant the Fold. Ark+ alone does not, so it isn't offered on
 * this page — someone who has read this far wants the Fold, and the only choice
 * left is whether to take Ark+ along with it.
 */
type JoinTier = Extract<Tier, "circle" | "bundle">;
const JOIN_TIERS: JoinTier[] = ["circle", "bundle"];

const TIER_META = new Map(TIERS.map((t) => [t.key, t] as const));

function MarketingShowcase() {
  // One modal behind every CTA on the page; the tier and plan it opens on are
  // whatever the clicked control asked for. CheckoutModal re-derives its own
  // per-purchase state when `tier` changes, so reusing it is safe (see the note
  // on `purchase` in that file).
  const [checkout, setCheckout] = useState<{
    open: boolean;
    tier: JoinTier;
    plan: Plan;
  }>({ open: false, tier: "circle", plan: "monthly" });

  const pricing = usePricing();
  const data = pricing.status === "ready" ? pricing.data : null;
  const tiers = data?.tiers ?? null;
  const currency = data?.currency ?? "usd";
  const factor = data?.factor ?? 100;

  const openCheckout = useCallback(
    (tier: JoinTier, plan: Plan) => {
      const minor = tiers?.[tier]?.[plan][currency] ?? null;
      trackEvent("checkout_opened", {
        plan,
        tier,
        amount: minor !== null ? toMajor(minor, factor) : null,
        is_custom_amount: false,
      });
      setCheckout({ open: true, tier, plan });
    },
    [tiers, currency, factor],
  );

  // The hero and the mid-page CTA both sell the Fold on its own, monthly — the
  // tier this page is about, at its smallest commitment. The choice between
  // tiers and terms belongs at the bottom, where the reader has the case for it.
  const joinFoldMonthly = useCallback(
    () => openCheckout("circle", "monthly"),
    [openCheckout],
  );

  return (
    <>
      <PageShell
        brand={<FoldLogo className="h-9 sm:h-11" />}
        title="Ark Media curates. The members make it valuable."
        lede="A private community defined by a shared curiosity about the Jewish experience."
        actions={
          <button
            type="button"
            onClick={joinFoldMonthly}
            className={JOIN_PRIMARY}
          >
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
        <InviteVideo />
        <ThreeRooms onJoin={joinFoldMonthly} />
        <WhyDifferent />
        <StatementBand />
        <OpenHouses />
        <BookClubBand />
        <JoinCta
          status={pricing.status}
          tiers={tiers}
          currency={currency}
          factor={factor}
          onJoin={openCheckout}
        />
      </PageShell>

      <CheckoutModal
        open={checkout.open}
        plan={checkout.plan}
        tier={checkout.tier}
        onClose={() => setCheckout((c) => ({ ...c, open: false }))}
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

/** The scale the page's section headings share, so they read as one rank. */
const SECTION_HEADING = "display-upright text-[clamp(2rem,4.4vw,3.2rem)] text-fg-strong";

/* --- You are invited ------------------------------------------------------ */

function InviteVideo() {
  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <h2 className={`text-center ${SECTION_HEADING}`}>You are invited.</h2>
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
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
          <h2 className={`min-w-0 ${SECTION_HEADING}`}>
            Three Rooms, One Community
          </h2>
          <button
            type="button"
            onClick={onJoin}
            className={`${JOIN_SECONDARY} self-start lg:shrink-0`}
          >
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
          <h2 className={`mt-6 max-w-md ${SECTION_HEADING}`}>
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

/* --- Upcoming Open Houses -------------------------------------------------
   The only band on the page with a way in that isn't a purchase. Dates, times
   and Zoom links are edited in /admin/open-houses (see shared/open-house.ts):
   the schedule moves week to week and shifts hours to reach other time zones,
   so it is data the team owns, not copy in this file.
-------------------------------------------------------------------------- */

function OpenHouses() {
  const [sessions, setSessions] = useState<OpenHouseSession[] | null>(null);

  useEffect(() => {
    let alive = true;
    // fetchUpcomingOpenHouses never rejects — an outage arrives as an empty list.
    void fetchUpcomingOpenHouses().then((s) => {
      if (alive) setSessions(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Nothing upcoming (still loading, the section switched off, or the schedule
  // has simply run out) → no section at all. An invitation with no date to
  // accept is worse than not extending one.
  if (!sessions || sessions.length === 0) return null;

  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <div className="label text-cyan">Upcoming Open Houses</div>
        <h2 className={`mt-6 max-w-3xl ${SECTION_HEADING}`}>
          Curious about the Fold? Come see for yourself.
        </h2>
        <p className="mt-6 max-w-2xl text-body-lg">
          Join us for an upcoming Open House to get a feel for the Fold before
          you become a member. Meet some of the people behind the community, see
          what's happening inside, and ask any questions you have.
        </p>

        <ul className="mt-10 grid gap-6 lg:grid-cols-3">
          {sessions.map((session) => (
            <OpenHouseCard key={session.id} session={session} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function OpenHouseCard({ session }: { session: OpenHouseSession }) {
  // Rendered in the visitor's own timezone with the zone named, so a reader in
  // Tel Aviv doesn't have to work out what "12:00 PM" was supposed to mean.
  const when = formatEventParts(session.startsAt);
  if (!when) return null;

  return (
    <li className="flex flex-col border border-rule bg-navy-800/40 p-7 sm:p-8">
      <div className="display-upright text-[clamp(1.4rem,2.2vw,1.75rem)] text-fg-strong">
        {when.date}
      </div>
      <div className="mt-3 label text-cyan">{when.time}</div>
      {session.note ? (
        <p className="mt-4 text-body">{session.note}</p>
      ) : null}

      <div className="mt-7 grow" />
      {session.rsvpUrl ? (
        <OutboundLink
          href={session.rsvpUrl}
          platform="zoom"
          placement="fold_open_house"
          context={session.id}
          className={`${JOIN_SECONDARY} w-full`}
        >
          RSVP
        </OutboundLink>
      ) : (
        // A date can be announced before the meeting exists. Saying so beats a
        // button that goes nowhere — and beats withholding the date.
        <p className="meta">RSVP link coming soon</p>
      )}
    </li>
  );
}

/* --- Dan's Book Club -------------------------------------------------------
   The current pick, pointing at /book-club for the note, the shelf, and the
   buy link. Picks live in src/data/bookClub.ts, so this band follows whatever
   is current there (by date) with no edit here.
-------------------------------------------------------------------------- */

function BookClubBand() {
  const pick = getCurrentPick();
  if (!pick) return null;

  return (
    <section>
      <div className="page-gutter grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="mx-auto w-full max-w-[220px] lg:col-span-3 lg:mx-0">
          <BookCover book={pick} />
        </div>

        <div className="lg:col-span-9">
          <div className="label text-cyan">Dan's Book Club</div>
          <h2 className={`mt-6 ${SECTION_HEADING}`}>
            {formatPickMonth(pick.month)} Pick
          </h2>
          <p className="mt-6 display-upright text-[clamp(1.4rem,2.4vw,1.9rem)] text-fg-strong">
            {pick.title}
          </p>
          <p className="mt-2 text-body-lg">{pick.author}</p>
          <p className="mt-6 max-w-2xl text-body">
            One book a month, picked by Dan and read alongside the Fold —
            argued over in the rooms, not in a vacuum.
          </p>
          <Link to="/book-club" className={`${JOIN_SECONDARY} mt-8`}>
            Learn more
          </Link>
        </div>
      </div>
    </section>
  );
}

/* --- Join the Fold --------------------------------------------------------- */

function JoinCta({
  status,
  tiers,
  currency,
  factor,
  onJoin,
}: {
  status: "loading" | "error" | "ready";
  tiers: Record<string, TierAmounts> | null;
  currency: string;
  factor: number;
  onJoin: (tier: JoinTier, plan: Plan) => void;
}) {
  // Monthly by default, unlike /plus (which leads annual). This card sits at the
  // end of a long read and the smaller number is the easier yes; the toggle is
  // right there for anyone who'd rather commit for the year.
  const [plan, setPlan] = useState<Plan>("monthly");

  const changePlan = (p: Plan) => {
    setPlan(p);
    trackEvent("plan_selected", { plan: p });
  };

  // A pricing outage must not take the join CTA down with it — checkout fetches
  // its own prices, so the cards drop the amounts and keep the buttons.
  const priced = status !== "error";
  const savingsPct = tiers?.bundle ? annualSavingsPct(tiers.bundle) : null;

  return (
    <section>
      <div className="page-gutter py-14 sm:py-20">
        <div className="text-center">
          <div className="flex justify-center">
            <FoldLogo className="h-10 sm:h-12" />
          </div>
          <h2 className={`mt-8 ${SECTION_HEADING}`}>Join the Fold</h2>
          <p className="mx-auto mt-6 max-w-xl text-body-lg">
            A private community from Ark Media, for people who take these
            questions seriously.
          </p>
          {priced ? (
            <div className="mt-10 flex justify-center">
              <BillingPeriodToggle
                plan={plan}
                onChange={changePlan}
                savingsPct={savingsPct}
              />
            </div>
          ) : null}
        </div>

        <div className="mx-auto mt-10 grid max-w-3xl gap-6 sm:grid-cols-2">
          {JOIN_TIERS.map((tier) => (
            <JoinCard
              key={tier}
              tier={tier}
              plan={plan}
              priced={priced}
              amounts={tiers?.[tier] ?? null}
              currency={currency}
              factor={factor}
              onJoin={onJoin}
            />
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link to="/plus" className="episode-action hover:underline">
            See all membership options
          </Link>
        </div>
      </div>
    </section>
  );
}

// The button copy names what the buyer ends up with, rather than the generic
// "Subscribe monthly" the /plus grid uses — on this page the Fold is assumed
// and the bundle is the upgrade.
const JOIN_CARD_CTA: Record<JoinTier, string> = {
  circle: "Join the Fold",
  bundle: "Join with Ark+",
};

function JoinCard({
  tier,
  plan,
  priced,
  amounts,
  currency,
  factor,
  onJoin,
}: {
  tier: JoinTier;
  plan: Plan;
  priced: boolean;
  amounts: TierAmounts | null;
  currency: string;
  factor: number;
  onJoin: (tier: JoinTier, plan: Plan) => void;
}) {
  const meta = TIER_META.get(tier);
  if (!meta) return null;

  // A floor, not a fixed price: members choose their amount at checkout, so the
  // card leads with "From" exactly as the /plus grid does.
  const minor = amounts?.[plan][currency] ?? null;
  const featured = tier === "bundle";

  return (
    <div
      className={`relative flex flex-col p-7 sm:p-8 ${
        featured
          ? "border-2 border-cyan bg-navy-800/60"
          : "border border-rule bg-navy-800/40"
      }`}
    >
      {featured ? (
        <span className="absolute -top-px left-1/2 -translate-x-1/2 -translate-y-1/2 bg-cyan px-3 py-1 button-text font-display font-bold text-navy">
          Best value
        </span>
      ) : null}

      <div className="flex items-center gap-3">
        <ProductMarks marks={meta.marks} />
        <div className="text-h4 font-display font-bold text-fg-strong">
          {meta.label}
        </div>
      </div>

      {priced ? (
        <div className="mt-5 border-t border-rule pt-5">
          <div className="flex items-baseline gap-2 text-fg-strong">
            <span className="text-body-sm">From</span>
            <span className="display-upright text-[clamp(2rem,4.5vw,2.6rem)] leading-none">
              {minor !== null ? (
                formatMinor(minor, currency, factor)
              ) : (
                <PriceSkeleton className="h-[0.7em] w-20" />
              )}
            </span>
            <span className="text-body-sm">
              / {plan === "yearly" ? "year" : "month"}
            </span>
          </div>
          <div className="mt-2 text-body-sm">
            {plan === "yearly" ? "Billed annually" : "Billed monthly"}
          </div>
        </div>
      ) : null}

      <p className="mt-5 grow text-body-sm text-fg">{meta.blurb}</p>

      <button
        type="button"
        onClick={() => onJoin(tier, plan)}
        className={`mt-7 w-full ${featured ? JOIN_PRIMARY : JOIN_SECONDARY}`}
      >
        {JOIN_CARD_CTA[tier]}
      </button>
    </div>
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
