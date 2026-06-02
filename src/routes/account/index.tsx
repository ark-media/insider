import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { CIRCLE_OPEN_LINKS } from "../../lib/circle";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import {
  HeadphonesIcon,
  MailIcon,
  ChatIcon,
} from "../../components/account/SurfaceIcons";

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
    return <FreeDashboard email={me.email} onSignOut={signOut} />;
  }
  return <SubscriberDashboard email={me.email} onSignOut={signOut} />;
}

function SubscriberDashboard({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  return (
    <PageShell
      title="Welcome back."
      lede={`Signed in as ${email}. Everything in your membership, in one place.`}
    >
      <section>
        <div className="page-section">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <SurfaceCard
              icon={<HeadphonesIcon />}
              label="Podcast"
              title="Your private podcast feed"
              body="Inside Call Me Back lives in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more."
              cta="Set up the feed"
              href="/account/podcast-feed"
            />
            <SurfaceCard
              icon={<MailIcon />}
              label="Newsletter"
              title="Newsletter preferences"
              body="The members-only newsletter is on by default. Adjust which emails you want — or which you don't — at any time."
              cta="Manage newsletters"
              href="/account/newsletters"
            />
            <SurfaceCard
              icon={<ChatIcon />}
              label="Community"
              title="The Ark+ community"
              body="The community is the main event. Open it in the app — you're signed in here, so you'll be signed in there too."
              links={[
                { label: "iOS", href: CIRCLE_OPEN_LINKS.ios },
                { label: "Android", href: CIRCLE_OPEN_LINKS.android },
                { label: "Web", href: CIRCLE_OPEN_LINKS.web },
              ]}
            />
          </div>

          <div className="mt-10 flex flex-col gap-4 border-t border-rule pt-6 sm:flex-row sm:items-center sm:justify-between">
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

function SurfaceCard({
  icon,
  label,
  title,
  body,
  cta,
  href,
  external,
  links,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  body: string;
  cta?: string;
  href?: string;
  external?: boolean;
  // When provided, render one button per platform instead of a single CTA
  // (used by the Community surface for its iOS / Android / Web open links).
  links?: { label: string; href: string }[];
}) {
  const ctaCls =
    "mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

  return (
    <div className="flex flex-col border border-rule bg-navy-800/40 p-8">
      <div className="flex items-center gap-3 text-cyan">
        {icon}
        <span className="label">{label}</span>
      </div>
      <h2 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </h2>
      <p className="mt-4 flex-1 text-body-sm text-fg">{body}</p>
      {links ? (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {links.map((link, i) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className={
                i === 0
                  ? "inline-flex min-h-12 items-center justify-center border border-cyan bg-cyan px-4 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  : "inline-flex min-h-12 items-center justify-center border border-rule-strong px-4 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              }
            >
              {link.label}
            </a>
          ))}
        </div>
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
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  return (
    <PageShell
      title="You're signed in."
      lede={`Signed in as ${email}. Manage what lands in your inbox, or join Ark+ for the private feed and community.`}
    >
      <section>
        <div className="page-section">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <div className="border border-cyan/40 bg-navy-800/40 p-8">
                <div className="eyebrow">Become an Ark+ member</div>
                <h2 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
                  Go deeper with Ark+.
                </h2>
                <ul className="mt-6 space-y-2 text-body-sm text-fg">
                  <li>— Inside Call Me Back, the members-only show</li>
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
