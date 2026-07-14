import { createFileRoute, Link } from "@tanstack/react-router";
import { hosts, type Host } from "../../data/hosts";
import { PageShell } from "../../components/PageShell";
import { HostArtwork } from "../../components/HostArtwork";
import { PORTRAIT_SIZES } from "../../lib/images";

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
      {/* An <h2> styled as a 14px `label` announces a group boundary to screen
          readers that sighted users can't see. Give it a rule so both get the
          same separation. */}
      <h2 className="label flex items-center gap-4 text-cyan">
        {eyebrow}
        <span aria-hidden="true" className="h-px flex-1 bg-rule" />
      </h2>
      <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-8 lg:grid-cols-4">
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
                sizes={PORTRAIT_SIZES}
                className="max-w-[200px]"
                variant={index % 2 === 0 ? "primary" : "secondary"}
              />
              <h3 className="mt-4 font-display text-[17px] leading-tight text-fg-strong transition group-hover:text-cyan sm:mt-5 sm:text-[22px]">
                {h.name}
              </h3>
              {/* Two-up on phones leaves a ~160px column, so the short bio waits
                  for a wider card. `sr-only` rather than `hidden` — it's the
                  narrow column that makes the bio unreadable, which is a problem
                  for the eye and not for a screen reader, so it stays in the
                  accessibility tree either way. */}
              <p className="mt-2 max-w-sm text-body-sm max-sm:sr-only">
                {h.shortBio}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
