import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
import { Benefits } from "../../components/Benefits";
import { Pricing } from "../../components/Pricing";
import { CircleCommunity } from "../../components/CircleCommunity";
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
      <Benefits />
      <Pricing />
      <CircleCommunity />
      <FAQ faqs={faqs} />
    </>
  );
}
