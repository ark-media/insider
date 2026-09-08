import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { getMySubscription, type Me, type MySubscription } from "../../lib/auth";
import { ArkPlusMark } from "../../components/ArkPlusMark";
import { EntitlementAccess } from "../../components/account/EntitlementAccess";
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

        {/* Gift-expiry banners and the per-axis access rows. Deliberately above
            "Jump back in": a gift running out in nine days is the most
            time-sensitive thing on this page. */}
        <div className="mt-12">
          <EntitlementAccess me={me} onRefresh={onRefresh} />
        </div>

        <h2 className="label text-cyan">Jump back in</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {me.entitlements.arkPlus ? (
            <JumpCard
              title="Your private podcast feeds"
              body="One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more."
              cta="Set up your feeds"
              to="/account/podcast-feed"
              primary
            />
          ) : null}
          {me.entitlements.circle ? (
            <JumpCard
              title="The Fold"
              body="You're signed in here, so you'll be signed in there too."
              cta="Open the Fold"
              to="/account/fold"
              primary
            />
          ) : null}
          <JumpCard
            title="The members-only newsletter"
            body={`Weekly, from the hosts, to ${me.email}. On by default.`}
            cta="Email preferences"
            to="/account/settings"
          />
        </div>
      </div>
    </section>
  );
}

function JumpCard({
  title,
  body,
  cta,
  to,
  primary = false,
}: {
  title: string;
  body: string;
  cta: string;
  to: "/account/podcast-feed" | "/account/fold" | "/account/settings";
  primary?: boolean;
}) {
  return (
    <div className="flex flex-col border border-rule bg-navy-800/40 p-6">
      <h3 className="font-display text-[18px] font-bold leading-tight text-fg-strong">
        {title}
      </h3>
      <p className="mt-2 flex-1 text-body-sm text-fg">{body}</p>
      <Link
        to={to}
        className={
          primary
            ? "mt-6 inline-flex min-h-12 w-fit items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            : "mt-6 inline-flex min-h-12 w-fit items-center justify-center border border-rule-strong px-5 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        }
      >
        {cta} →
      </Link>
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
