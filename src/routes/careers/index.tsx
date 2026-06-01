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
          <div className="flex items-baseline gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Open roles
            </h2>
            {careers.length > 0 ? (
              <span className="text-[12px] tabular-nums text-fg-faint">
                {careers.length}
              </span>
            ) : null}
          </div>

          {careers.length === 0 ? (
            <p className="mt-10 max-w-2xl text-[14px] leading-[1.7] text-fg-muted">
              No open roles right now — but we're always glad to hear from
              talented people. Send a speculative note to{" "}
              <a
                href={`mailto:${contactEmails.careers}`}
                className="text-cyan underline underline-offset-4 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {contactEmails.careers}
              </a>
              .
            </p>
          ) : (
            <ul className="mt-8 border-t border-rule">
              {careers.map((c, i) => {
                const meta = [c.team, c.location, c.employmentType]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={c.id}>
                    <Link
                      to="/careers/$slug"
                      params={{ slug: c.slug }}
                      style={{ animationDelay: `${Math.min(i, 6) * 70}ms` }}
                      className="rise group grid grid-cols-1 gap-x-8 gap-y-3 border-b border-rule py-7 transition-colors duration-300 hover:border-cyan/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan lg:grid-cols-12 lg:items-center lg:gap-8"
                    >
                      <div className="lg:col-span-7">
                        <h3 className="font-display text-[22px] leading-tight text-fg-strong transition-colors duration-300 group-hover:text-cyan">
                          {c.title}
                        </h3>
                        <p className="mt-2 max-w-xl text-[13.5px] leading-[1.6] text-fg-muted">
                          {c.summary}
                        </p>
                      </div>
                      <div className="text-[13px] leading-[1.5] text-fg-muted lg:col-span-3">
                        {meta}
                      </div>
                      <div className="lg:col-span-2 lg:text-right">
                        <span className="inline-flex items-center gap-2 border border-rule-strong px-4 py-2 text-[12px] font-semibold uppercase tracking-button text-fg transition-colors duration-300 group-hover:border-cyan group-hover:text-cyan">
                          Apply
                          <span
                            aria-hidden
                            className="transition-transform duration-300 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none"
                          >
                            →
                          </span>
                        </span>
                      </div>
                    </Link>
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
