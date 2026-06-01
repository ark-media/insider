import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "../../components/PageShell";
import { fetchCareers } from "../../lib/careers";
import { contactEmails } from "../../config/urls";

export const Route = createFileRoute("/careers/")({
  loader: async () => ({ careers: await fetchCareers() }),
  component: CareersPage,
});

function CareersPage() {
  const { careers } = Route.useLoaderData();

  return (
    <PageShell
      eyebrow="Careers"
      title="Build Ark Media."
      lede="We're a small team building independent journalism for an audience that wants more than a hot take. Roles below; speculative notes welcome."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Open roles
          </h2>

          {careers.length === 0 ? (
            <p className="mt-10 max-w-2xl text-[14px] leading-[1.7] text-fg-muted">
              No open roles right now — but we're always glad to hear from
              talented people. Send a speculative note to{" "}
              <a
                href={`mailto:${contactEmails.careers}`}
                className="text-cyan underline"
              >
                {contactEmails.careers}
              </a>
              .
            </p>
          ) : (
            <ul className="mt-10 divide-y divide-rule border-y border-rule">
              {careers.map((c) => {
                const meta = [c.team, c.location, c.employmentType]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={c.id} className="py-6">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-8">
                      <div className="lg:col-span-7">
                        <h3 className="font-display text-[22px] leading-tight text-fg-strong">
                          {c.title}
                        </h3>
                        <p className="mt-2 text-[13.5px] leading-[1.6] text-fg-muted">
                          {c.summary}
                        </p>
                      </div>
                      <div className="text-[13px] text-fg-muted lg:col-span-3">
                        {meta}
                      </div>
                      <div className="lg:col-span-2 lg:text-right">
                        <Link
                          to="/careers/$slug"
                          params={{ slug: c.slug }}
                          className="inline-flex items-center gap-2 border border-rule-strong px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                        >
                          Apply →
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </PageShell>
  );
}
