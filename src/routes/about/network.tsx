import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { shows } from "../../data/shows";

export const Route = createFileRoute("/about/network")({
  component: NetworkPage,
});

type NetworkProperty = {
  title: string;
  kind: "Podcast network" | "Newsroom" | "Members' app" | "Membership";
  description: string;
  to: string;
};

const properties: NetworkProperty[] = [
  {
    title: "Ark Media podcasts",
    kind: "Podcast network",
    description:
      "Four free shows and one members-only feed — Call Me Back, For Heaven's Sake, Ark News Daily, Chosen People Problems, and Call Me Back AMA.",
    to: "/podcasts",
  },
  {
    title: "Newsletters",
    kind: "Newsroom",
    description:
      "Curated dispatches from the Ark Media newsroom. Free editions ship to anyone with an email; members-only editions ship to subscribers.",
    to: "/newsletters",
  },
  {
    title: "The Fold",
    kind: "Members' app",
    description:
      "The Fold is Ark Media's members' app. Episode threads, live audio rooms, member meetups, and long-form posts.",
    to: "/fold",
  },
  {
    title: "Ark+ membership",
    kind: "Membership",
    description:
      "Ark+ is every Ark Media podcast ad-free, plus the members-only newsletters. The Fold is the members' app, live events, and Dan's book club. Ark+ & The Fold is both, one membership.",
    to: "/plus",
  },
];

function NetworkPage() {
  return (
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "About", to: "/about" },
            { label: "Network" },
          ]}
        />
      }
      title="The Ark Media network."
      lede="Every property we run, one page. Connecting Jewish voices, near and far."
    >
      <section>
        <div className="page-section">
          <h2 className="label text-cyan">
            Properties
          </h2>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {properties.map((p) => (
              <Link
                key={p.to}
                to={p.to}
                className="group block border border-rule bg-navy-800/40 p-7 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                <div className="label text-cyan">
                  {p.kind}
                </div>
                <h3 className="mt-4 font-display text-[22px] leading-[1.15] text-fg-strong">
                  {p.title}
                </h3>
                <p className="mt-3 text-body-sm">
                  {p.description}
                </p>
                <div className="mt-6 label text-fg-muted transition group-hover:text-cyan">
                  Visit →
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="page-section">
          <h2 className="label text-cyan">
            Shows by name
          </h2>
          <ul className="mt-8 divide-y divide-rule border-y border-rule">
            {shows.map((s) => (
              <li key={s.slug} className="py-5">
                <Link
                  to={s.route}
                  className="group flex flex-col gap-1 transition hover:text-cyan sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                >
                  <span className="font-display text-[18px] leading-[1.2] text-fg-strong group-hover:text-cyan">
                    {s.title}
                  </span>
                  <span className="meta">
                    {s.cadence}
                    {s.paid ? " · Ark+ only" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </PageShell>
  );
}
