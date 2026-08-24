import { useEffect, useRef } from "react";
import { PricingCards } from "./PricingCards";
import { PricingComparison } from "./PricingComparison";
import { trackEvent } from "../lib/analytics";

// The pricing section on /plus: an editorial intro, the three-card grid, and the
// full feature-comparison table inline below it (rather than linking out to
// /pricing). The cards, PWYC, and checkout all live in <PricingCards> so the
// same grid can be reused elsewhere.
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

  // A fragment, not a wrapper: the page zebra striping in index.css only bands
  // sections that are direct children of #main-content, so nesting the
  // comparison table inside this section would merge the two into one stripe
  // (and band it differently here than on /pricing, where it stands alone).
  return (
    <>
      <section id="pricing" ref={sectionRef} className="relative">
        <div className="page-gutter pt-12 pb-16">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                Pick your own <span className="display text-cyan">terms.</span>
              </span>
            </h2>
          </div>

          <div className="mt-12">
            <PricingCards />
          </div>
        </div>
      </section>

      <PricingComparison variant="reference" />
    </>
  );
}
