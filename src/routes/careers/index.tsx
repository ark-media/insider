import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "../../components/PageShell";
import { fetchCareers } from "../../lib/careers";

export const Route = createFileRoute("/careers/")({
  loader: async () => ({ careers: await fetchCareers() }),
  component: CareersPage,
});

function CareersPage() {
  const { careers } = Route.useLoaderData();

  return (
    <PageShell
      title="Build Ark Media."
      lede="We're a independent Jewish media company for people who want the whole story, not just a headline. Open roles and speculative notes welcome."
    >
      <section>
        <div className="page-gutter py-6">
          <div className="flex items-baseline gap-3">
            <h2 className="label text-cyan">Open roles</h2>
            {careers.length > 0 ? (
              <span className="text-body-sm tabular-nums text-fg-faint">
                {careers.length}
              </span>
            ) : null}
          </div>

          {careers.length === 0 ? (
            <p className="mt-10 max-w-2xl text-body-sm">
              No open roles right now. Check back in the future — we post new
              positions here as they open up.
            </p>
          ) : (
            <ul className="mt-5">
              {careers.map((c, i) => {
                const metaParts = [c.team, c.location, c.employmentType].filter(
                  Boolean,
                );
                return (
                  <li
                    key={c.id}
                    className="border-b border-rule last:border-b-0"
                  >
                    <Link
                      to="/careers/$slug"
                      params={{ slug: c.slug }}
                      style={{ animationDelay: `${Math.min(i, 6) * 70}ms` }}
                      className="rise group grid grid-cols-1 gap-x-8 gap-y-2 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan lg:grid-cols-12 lg:items-center lg:gap-8"
                    >
                      <div className="lg:col-span-7">
                        <h3 className="font-display text-[22px] leading-tight text-fg-strong">
                          <span className="relative inline-block transition-colors duration-300 after:absolute after:-bottom-1 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-cyan after:transition-transform after:duration-300 after:ease-out group-hover:text-cyan group-hover:after:scale-x-100 motion-reduce:after:transition-none">
                            {c.title}
                          </span>
                        </h3>
                        <p className="mt-2 max-w-xl text-body-sm">
                          {c.summary}
                        </p>
                      </div>
                      <div className="text-body-sm lg:col-span-3">
                        {metaParts.map((part, idx) => (
                          <span key={idx}>
                            {idx > 0 ? (
                              <span aria-hidden className="px-2 text-fg-faint">
                                ·
                              </span>
                            ) : null}
                            {part}
                          </span>
                        ))}
                      </div>
                      <div className="lg:col-span-2 lg:text-right">
                        <span className="inline-flex items-center gap-2 border border-rule-strong px-4 py-2 button-text font-semibold text-fg transition-colors duration-300 group-hover:border-cyan group-hover:text-cyan">
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
