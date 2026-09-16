import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
import { Pricing } from "../../components/Pricing";
import { WhySubscribe } from "../../components/WhySubscribe";
import { FAQ } from "../../components/FAQ";
import { FoldGateNotice } from "../../components/FoldGateNotice";
import { fetchFaqs } from "../../lib/faqs";

export const Route = createFileRoute("/plus/")({
  // `?from=fold` means the Auth0 post-login Action turned this person away from
  // a Fold login and sent them here (auth0/actions/post-login.js). It is the
  // only thing that distinguishes them from an ordinary visitor, so the notice
  // above the hero is keyed on it. Omit the key entirely when absent, so the
  // router doesn't make it a required search param on every `Link to="/plus"`.
  validateSearch: (search: Record<string, unknown>): { from?: "fold" } =>
    search.from === "fold" ? { from: "fold" } : {},
  loader: async () => ({ faqs: await fetchFaqs() }),
  component: PlusPage,
});

function PlusPage() {
  const { faqs } = Route.useLoaderData();
  const { from } = Route.useSearch();

  return (
    <>
      {from === "fold" ? <FoldGateNotice /> : null}
      <Hero />
      <Pricing />
      <WhySubscribe />
      <FAQ faqs={faqs} />
    </>
  );
}
