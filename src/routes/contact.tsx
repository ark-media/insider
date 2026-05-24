import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "../components/PageShell";
import { contactEmails } from "../config/urls";

export const Route = createFileRoute("/contact")({
  component: ContactPage,
});

const lanes: { eyebrow: string; title: string; email: string; body: string }[] = [
  {
    eyebrow: "Listener mail",
    title: "For show ideas, feedback, and corrections",
    email: contactEmails.general,
    body: "We read every note. Send a thought, a sharper way to put a thing, or a correction we missed.",
  },
  {
    eyebrow: "Press",
    title: "For press, interviews, and media inquiries",
    email: contactEmails.press,
    body: "Booking requests for hosts, interview availability, and press credentials.",
  },
  {
    eyebrow: "Partnerships",
    title: "For sponsorships and partnerships",
    email: contactEmails.partnerships,
    body: "Brand partnerships, syndication, and editorial collaborations.",
  },
  {
    eyebrow: "Member support",
    title: "For Ark+ membership questions",
    email: contactEmails.support,
    body: "Trouble with your private feed, billing, the Circle app, or anything else Ark+. Quickest reply if you write from the email on file.",
  },
];

function ContactPage() {
  return (
    <PageShell
      eyebrow="Contact"
      title="Get in touch."
      lede="A few addresses for a few different conversations."
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {lanes.map((l) => (
              <a
                key={l.email}
                href={`mailto:${l.email}`}
                className="group block border border-rule bg-navy-800/40 p-7 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  {l.eyebrow}
                </div>
                <h2 className="mt-4 font-display text-[20px] leading-tight text-fg-strong">
                  {l.title}
                </h2>
                <p className="mt-3 text-[13.5px] leading-[1.6] text-fg-muted">
                  {l.body}
                </p>
                <div className="mt-5 text-[14px] text-fg transition group-hover:text-cyan">
                  {l.email} →
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
