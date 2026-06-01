import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { CIRCLE_OPEN_LINKS } from "../../lib/circle";
import { PageShell } from "../../components/PageShell";

export const Route = createFileRoute("/account/")({
  component: AccountDashboard,
});

function AccountDashboard() {
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
      eyebrow="Member dashboard"
      title="Welcome back."
      lede={`Signed in as ${email}. The community is the main event — open the Community app to dive in.`}
    >
      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <div className="border border-cyan/40 bg-navy-800/40 p-8">
                <div className="eyebrow">Open in the Community app</div>
                <h2 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
                  The community is in the app.
                </h2>
                <p className="mt-4 max-w-xl text-body-sm text-fg">
                  You're signed in here, so you'll be signed in there too.
                  Pick the platform you're on.
                </p>
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <a
                    href={CIRCLE_OPEN_LINKS.ios}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex min-h-12 items-center justify-center border border-cyan bg-cyan px-4 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    iOS
                  </a>
                  <a
                    href={CIRCLE_OPEN_LINKS.android}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex min-h-12 items-center justify-center border border-rule-strong px-4 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    Android
                  </a>
                  <a
                    href={CIRCLE_OPEN_LINKS.web}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex min-h-12 items-center justify-center border border-rule-strong px-4 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    Web
                  </a>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="border border-rule bg-navy-800/40 p-8">
                <div className="eyebrow">Your account</div>
                <p className="mt-4 text-body-sm text-fg">{email}</p>
                <ul className="mt-6 space-y-2">
                  <AccountLink to="/account/podcast-feed" label="Set up your private podcast feed" />
                  <AccountLink to="/account/newsletters" label="Newsletter preferences" />
                  <AccountLink to="/account/billing" label="Billing & cancel" />
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

function FreeDashboard({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  return (
    <PageShell
      eyebrow="Your account"
      title="You're signed in."
      lede={`Signed in as ${email}. Manage what lands in your inbox, or join Ark+ for the private feed and community.`}
    >
      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
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
                  <li>— Circle community access</li>
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
