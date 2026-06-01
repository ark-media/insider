import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "../components/PageShell";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

type AboutLink = {
  eyebrow: string;
  title: string;
  body: string;
  to: string;
  cta: string;
};

const aboutLinks: AboutLink[] = [
  {
    eyebrow: "Careers",
    title: "Build Ark Media.",
    body: "We're a small team building independent journalism for an audience that wants more than a hot take. Open roles and speculative notes welcome.",
    to: "/careers",
    cta: "Open roles →",
  },
  {
    eyebrow: "Get in touch",
    title: "Press, partnerships, listener mail.",
    body: "Different addresses for different conversations — press inquiries, sponsorships, listener feedback, and member support.",
    to: "/contact",
    cta: "Contact us →",
  },
];

function AboutPage() {
  return (
    <PageShell
      eyebrow="About"
      title="Ark Media."
      lede="Ark Media is a podcast network focused on spirited debate and learning about Jewish life,
Israel, the Middle East, and our larger geopolitics."
    >
      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <h2 className="label text-cyan">
            What Ark Media does
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-12">
            <p className="text-[15.5px] leading-[1.75] text-fg lg:col-span-7">
              Ark Media is a podcast network that explores the big questions
              shaping Jewish life, Israel's future, and our rapidly changing
              world. Through conversations with leading Jewish thinkers from
              around the world, Ark Media aims to build a global community
              driven by curiosity and meaningful dialogue.
            </p>
            <div className="text-body-sm lg:col-span-5">
              <p>
                The company sits behind <em>Call Me Back with Dan Senor</em>,{" "}
                <em>For Heaven's Sake</em> with Donniel Hartman and Yossi
                Klein Halevi, <em>Ark News Daily</em>, and an Ark+ membership
                that funds the work.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {aboutLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="group flex flex-col border border-rule bg-navy-800/40 p-7 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                <div className="label text-cyan">
                  {link.eyebrow}
                </div>
                <h3 className="mt-4 text-h3">
                  {link.title}
                </h3>
                <p className="mt-3 flex-1 text-body-sm">
                  {link.body}
                </p>
                <div className="mt-6 label text-fg-muted transition group-hover:text-cyan">
                  {link.cta}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
