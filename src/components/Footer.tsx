import { Link } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";

type FooterLink = { label: string; to: string };

const sections: { title: string; links: FooterLink[] }[] = [
  {
    title: "Podcasts",
    links: [
      { label: "All podcasts", to: "/podcasts" },
      { label: "Call Me Back", to: "/podcasts/call-me-back" },
      { label: "What's Your Number", to: "/podcasts/whats-your-number" },
      { label: "For Heaven's Sake", to: "/podcasts/for-heavens-sake" },
      { label: "Ark News Daily", to: "/podcasts/ark-news-daily" },
    ],
  },
  {
    title: "Read",
    links: [
      { label: "Newsletters", to: "/newsletters" },
      { label: "Hosts", to: "/hosts" },
      { label: "About", to: "/about" },
      { label: "Israel Votes", to: "/israel-votes" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "Community", to: "/community" },
      { label: "Events", to: "/events" },
      { label: "Contact", to: "/contact" },
      { label: "Careers", to: "/careers" },
    ],
  },
  {
    title: "Ark+",
    links: [
      { label: "Become a member", to: "/plus" },
      { label: "Gift Ark+", to: "/plus/gift" },
      { label: "Member dashboard", to: "/account" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="flex items-center gap-3 text-fg-strong">
              <ArkLogo height={64} />
            </div>
            <p className="mt-10 max-w-lg text-fg-strong">
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Connecting Jewish{" "}
                <span className="display text-cyan">Voices</span>,
              </span>
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Near and Far.
              </span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-8 text-[13px] sm:gap-x-8 sm:grid-cols-4 lg:col-span-7">
            {sections.map((s) => (
              <FooterCol key={s.title} title={s.title} links={s.links} />
            ))}
          </div>
        </div>

        <div className="mt-20 flex flex-col gap-6 border-t border-rule pt-8 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
            © {new Date().getFullYear()} Ark Media LLC
          </span>
          {/* Social links are hidden until real Ark Media profile URLs exist —
              SocialLinks.tsx still holds the (placeholder) markup to re-enable. */}
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        {title}
      </div>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className="text-fg transition hover:text-cyan"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
