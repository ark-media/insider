import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getHost } from "../../data/hosts";
import { getShow } from "../../data/shows";
import { PageShell } from "../../components/PageShell";

export const Route = createFileRoute("/hosts/$slug")({
  loader: ({ params }) => {
    const host = getHost(params.slug);
    if (!host) throw notFound();
    return { host };
  },
  component: HostPage,
});

function HostPage() {
  const { host } = Route.useLoaderData();
  const shows = host.shows
    .map((s) => getShow(s))
    .filter((s): s is NonNullable<ReturnType<typeof getShow>> => Boolean(s));

  return (
    <PageShell eyebrow="Host" title={host.name} lede={host.role}>
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="relative aspect-[4/5] overflow-hidden bg-navy-800 ring-1 ring-white/10">
              <div
                className="absolute inset-0 opacity-60"
                style={{
                  background:
                    "radial-gradient(ellipse 60% 50% at 30% 20%, rgba(62,181,249,0.3) 0%, transparent 65%)",
                }}
              />
              <div
                className="display absolute inset-0 flex items-center justify-center text-[260px] leading-none text-white/8"
                aria-hidden
              >
                {host.initials}
              </div>
              <div className="absolute bottom-5 left-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                {host.role}
              </div>
            </div>
          </div>
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Bio
            </div>
            <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-white/80">
              {host.longBio}
            </p>

            {shows.length > 0 ? (
              <>
                <div className="mt-12 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  Shows
                </div>
                <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {shows.map((s) => (
                    <li key={s.slug}>
                      <Link
                        to={s.route}
                        className="group block border border-white/12 bg-navy-800/40 p-5 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                      >
                        <div className="font-display text-[18px] leading-[1.2] text-white">
                          {s.title}
                        </div>
                        <p className="mt-2 text-[13px] leading-[1.5] text-white/60">
                          {s.tagline}
                        </p>
                        <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45 transition group-hover:text-cyan">
                          Visit show →
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
