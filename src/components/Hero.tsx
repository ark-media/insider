import { Link } from "@tanstack/react-router";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { plusAudience, HERO_CONTENT } from "../data/plusContent";
import { HeroArtwork } from "./HeroArtwork";

export function Hero() {
  // Personalize the pitch to what the viewer doesn't already own. While auth is
  // still resolving, `plusAudience` returns "guest" — the right default for this
  // conversion page (a returning member briefly sees the guest copy, then it
  // swaps once /api/me resolves).
  const { state } = useSubscriberAuth();
  const content = HERO_CONTENT[plusAudience(state)];

  return (
    <section className="section-hero ark-bg grain-overlay relative overflow-hidden">
      <div className="page-gutter relative grid grid-cols-1 gap-8 pt-8 pb-10 sm:pt-10 lg:grid-cols-12 lg:gap-8 lg:pt-12 lg:pb-12">
        {/* Left — headline */}
        <div className="relative z-10 lg:col-span-7">
          <div className="rise rise-1 flex items-center gap-3 eyebrow">
            <span className="h-px w-10 bg-cyan" />
            {content.eyebrow}
          </div>

          <h1 className="rise rise-2 mt-5 text-fg-strong">
            <span className="display-upright block text-[clamp(2rem,4.4vw,3.6rem)]">
              {content.head.line1}
            </span>
            <span className="display-upright block text-[clamp(2rem,4.4vw,3.6rem)]">
              {content.head.line2Pre}
              <span className="display text-cyan">{content.head.line2Accent}</span>
              {content.head.line2Post}
            </span>
          </h1>

          <p className="rise rise-3 mt-6 max-w-lg text-body-lg">{content.lead}</p>

          <div className="rise rise-5 mt-8 flex flex-wrap items-center gap-6">
            {content.cta.to ? (
              <Link
                to={content.cta.to}
                className="group relative inline-flex min-h-11 items-center gap-3 bg-cyan px-6 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900"
              >
                {content.cta.label}
                <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                  →
                </span>
              </Link>
            ) : (
              <a
                href={content.cta.href}
                className="group relative inline-flex min-h-11 items-center gap-3 bg-cyan px-6 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900"
              >
                {content.cta.label}
                <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                  →
                </span>
              </a>
            )}
            <Link
              to="/plus/gift"
              className="inline-flex min-h-11 items-center text-body-lg text-fg underline decoration-rule-strong underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan"
            >
              {content.giftLabel}
            </Link>
          </div>
        </div>

        {/* Right — the host ensemble */}
        <div className="relative lg:col-span-5">
          <div className="rise rise-2 relative mx-auto max-w-[320px]">
            <HeroArtwork variant="plus" />
          </div>
        </div>
      </div>

      {/* Bottom cyan hairline */}
      <div className="hairline" />
    </section>
  );
}
