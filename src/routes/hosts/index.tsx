import { createFileRoute, Link } from "@tanstack/react-router";
import { hosts } from "../../data/hosts";
import { PageShell } from "../../components/PageShell";
import { HostArtwork } from "../../components/HostArtwork";

export const Route = createFileRoute("/hosts/")({
  component: HostsHub,
});

function HostsHub() {
  return (
    <PageShell
      eyebrow="Hosts"
      title="The bylines."
      lede="The hosts and recurring voices behind Ark Media."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {hosts.map((h, i) => (
              <Link
                key={h.slug}
                to="/hosts/$slug"
                params={{ slug: h.slug }}
                className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
              >
                <HostArtwork
                  initials={h.initials}
                  role={h.role}
                  variant={i % 2 === 0 ? "primary" : "secondary"}
                />
                <h3 className="mt-5 font-display text-[22px] leading-tight text-fg-strong transition group-hover:text-cyan">
                  {h.name}
                </h3>
                <p className="mt-2 max-w-sm text-[13px] leading-[1.55] text-fg-muted">
                  {h.shortBio}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
