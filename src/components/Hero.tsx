import { HERO_CONTENT } from "../data/plusContent";
import { srcSet } from "../lib/images";

export function Hero() {
  // Static by design — see data/plusContent.ts. /plus reads the same whether or
  // not you're signed in; the pricing grid below is what adapts to entitlements.
  const content = HERO_CONTENT;

  return (
    <section className="section-hero ark-bg grain-overlay relative overflow-hidden">
      <div className="page-gutter relative grid grid-cols-1 gap-8 pt-8 pb-10 sm:pt-10 lg:grid-cols-12 lg:gap-8 lg:pt-12 lg:pb-12">
        {/* Left — headline */}
        <div className="relative z-10 lg:col-span-7">
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
        </div>

        <div className="relative hidden lg:col-span-5 lg:block">
          <div className="rise rise-2 relative mx-auto max-w-[320px]">
            <img
              src={content.art.src}
              srcSet={srcSet(content.art.src)}
              sizes="320px"
              width={1200}
              height={1200}
              alt={content.art.alt}
              className="block w-full border border-rule-strong shadow-cover"
              style={{ transform: "rotate(-1.5deg)" }}
            />
          </div>
        </div>
      </div>

      <div className="hairline" />
    </section>
  );
}
