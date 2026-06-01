import { createFileRoute, Link } from "@tanstack/react-router";
import { hosts, type Host } from "../../data/hosts";
import { PageShell } from "../../components/PageShell";
import { HostArtwork } from "../../components/HostArtwork";

export const Route = createFileRoute("/hosts/")({
  component: HostsHub,
});

const showHosts = hosts.filter((h) => h.kind === "host");
const showContributors = hosts.filter((h) => h.kind === "contributor");

function HostsHub() {
  return (
    <PageShell
      title="The bylines."
      lede="The hosts and contributors behind Ark Media."
    >
      <section>
        <div className="page-section">
          <PeopleGrid eyebrow="Hosts" people={showHosts} startIndex={0} />
          {showContributors.length > 0 ? (
            <PeopleGrid
              eyebrow="Contributors"
              people={showContributors}
              startIndex={showHosts.length}
              className="mt-20"
            />
          ) : null}
        </div>
      </section>
    </PageShell>
  );
}

function PeopleGrid({
  eyebrow,
  people,
  startIndex,
  className,
}: {
  eyebrow: string;
  people: Host[];
  startIndex: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <h2 className="label text-cyan">
        {eyebrow}
      </h2>
      <div className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {people.map((h, i) => {
          const index = startIndex + i;
          return (
            <Link
              key={h.slug}
              to="/hosts/$slug"
              params={{ slug: h.slug }}
              className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
            >
              <HostArtwork
                initials={h.initials}
                role={h.role}
                photo={h.headshot}
                name={h.name}
                variant={index % 2 === 0 ? "primary" : "secondary"}
              />
              <h3 className="mt-5 font-display text-[22px] leading-tight text-fg-strong transition group-hover:text-cyan">
                {h.name}
              </h3>
              <p className="mt-2 max-w-sm text-body-sm">
                {h.shortBio}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
