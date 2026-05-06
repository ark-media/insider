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
        <p className="text-white/60">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  const { me } = state;

  return (
    <PageShell
      eyebrow="Member dashboard"
      title="Welcome back."
      lede={`Signed in as ${me.email}. The community is the main event — open the Circle app to dive in.`}
    >
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <div className="border border-cyan/40 bg-navy-800/40 p-8">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  Open in the Circle app
                </div>
                <h2 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-white">
                  The community is in the app.
                </h2>
                <p className="mt-4 max-w-xl text-[14.5px] leading-[1.6] text-white/70">
                  You're signed in here, so you'll be signed in there too.
                  Pick the platform you're on.
                </p>
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <a
                    href={CIRCLE_OPEN_LINKS.ios}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center border border-cyan bg-cyan px-4 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
                  >
                    iOS
                  </a>
                  <a
                    href={CIRCLE_OPEN_LINKS.android}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center border border-white/25 px-4 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan"
                  >
                    Android
                  </a>
                  <a
                    href={CIRCLE_OPEN_LINKS.web}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center justify-center border border-white/25 px-4 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan"
                  >
                    Web
                  </a>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="border border-white/12 bg-navy-800/40 p-8">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  Your account
                </div>
                <p className="mt-4 text-[13.5px] text-white/85">{me.email}</p>
                <ul className="mt-6 space-y-2">
                  <AccountLink to="/account/podcast-feed" label="Set up your private podcast feed" />
                  <AccountLink to="/account/newsletters" label="Newsletter preferences" />
                  <AccountLink to="/account/billing" label="Billing & cancel" />
                </ul>
                <button
                  onClick={signOut}
                  className="mt-6 w-full border border-white/25 px-4 py-3 text-[13.5px] text-white/85 transition hover:border-red-500/50 hover:text-red-500"
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
        className="group flex items-center justify-between border border-white/15 px-4 py-3 text-[13.5px] text-white/85 transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <span>{label}</span>
        <span aria-hidden="true" className="text-white/45 group-hover:text-cyan">
          →
        </span>
      </Link>
    </li>
  );
}
