import { createFileRoute, Link } from "@tanstack/react-router";
import { Pricing } from "../components/Pricing";
import { ListenLinks } from "../components/ListenLinks";
import { ShowCover } from "../components/ShowCover";
import { shows, getShow } from "../data/shows";
import { isArkPlusMember, useSubscriberAuth } from "../lib/subscriberAuth";

// The soft-launch landing. A focused "Become an Insider" page — the show
// line-up, a single subscribe pitch, and the existing Stripe pricing block —
// shown in place of the full Ark+ site while the launch mode is "soft". The
// home page and the masthead link here; the Ark+ membership routes redirect
// here (see HardLaunchOnly).
//
// For a signed-in member there's nothing to sign up for, so the subscribe
// affordances are replaced with a link to feed setup.
export const Route = createFileRoute("/inside-call-me-back")({
  component: InsideCallMeBackPage,
});

function InsideCallMeBackPage() {
  const { state } = useSubscriberAuth();
  const isMember = isArkPlusMember(state);

  // The public listen row points at Call Me Back — the flagship show the
  // Inside feed extends. Falls back to nothing if the show ever goes away.
  const callMeBack = getShow("call-me-back");

  return (
    <main className="relative">
      <section className="section-hero ark-bg grain-overlay relative overflow-hidden">
        <div className="page-gutter relative grid grid-cols-1 items-center gap-10 pt-10 pb-12 sm:pt-12 lg:grid-cols-12 lg:gap-12 lg:pt-16 lg:pb-16">
          {/* Left — the show line-up */}
          <div className="lg:col-span-5">
            <div className="mx-auto grid max-w-[420px] grid-cols-2 gap-4">
              {shows.map((show) => (
                <div
                  key={show.slug}
                  className="overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/10"
                >
                  <ShowCover show={show} priority />
                </div>
              ))}
            </div>
          </div>

          {/* Right — the pitch */}
          <div className="relative z-10 lg:col-span-7">
            <h1 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4.4vw,3.4rem)] leading-[1.06]">
                The conversation about Israel and Jewish life has never been
                louder.
              </span>
              <span className="display block text-[clamp(1.9rem,4.4vw,3.4rem)] leading-[1.06] text-cyan">
                Or harder to trust.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-body-lg">
              {isMember
                ? "Thanks for being an Insider — your support keeps these conversations going. Set up your private feed below to start listening."
                : "Ark Media is where people come to actually understand it — a place for calm, clarity, and honest conversation. Our insiders make this possible: when you subscribe, you support our mission and keep these conversations going."}
            </p>

            <div className="mt-8">
              {isMember ? (
                <Link
                  to="/setup"
                  className="group inline-flex min-h-12 items-center gap-3 bg-cyan px-6 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Set up your feed
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                    →
                  </span>
                </Link>
              ) : (
                <a
                  href="#pricing"
                  className="group inline-flex min-h-12 items-center gap-3 bg-cyan px-6 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Become an Insider
                  <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                    →
                  </span>
                </a>
              )}
            </div>

            <div className="mt-10 flex items-start gap-4 border-t border-rule-soft pt-8">
              {callMeBack ? (
                <div className="w-20 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10">
                  <ShowCover show={callMeBack} />
                </div>
              ) : null}
              <p className="max-w-xl text-body-sm text-fg-muted">
                {isMember ? (
                  <>
                    <span className="text-fg-strong">Inside Call Me Back</span>{" "}
                    — the discussions that typically happen after the cameras
                    stop rolling — is in your private feed. Submit your questions
                    to Dan Senor, Nadav Eyal, and Amit Segal in the community.
                  </>
                ) : (
                  <>
                    Get access to{" "}
                    <span className="text-fg-strong">Inside Call Me Back</span> —
                    the discussions that typically happen after the cameras stop
                    rolling. Submit your questions to Dan Senor, Nadav Eyal, and
                    Amit Segal{" "}
                    <a
                      href="#pricing"
                      className="text-cyan underline-offset-4 hover:underline"
                    >
                      here
                    </a>
                    .
                  </>
                )}
              </p>
            </div>

            {callMeBack ? (
              <div className="mt-8">
                <p className="eyebrow text-fg-muted">Listen in these apps</p>
                <ListenLinks listen={callMeBack.listen} className="mt-3" />
              </div>
            ) : null}
          </div>
        </div>
        <div className="hairline" />
      </section>

      {/* Members are already in — send them to feed setup instead of the
          subscribe block. Everyone else gets the existing Stripe pricing
          ("Choose your amount", monthly/yearly, custom amount, live checkout),
          reused untouched. */}
      {isMember ? (
        <section>
          <div className="page-gutter py-16 text-center">
            <p className="eyebrow text-cyan">You&rsquo;re an Insider</p>
            <h2 className="mt-3 display-upright text-[clamp(1.6rem,3.2vw,2.4rem)] text-fg-strong">
              Set up your private feed.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-body-sm text-fg-muted">
              Add your members-only show to the podcast app you already use — it
              takes about a minute.
            </p>
            <Link
              to="/setup"
              className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 bg-cyan px-6 button-text font-display font-bold text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Set up your feed →
            </Link>
          </div>
        </section>
      ) : (
        <Pricing />
      )}
    </main>
  );
}
