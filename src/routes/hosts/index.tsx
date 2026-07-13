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
      <div className="mt-10 grid grid-cols-2 gap-4 sm:gap-8 lg:grid-cols-3">
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
              <h3 className="mt-4 font-display text-[17px] leading-tight text-fg-strong transition group-hover:text-cyan sm:mt-5 sm:text-[22px]">
                {h.name}
              </h3>
              {/* Two-up on phones leaves a ~160px column. The portrait already
                  carries the role label, and the full bio is one tap away on
                  the host page — so the short bio waits for a wider card. */}
              <p className="mt-2 max-w-sm text-body-sm max-sm:hidden">
                {h.shortBio}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
