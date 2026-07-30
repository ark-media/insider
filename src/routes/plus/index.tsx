import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
import { Pricing } from "../../components/Pricing";
import { WhySubscribe } from "../../components/WhySubscribe";
import { FAQ } from "../../components/FAQ";
import { fetchFaqs } from "../../lib/faqs";

export const Route = createFileRoute("/plus/")({
  loader: async () => ({ faqs: await fetchFaqs() }),
  component: PlusPage,
});

function PlusPage() {
  const { faqs } = Route.useLoaderData();

  return (
    <>
      <Hero />
      <Pricing />
      <WhySubscribe />
      <FAQ faqs={faqs} />
    </>
  );
}
