import { createFileRoute, Link } from "@tanstack/react-router";
import { CIRCLE_OPEN_LINKS } from "../lib/circle";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

function WelcomePage() {
  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-16 pb-12 sm:px-10 sm:pt-24">
          <p className="inside-tab text-xs">You're in</p>
          <h1 className="mt-10 max-w-3xl text-fg-strong">
            <span className="display-upright block text-[clamp(2.2rem,5vw,4rem)] leading-[1.05]">
              Welcome to <span className="display text-cyan">Ark+</span>.
            </span>
          </h1>
          <p className="mt-8 max-w-2xl text-body-lg">
            Three things to do, and then you're set. Your membership is active
            now — provisioning happens in the background and may take a minute
            or two to land in every place.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <WelcomeStep
              n="01"
              title="Open the Ark+ community"
              body="Nadav, Amit and Talare in the Community app — alongside everyone else who joined this month. Install the app and you'll be signed in automatically."
              cta="Install the Community app"
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

      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
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
    "mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

  return (
    <div className="border border-rule bg-navy-800/40 p-8">
      <div className="label text-cyan">
        Step {n}
      </div>
      <h2 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </h2>
      <p className="mt-4 text-body-sm text-fg">{body}</p>
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
