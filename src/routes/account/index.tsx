import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import { CommunityAppLinks } from "../../components/CommunityAppLinks";
import { EntitlementAccess } from "../../components/account/EntitlementAccess";
import { ProfileNameCard } from "../../components/account/ProfileNameCard";
import {
  HeadphonesIcon,
  MailIcon,
  ChatIcon,
} from "../../components/account/SurfaceIcons";
import type { Me } from "../../lib/auth";

export const Route = createFileRoute("/account/")({
  component: AccountDashboard,
});

function AccountDashboard() {
  const navigate = useNavigate();
  const { state, authError, refresh, signOut } = useSubscriberAuth();

  useEffect(() => {
    // Don't bounce to /plus when "guest" is just an unreachable /api/me — the
    // error+retry below owns that case.
    if (!authError && state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, authError, navigate]);

  if (authError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900 p-6">
        <div className="w-full max-w-md">
          <ContentError
            message="We couldn't load your account. Refresh to try again."
            onRetry={refresh}
          />
        </div>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  const { me } = state;

  if (me.tier === "free") {
    return <FreeDashboard me={me} onSignOut={signOut} onRefresh={refresh} />;
  }
  return <SubscriberDashboard me={me} onSignOut={signOut} onRefresh={refresh} />;
}

function SubscriberDashboard({
  me,
  onSignOut,
  onRefresh,
}: {
  me: Me;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  const email = me.email;
  return (
    <PageShell
      title={me.firstName ? `Welcome back, ${me.firstName}.` : "Welcome back."}
      lede={`Signed in as ${email}. Everything in your membership, in one place.`}
    >
      <section>
        <div className="page-section">
          <ProfileNameCard onSaved={onRefresh} />
          <EntitlementAccess me={me} onRefresh={onRefresh} />
          <div className="divide-y divide-rule">
            <SurfaceRow
              icon={<HeadphonesIcon />}
              label="Podcast"
              title="Your private podcast feeds"
              body="Your members-only shows live in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more."
              cta="Set up your feeds"
              href="/account/podcast-feed"
            />
            <SurfaceRow
              icon={<ChatIcon />}
              label="Community"
              title="The Ark+ community"
              body="The community is the main event. Open it in the app — you're signed in here, so you'll be signed in there too."
              slot={<CommunityAppLinks className="shrink-0" />}
            />
            <SurfaceRow
              icon={<MailIcon />}
              label="Newsletter"
              title="Newsletter preferences"
              body="The members-only newsletter is on by default. Adjust which emails you want — or which you don't — at any time."
              cta="Manage newsletters"
              href="/account/newsletters"
            />
          </div>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body-sm text-fg-muted">
              Signed in as <span className="text-fg">{email}</span> ·{" "}
              <Link
                to="/account/billing"
                className="text-cyan underline-offset-4 hover:underline"
              >
                Billing & cancel
              </Link>
            </p>
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex min-h-12 items-center justify-center border border-rule-strong px-6 text-body-sm text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Sign out
            </button>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function SurfaceRow({
  icon,
  label,
  title,
  body,
  cta,
  href,
  external,
  slot,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  body: string;
  cta?: string;
  href?: string;
  external?: boolean;
  // When provided, render this custom action node instead of a single CTA
  // (used by the Community surface for its App Store / Google Play / web links).
  slot?: ReactNode;
}) {
  const ctaCls =
    "inline-flex shrink-0 items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

  return (
    <div className="flex flex-col gap-6 py-10 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
      <div className="flex gap-5 sm:gap-6">
        <div className="mt-1 text-cyan">{icon}</div>
        <div>
          <span className="label text-cyan">{label}</span>
          <h2 className="mt-3 font-display text-[22px] leading-[1.15] text-fg-strong">
            {title}
          </h2>
          <p className="mt-3 max-w-2xl text-body-sm text-fg">{body}</p>
        </div>
      </div>
      {slot ? (
        slot
      ) : external ? (
        <a href={href} className={ctaCls} target="_blank" rel="noreferrer noopener">
          {cta} →
        </a>
      ) : (
        <Link to={href!} className={ctaCls}>
          {cta} →
        </Link>
      )}
    </div>
  );
}

function FreeDashboard({
  me,
  onSignOut,
  onRefresh,
}: {
  me: Me;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  const email = me.email;
  return (
    <PageShell
      title={me.firstName ? `You're signed in, ${me.firstName}.` : "You're signed in."}
      lede={`Signed in as ${email}. Manage what lands in your inbox, or join Ark+ for the private feed and community.`}
    >
      <section>
        <div className="page-section">
          <ProfileNameCard onSaved={onRefresh} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <div className="border border-cyan/40 bg-navy-800/40 p-8">
                <div className="eyebrow">Become an Ark+ member</div>
                <h2 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
                  Go deeper with Ark+.
                </h2>
                <ul className="mt-6 space-y-2 text-body-sm text-fg">
                  <li>— Call Me Back AMA, the members-only show</li>
                  <li>— Private podcast feed, ad-free</li>
                  <li>— Members-only newsletter</li>
                  <li>— The Ark+ community in the app</li>
                </ul>
                <Link
                  to="/plus"
                  className="mt-6 inline-flex min-h-12 items-center justify-center border border-cyan bg-cyan px-6 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Become a member →
                </Link>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="border border-rule bg-navy-800/40 p-8">
                <div className="eyebrow">Your account</div>
                <p className="mt-4 text-body-sm text-fg">{email}</p>
                <ul className="mt-6 space-y-2">
                  <AccountLink to="/account/newsletters" label="Newsletter preferences" />
                </ul>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="mt-6 inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-body-sm text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function AccountLink({
  to,
  label,
}: {
  to: "/account/podcast-feed" | "/account/newsletters" | "/account/billing";
  label: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="group flex min-h-12 items-center justify-between border border-rule px-4 text-body-sm text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <span>{label}</span>
        <span aria-hidden="true" className="text-fg-muted group-hover:text-cyan">
          →
        </span>
      </Link>
    </li>
  );
}
