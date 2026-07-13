import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getHost } from "../../data/hosts";
import { getShow } from "../../data/shows";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { HostArtwork } from "../../components/HostArtwork";

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
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Hosts", to: "/hosts" },
            { label: host.name },
          ]}
        />
      }
      title={host.name}
      lede={host.role}
    >
      <section>
        <div className="page-gutter grid grid-cols-1 gap-8 py-10 sm:py-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <HostArtwork
              initials={host.initials}
              role={host.role}
              photo={host.headshot}
              name={host.name}
              // Full-width on phones, `lg:col-span-5` of 12 above that. The
              // 100vw tail is what keeps the page's lead portrait sharp.
              sizes="(min-width: 1024px) 40vw, 100vw"
            />
          </div>
          <div className="lg:col-span-7">
            <h2 className="eyebrow">Bio</h2>
            <p className="mt-6 max-w-2xl text-body-lg">
              {host.longBio}
            </p>

            {shows.length > 0 ? (
              <>
                <h2 className="mt-12 eyebrow">Shows</h2>
                <ul
                  className={`mt-4 grid grid-cols-1 gap-3 ${
                    shows.length > 1 ? "sm:grid-cols-2" : ""
                  }`}
                >
                  {shows.map((s) => (
                    <li key={s.slug}>
                      <Link
                        to={s.route}
                        className="group flex h-full flex-col border border-rule bg-navy-800/40 p-5 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                      >
                        <h3 className="font-display text-[18px] leading-[1.2] text-fg-strong">
                          {s.title}
                        </h3>
                        <p className="mt-2 text-body-sm">
                          {s.tagline}
                        </p>
                        <div className="mt-auto pt-3 eyebrow text-fg-faint transition group-hover:text-cyan">
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
