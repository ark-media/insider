import { Link } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";

type FooterLink = { label: string; to: string };

const sections: { title: string; links: FooterLink[] }[] = [
  {
    title: "Listen",
    links: [
      { label: "All shows", to: "/shows" },
      { label: "Call Me Back", to: "/shows/call-me-back" },
      { label: "Inside Call Me Back", to: "/shows/inside-call-me-back" },
      { label: "For Heaven's Sake", to: "/shows/for-heavens-sake" },
      { label: "Ark News Daily", to: "/shows/ark-news-daily" },
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
    title: "Ark+",
    links: [
      { label: "Become a member", to: "/plus" },
      { label: "Gift Ark+", to: "/plus/gift" },
      { label: "Redeem a code", to: "/plus/redeem" },
      { label: "Member dashboard", to: "/account" },
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
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/10 bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="flex items-center gap-3 text-white">
              <ArkLogo height={64} />
            </div>
            <p className="mt-10 max-w-lg text-white">
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Long-form journalism
              </span>
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                for the{" "}
                <span className="display text-cyan">conversation</span>
              </span>
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                that matters.
              </span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 text-[13px] sm:grid-cols-4 lg:col-span-7">
            {sections.map((s) => (
              <FooterCol key={s.title} title={s.title} links={s.links} />
            ))}
          </div>
        </div>

        <div className="mt-20 flex flex-col gap-4 border-t border-white/10 pt-8 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/40 sm:flex-row sm:justify-between">
          <span>© {new Date().getFullYear()} Ark Media LLC</span>
          <span>One membership · One bill · One login</span>
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
              className="text-white/75 transition hover:text-cyan"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
