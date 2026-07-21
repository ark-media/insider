import { useEffect, useRef } from "react";
import { PricingCards } from "./PricingCards";
import { trackEvent } from "../lib/analytics";

// The pricing section on /plus: an editorial intro plus the three-card grid.
// The cards, PWYC, and checkout all live in <PricingCards> so the same grid can
// be reused on the dedicated /pricing page.
export function Pricing() {
  // Top of the revenue funnel: fire once when the pricing section scrolls into
  // view, not on mount.
  const sectionRef = useRef<HTMLElement>(null);
  const viewedRef = useRef(false);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || viewedRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !viewedRef.current) {
          viewedRef.current = true;
          trackEvent("pricing_viewed");
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="pricing" ref={sectionRef} className="relative">
      <div className="page-gutter pt-12 pb-16">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-fg-strong">
            <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
              Pick your own <span className="display text-cyan">terms.</span>
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-body-sm text-fg">
            Three ways in: the private feed, the community, or both. Every plan
            is pay-what-you-choose — name the suggested amount or give more to
            help sustain independent Jewish media.
          </p>
        </div>

        <div className="mt-12">
          <PricingCards showCompareLink />
        </div>

        <ul className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-body-sm">
          {[
            "Cancel anytime",
            "Gift Ark+ available",
            "Secure checkout",
            "Pay in your local currency",
          ].map((f) => (
            <li key={f} className="flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-cyan" />
              {f}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
