import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { getMySubscription, type Me, type MySubscription } from "../../lib/auth";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import { ProductMarks } from "../../components/FoldLogo";
import { useEntitlementOffers } from "../../components/account/useEntitlementOffers";
import { PlanCard } from "../../components/account/PlanCard";
import { ProfileNameCard } from "../../components/account/ProfileNameCard";

export const Route = createFileRoute("/account/")({
  component: MembershipTab,
});

// The Membership tab. The /account layout has already resolved auth and drawn
// the greeting and tab bar, so this renders the body alone.
function MembershipTab() {
  const { state, refresh } = useSubscriberAuth();
  if (state.kind !== "member") return null;

  const { me } = state;
  return me.tier === "free" ? (
    <FreeMembership me={me} onRefresh={refresh} />
  ) : (
    <PaidMembership me={me} onRefresh={refresh} />
  );
}

function PaidMembership({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  // The plan card's dates, price and card on file. Loaded here rather than in
  // the card so the card stays a pure render of whatever we managed to read —
  // and so a Stripe hiccup leaves the rest of the tab untouched.
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [loading, setLoading] = useState(true);
  // Whichever axis this member doesn't have yet (as a jump card), plus the
  // gift-expiry banners and the confirm panel those cards open.
  const { notices, offers } = useEntitlementOffers({ me, onRefresh });

  useEffect(() => {
    let active = true;
    void getMySubscription()
      .then((s) => {
        if (active) setSubscription(s);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [me.email]);

  return (
    <section>
      <div className="page-section">
        {/* Only the ask, never the quiet "Your name · Edit" row — that lives on
            the Settings tab, where a member goes looking for it. */}
        <ProfileNameCard onSaved={onRefresh} promptOnly />

        <PlanCard
          tier={me.tier as "ark-plus" | "circle" | "bundle"}
          subscription={subscription}
          loading={loading}
        />

        {/* Full-width and deliberately above "Jump back in": a gift running out
            in nine days is the most time-sensitive thing on this page, and the
            confirm panel has to sit where the numbers can be read. Nothing at
            all when there's neither. */}
        {notices}

        <h2 className="mt-12 label text-cyan">Jump back in</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {me.entitlements.arkPlus ? (
            <JumpCard
              icon={<HeadphonesIcon />}
              title="Your private podcast feeds"
              cta="Set up your feeds"
              to="/account/podcast-feed"
              primary
            />
          ) : null}
          {me.entitlements.circle ? (
            <JumpCard
              icon={<ProductMarks marks={["fold"]} />}
              title="The Fold"
              body="You're signed in here, so you'll be signed in there too."
              cta="Open the Fold"
              to="/account/fold"
              primary
            />
          ) : null}
          <JumpCard
            icon={<EnvelopeIcon />}
            title="The members-only newsletter"
            cta="Email preferences"
            to="/account/settings"
          />
          {/* The axis they don't have yet, offered as one more card in the same
              row rather than as a section of its own — "here's what's next" is
              the same shelf as "here's where you left off". */}
          {offers.map((offer) => (
            <JumpCard
              key={offer.key}
              icon={
                <ProductMarks
                  marks={[offer.key === "circle" ? "fold" : "ark-plus"]}
                />
              }
              title={offer.title}
              body={offer.body}
              cta={offer.cta}
              onSelect={offer.onSelect}
              disabled={offer.disabled}
              accent
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// One card on the "Jump back in" shelf. Most of them go somewhere (`to`); the
// cross-sell card starts a flow on this page instead (`onSelect`), and takes
// `accent` so it reads as an offer beside its neighbours without shouting over
// the primary "Set up your feeds".
function JumpCard({
  icon,
  title,
  body,
  cta,
  to,
  onSelect,
  disabled = false,
  primary = false,
  accent = false,
}: {
  // Decorative: the heading under it names the surface, so every glyph here is
  // aria-hidden and the card reads the same with images off.
  icon?: ReactNode;
  title: string;
  body?: string;
  cta: string;
  to?: "/account/podcast-feed" | "/account/fold" | "/account/settings";
  onSelect?: () => void;
  disabled?: boolean;
  primary?: boolean;
  accent?: boolean;
}) {
  const action = `mt-6 inline-flex min-h-12 w-fit items-center justify-center px-5 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
    primary
      ? "border border-cyan bg-cyan text-navy hover:bg-transparent hover:text-cyan"
      : accent
        ? "border border-cyan text-cyan hover:bg-cyan hover:text-navy disabled:opacity-60"
        : "border border-rule-strong text-fg-strong hover:border-cyan hover:text-cyan"
  }`;

  // The one visual signal separating "yours" from "you could add this": the
  // offer card sits on a cyan wash instead of the neutral card surface. Same
  // 10% tint the gift-expiry notices use, so the shelf and the banners above it
  // speak the same language. Alpha rather than a fixed hex on purpose — --color-cyan
  // is darkened in the light theme, so one class lands in both.
  const surface = accent
    ? "border-cyan/40 bg-cyan/10"
    : "border-rule bg-navy-800/40";

  return (
    <div className={`flex flex-col border p-6 ${surface}`}>
      {/* Rendered on every card, empty on most: the slot is what keeps the
          icons and headings on one line across the shelf, so it has to hold its
          height whether or not there are words in it. `min-h-4` rather than a
          non-breaking space — nothing for a screen reader to announce.
          The text is derived from `accent` rather than passed in: the wash and
          the words both mean "not yours yet", and splitting them across two
          props is how a card ends up tinted but unlabelled. */}
      <div className="eyebrow mb-3 min-h-4">
        {accent ? "Not included yet" : null}
      </div>
      {/* Fixed-height row, not just the glyph: the line icons and the brand
          marks have different intrinsic ratios, and a shared box is what keeps
          the three headings on one baseline across the shelf. */}
      {icon ? (
        <div className="mb-4 flex h-7 items-center text-cyan">{icon}</div>
      ) : null}
      <h3 className="font-display text-[18px] font-bold leading-tight text-fg-strong">
        {title}
      </h3>
      {body ? <p className="mt-2 text-body-sm text-fg">{body}</p> : null}
      {/* Eats the slack so the action lands on the bottom edge of the card.
          Grid rows stretch every card to the tallest, and the cards carry
          different amounts of copy — without this the CTAs sit at whatever
          height their own text happens to end at. A spacer rather than
          `mt-auto` on the action, which would win over its `mt-6` and let the
          body copy run straight into the button. */}
      <div className="flex-1" />
      {to ? (
        <Link to={to} className={action}>
          {cta} →
        </Link>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          disabled={disabled}
          className={action}
        >
          {cta} →
        </button>
      )}
    </div>
  );
}

// A signed-in reader with no membership. The mockup only covers a member, so
// this keeps the existing upsell — restyled to the same card language as the
// paid tab so the two don't look like different products.
function FreeMembership({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  return (
    <section>
      <div className="page-section">
        <ProfileNameCard onSaved={onRefresh} promptOnly />

        <div className="border border-cyan/40 bg-navy-800/40 p-8">
          <div className="flex items-center gap-4">
            <ArkPlusMark className="h-14 w-14" />
            <div className="eyebrow">Become an Ark+ member</div>
          </div>
          <h2 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
            Go deeper with Ark+.
          </h2>
          <ul className="mt-6 space-y-2 text-body-sm text-fg">
            <FeatureLine>Call Me Back AMA, the members-only show</FeatureLine>
            <FeatureLine>Private podcast feed, ad-free</FeatureLine>
            <FeatureLine>Members-only newsletter</FeatureLine>
            <FeatureLine>The Fold, in the app</FeatureLine>
          </ul>
          <Link
            to="/plus"
            className="mt-8 inline-flex min-h-12 items-center justify-center border border-cyan bg-cyan px-6 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Become a member →
          </Link>
        </div>

        <h2 className="mt-12 label text-cyan">Jump back in</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <JumpCard
            icon={<EnvelopeIcon />}
            title="The free newsletter"
            body={`Ark News Daily, every weekday morning, to ${me.email}.`}
            cta="Email preferences"
            to="/account/settings"
          />
        </div>
      </div>
    </section>
  );
}

// Line glyphs for the two surfaces with no brand mark of their own — the Fold
// and Ark+ cards use their real artwork (ProductMarks) instead. Drawn inline in
// the codebase's house style (24 viewBox, currentColor stroke) rather than
// pulled from an icon package; two icons don't earn a dependency.
const GLYPH = "h-7 w-7 shrink-0";
const GLYPH_STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// Over-ear headphones: a band arcing between two ear cups.
function HeadphonesIcon() {
  return (
    <svg viewBox="0 0 24 24" className={GLYPH} aria-hidden="true" {...GLYPH_STROKE}>
      <path d="M2.5 14.5V12a9.5 9.5 0 0 1 19 0v2.5" />
      <rect x="1.5" y="14" width="6" height="7" rx="2" />
      <rect x="16.5" y="14" width="6" height="7" rx="2" />
    </svg>
  );
}

// The newsletter, as the thing that actually lands: an envelope.
function EnvelopeIcon() {
  return (
    <svg viewBox="0 0 24 24" className={GLYPH} aria-hidden="true" {...GLYPH_STROKE}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="m3.5 6.2 8.5 6 8.5-6" />
    </svg>
  );
}

function FeatureLine({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="text-cyan">
        —
      </span>
      <span>{children}</span>
    </li>
  );
}
