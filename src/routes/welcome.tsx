import { createFileRoute, Link } from "@tanstack/react-router";
import { CIRCLE_OPEN_LINKS } from "../lib/circle";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

function WelcomePage() {
  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-16 pb-12 sm:px-10 sm:pt-24">
          <p className="inside-tab text-[12px]">You're in</p>
          <h1 className="mt-10 max-w-3xl text-fg-strong">
            <span className="display-upright block text-[clamp(2.2rem,5vw,4rem)] leading-[1.05]">
              Welcome to <span className="display text-cyan">Ark+</span>.
            </span>
          </h1>
          <p className="mt-8 max-w-2xl text-[15px] leading-[1.65] text-fg">
            Three things to do, and then you're set. Your membership is active
            now — provisioning happens in the background and may take a minute
            or two to land in every place.
          </p>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <WelcomeStep
              n="01"
              title="Open the Ark+ community"
              body="Dan, Donniel, and Yossi are in the Circle app — alongside everyone else who joined this month. Install the app and you'll be signed in automatically."
              cta="Install the Circle app"
              href={CIRCLE_OPEN_LINKS.ios}
              external
            />
            <WelcomeStep
              n="02"
              title="Set up your private podcast feed"
              body="Inside Call Me Back lives in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more."
              cta="Set up the feed"
              href="/account/podcast-feed"
            />
            <WelcomeStep
              n="03"
              title="Confirm your newsletter preferences"
              body="The members-only newsletters are on by default. Adjust which ones you want — or which you don't — at any time."
              cta="Newsletter preferences"
              href="/account/newsletters"
            />
          </div>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-800/40">
        <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
          <p className="text-[13px] leading-[1.6] text-fg-muted">
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

function WelcomeStep({
  n,
  title,
  body,
  cta,
  href,
  external,
}: {
  n: string;
  title: string;
  body: string;
  cta: string;
  href: string;
  external?: boolean;
}) {
  const ctaCls =
    "mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

  return (
    <div className="border border-rule bg-navy-800/40 p-8">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Step {n}
      </div>
      <h2 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </h2>
      <p className="mt-4 text-[14px] leading-[1.6] text-fg">{body}</p>
      {external ? (
        <a href={href} className={ctaCls} target="_blank" rel="noreferrer noopener">
          {cta} →
        </a>
      ) : (
        <Link to={href} className={ctaCls}>
          {cta} →
        </Link>
      )}
    </div>
  );
}
