import { createFileRoute } from "@tanstack/react-router";
import { PricingCards } from "../components/PricingCards";
import { PricingComparison } from "../components/PricingComparison";
import { FAQ } from "../components/FAQ";
import { fetchFaqs } from "../lib/faqs";

export const Route = createFileRoute("/pricing")({
  loader: async () => ({ faqs: await fetchFaqs() }),
  component: PricingPage,
});

function PricingPage() {
  const { faqs } = Route.useLoaderData();

  return (
    <>
      <section className="section-hero relative">
        <div className="page-gutter pt-16 pb-4 text-center">
          <div className="eyebrow">Membership</div>
          <h1 className="mx-auto mt-4 max-w-3xl text-h1">
            Choose your <span className="display text-cyan">plan.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-body-lg text-fg">
            Three ways in — the private feed, the community, or both. Every plan
            is pay-what-you-choose, and you can cancel anytime.
          </p>
        </div>
      </section>

      <section className="relative">
        <div className="page-gutter pt-10 pb-4">
          <PricingCards id="plans" />
        </div>
      </section>

      <PricingComparison />

      <FAQ faqs={faqs} />
    </>
  );
}
