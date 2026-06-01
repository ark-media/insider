import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { CIRCLE_OPEN_LINKS } from "../../lib/circle";
import { PageShell } from "../../components/PageShell";
import {
  HeadphonesIcon,
  MailIcon,
  ChatIcon,
} from "../../components/account/SurfaceIcons";

// LAYOUT OPTION B — everything on one page, one column. Each surface gets a
// full-width section (icon + label + title + body + action) stacked top to
// bottom, separated by rules. Reads as a single scroll rather than a grid.
export const Route = createFileRoute("/account/option-stacked")({
  component: OptionStackedPage,
});

function OptionStackedPage() {
  const navigate = useNavigate();
  const { state, signOut } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  const { me } = state;

  return (
    <PageShell
      eyebrow="Member dashboard"
      title="Welcome back."
      lede={`Signed in as ${me.email}. Everything in your membership, in one place.`}
    >
      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="divide-y divide-rule">
            <SurfaceRow
              icon={<HeadphonesIcon />}
              label="Podcast"
              title="Your private podcast feed"
              body="Inside Call Me Back lives in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more."
              cta="Set up the feed"
              href="/account/podcast-feed"
            />
            <SurfaceRow
              icon={<MailIcon />}
              label="Newsletter"
              title="Newsletter preferences"
              body="The members-only newsletter is on by default. Adjust which emails you want — or which you don't — at any time."
              cta="Manage newsletters"
              href="/account/newsletters"
            />
            <SurfaceRow
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

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body-sm text-fg-muted">
              Signed in as <span className="text-fg">{me.email}</span> ·{" "}
              <Link
                to="/account/billing"
                className="text-cyan underline-offset-4 hover:underline"
              >
                Billing & cancel
              </Link>
            </p>
            <button
              type="button"
              onClick={signOut}
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
      {links ? (
        <div className="grid shrink-0 grid-cols-3 gap-3">
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
