import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "../components/PageShell";

export const Route = createFileRoute("/careers")({
  component: CareersPage,
});

const openings: {
  title: string;
  team: string;
  location: string;
  description: string;
}[] = [
  {
    title: "Senior Producer, Call Me Back",
    team: "Audio",
    location: "New York or Tel Aviv",
    description:
      "Run point on weekly production for the Call Me Back franchise. Editorial judgment, calm under deadline, podcast craft.",
  },
  {
    title: "Newsroom editor",
    team: "Editorial",
    location: "Remote (US/Israel)",
    description:
      "Edit and direct daily news products — Ark News Daily and Ark Daily — and shape the editorial voice across the network.",
  },
  {
    title: "Community lead",
    team: "Membership",
    location: "Remote",
    description:
      "Build and run the Ark+ community. Programming, member events, and the day-to-day editorial of the room.",
  },
];

function CareersPage() {
  return (
    <PageShell
      eyebrow="Careers"
      title="Build Ark Media."
      lede="We're a small team building independent journalism for an audience that wants more than a hot take. Roles below; speculative notes welcome."
    >
      <section className="border-t border-white/10 bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Open roles
          </div>
          <ul className="mt-10 divide-y divide-white/10 border-y border-white/10">
            {openings.map((o) => (
              <li key={o.title} className="py-6">
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-8">
                  <div className="lg:col-span-7">
                    <h3 className="font-display text-[22px] leading-tight text-white">
                      {o.title}
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-[1.6] text-white/65">
                      {o.description}
                    </p>
                  </div>
                  <div className="text-[13px] text-white/55 lg:col-span-3">
                    {o.team} · {o.location}
                  </div>
                  <div className="lg:col-span-2 lg:text-right">
                    <a
                      href="mailto:careers@arkmedia.org"
                      className="inline-flex items-center gap-2 border border-white/25 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                    >
                      Apply →
                    </a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-white/10 bg-navy-800/40">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Don't see your role?
          </div>
          <p className="mt-6 max-w-2xl text-[14.5px] leading-[1.7] text-white/70">
            We hire opportunistically when the fit is right. Send a note —
            short is fine — and a couple of links to{" "}
            <a
              href="mailto:careers@arkmedia.org"
              className="text-cyan underline-offset-4 hover:underline"
            >
              careers@arkmedia.org
            </a>
            .
          </p>
        </div>
      </section>
    </PageShell>
  );
}
