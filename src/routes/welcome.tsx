import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { CommunityAppLinks } from "../components/CommunityAppLinks";
import {
  isArkPlusMember,
  isCircleMember,
  useSubscriberAuth,
} from "../lib/subscriberAuth";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
  // `claimed=1` marks the new-account landing right after a gift magic-link
  // claim: the recipient was just auto-logged-in with no password, so we offer
  // an optional "set a password" step here.
  validateSearch: (search: Record<string, unknown>): { claimed?: boolean } => {
    return search.claimed === true || search.claimed === "1" || search.claimed === "true"
      ? { claimed: true }
      : {};
  },
});

type StepDef = {
  title: string;
  body: string;
  cta?: string;
  href?: string;
  slot?: ReactNode;
};

const COUNT_WORD: Record<number, string> = {
  1: "One thing",
  2: "Two things",
  3: "Three things",
};

function WelcomePage() {
  const { state, signIn } = useSubscriberAuth();
  const { claimed } = Route.useSearch();

  // /welcome is a post-membership page — a guest has no membership to welcome.
  // Bounce them through sign-in (returnTo defaults to the current path+search,
  // so a member whose session lapsed lands right back here once authenticated).
  useEffect(() => {
    if (state.kind === "guest") signIn();
  }, [state, signIn]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }
  // The redirect is in flight; render nothing rather than flashing the page.
  if (state.kind === "guest") return null;

  // The two core steps are entitlement-driven, not tier-driven: `arkPlus` (Ark+
  // or Bundle) buys the private feed; `circle` (Community or Bundle) buys the
  // community app. A Bundle member holds both axes, so both steps show — no
  // per-tier branching needed.
  const arkPlus = isArkPlusMember(state);
  const circle = isCircleMember(state);

  // /welcome is reached right after checkout, and the membership webhook can lag
  // a minute (the hero copy says so). Until /api/me reports at least one axis we
  // can't tell what was bought, so fall back to showing every step rather than
  // an empty page — better to over-offer than to hide something they paid for.
  const known = arkPlus || circle;
  const showCommunity = known ? circle : true;
  const showFeeds = known ? arkPlus : true;

  const steps: StepDef[] = [];
  if (showCommunity) {
    steps.push({
      title: "Download the community app",
      body: "Nadav, Amit and Tal are in the Community app — alongside everyone else who joined this month. Install the app and you'll be signed in automatically.",
      slot: <CommunityAppLinks className="mt-6" />,
    });
  }
  if (showFeeds) {
    steps.push({
      title: "Set up your private podcast feeds",
      body: "Your members-only shows live in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more.",
      cta: "Set up your feeds",
      href: "/account/podcast-feed",
    });
  }
  // Every member confirms notification preferences last.
  steps.push({
    title: "Confirm your notification preferences",
    body: "New post, podcast, and members-only newsletter alerts are on by default. Confirm your preferences so you never miss an update.",
    cta: "Newsletter preferences",
    href: "/account/newsletters",
  });

  // Gift recipients arrive via a magic link with no password. Offer to set one
  // so they can sign in with email + password later instead of the link/Google.
  if (claimed) {
    steps.push({
      title: "Set a password (optional)",
      body: "You're signed in — no password needed. Prefer one? Set a password so you can sign in without Google or your gift link next time.",
      slot: <SetPasswordButton />,
    });
  }

  const gridCols =
    steps.length >= 3
      ? "lg:grid-cols-3"
      : steps.length === 2
        ? "lg:grid-cols-2"
        : "max-w-xl";
  const countWord = COUNT_WORD[steps.length] ?? `${steps.length} things`;

  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-10 pb-10 sm:pt-16">
          <h1 className="max-w-3xl text-fg-strong">
            <span className="display-upright block text-[clamp(2.2rem,5vw,4rem)] leading-[1.05]">
              <WelcomeHeadline feeds={showFeeds} community={showCommunity} />
            </span>
          </h1>
          <p className="mt-8 max-w-2xl text-body-lg">
            {countWord} to do, and then you're set. Your membership is active
            now — provisioning happens in the background and may take a minute
            or two to land in every place.
          </p>
        </div>
      </section>

      <section>
        <div className="page-section">
          <div className={`grid grid-cols-1 gap-6 ${gridCols}`}>
            {steps.map((step, i) => (
              <WelcomeStep
                key={step.title}
                n={String(i + 1).padStart(2, "0")}
                {...step}
              />
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="page-gutter py-8">
          <p className="text-body-sm">
            A welcome email is on its way. Need help?{" "}
            <Link to="/contact" className="text-cyan underline-offset-4 hover:underline">
              Contact us.
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

// Headline tracks what the member actually bought: both axes read as the
// Bundle, otherwise the single tier they hold. The brand word is cyan.
function WelcomeHeadline({
  feeds,
  community,
}: {
  feeds: boolean;
  community: boolean;
}) {
  if (feeds && community) {
    return (
      <>
        Welcome to <span className="display text-cyan">Ark+ &amp; Community</span>.
      </>
    );
  }
  if (community) {
    return (
      <>
        Welcome to the <span className="display text-cyan">Community</span>.
      </>
    );
  }
  return (
    <>
      Welcome to <span className="display text-cyan">Ark+</span>.
    </>
  );
}

// Kicks off Auth0's set-password ticket for the (already logged-in) recipient,
// then redirects to it. Result URL brings them back to /welcome?claimed=1.
function SetPasswordButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/account/password-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      setErr("Couldn't start password setup. Please try again.");
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const cls =
    "mt-6 inline-flex min-h-11 items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div>
      <button type="button" onClick={onClick} disabled={busy} className={cls}>
        {busy ? "Opening…" : "Set a password"} →
      </button>
      {err ? (
        <p role="alert" className="mt-3 text-body-sm text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}

function WelcomeStep({
  n,
  title,
  body,
  cta,
  href,
  external,
  slot,
}: {
  n: string;
  title: string;
  body: string;
  cta?: string;
  href?: string;
  external?: boolean;
  // When provided, render this custom action node instead of a single CTA
  // (used by the community step for its App Store / Google Play / web links).
  slot?: ReactNode;
}) {
  const ctaCls =
    "mt-6 inline-flex min-h-11 items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

  return (
    <div className="border border-rule bg-navy-800/40 p-8">
      <div className="label text-cyan">
        Step {n}
      </div>
      <h2 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </h2>
      <p className="mt-4 text-body-sm text-fg">{body}</p>
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
