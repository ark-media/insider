import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ContentError } from "../components/ContentError";
import { FAQ } from "../components/FAQ";
import { PageShell } from "../components/PageShell";
import { fetchFaqs } from "../lib/faqs";

export const Route = createFileRoute("/faq")({
  loader: async () => ({ faqs: await fetchFaqs() }),
  component: FaqPage,
});

function FaqPage() {
  const { faqs } = Route.useLoaderData();
  const router = useRouter();

  // fetchFaqs() swallows a failed request into an empty array and FAQ renders
  // nothing when it has nothing to show. Inline on /plus that's a quietly
  // dropped section; here it would be a blank page, so offer a retry.
  if (faqs.length === 0) {
    return (
      <PageShell title="Frequently asked.">
        <section>
          <div className="page-section">
            <ContentError
              message="We couldn't load the FAQs right now. Try again, or get in touch and we'll answer directly."
              onRetry={() => void router.invalidate()}
            />
          </div>
        </section>
      </PageShell>
    );
  }

  // FAQ brings its own heading and lede, so it is the whole page here.
  return (
    <main className="relative">
      <FAQ faqs={faqs} as="h1" />
    </main>
  );
}
