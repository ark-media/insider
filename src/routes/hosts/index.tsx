import { createFileRoute, Link } from "@tanstack/react-router";
import { hosts } from "../../data/hosts";
import { PageShell } from "../../components/PageShell";

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
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {hosts.map((h) => (
              <Link
                key={h.slug}
                to="/hosts/$slug"
                params={{ slug: h.slug }}
                className="group block"
              >
                <div className="relative aspect-[4/5] overflow-hidden bg-navy-800 ring-1 ring-white/10">
                  <div
                    className="absolute inset-0 opacity-60"
                    style={{
                      background:
                        "radial-gradient(ellipse 60% 50% at 30% 20%, rgba(62,181,249,0.3) 0%, transparent 65%)",
                    }}
                  />
                  <div
                    className="display absolute inset-0 flex items-center justify-center text-[180px] leading-none text-white/8"
                    aria-hidden
                  >
                    {h.initials}
                  </div>
                  <div className="absolute bottom-5 left-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                    {h.role}
                  </div>
                </div>
                <h3 className="mt-5 font-display text-[22px] leading-tight text-white transition group-hover:text-cyan">
                  {h.name}
                </h3>
                <p className="mt-2 max-w-sm text-[13px] leading-[1.55] text-white/65">
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
