import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
import { Benefits } from "../../components/Benefits";
import { Pricing } from "../../components/Pricing";
import { FAQ } from "../../components/FAQ";
import { fetchFaqs } from "../../lib/faqs";
import { HardLaunchOnly } from "../../lib/launchMode";

export const Route = createFileRoute("/plus/")({
  loader: async () => ({ faqs: await fetchFaqs() }),
  component: () => (
    <HardLaunchOnly>
      <PlusPage />
    </HardLaunchOnly>
  ),
});

function PlusPage() {
  const { faqs } = Route.useLoaderData();

  return (
    <>
      <Hero />
      <Benefits />
      <Pricing />
      <FAQ faqs={faqs} />
    </>
  );
}
