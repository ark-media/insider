import { Link } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";
import { useIsSoftLaunch } from "../lib/launchMode";

type FooterLink = { label: string; to: string };
// `hardLaunchOnly` columns and links point at Ark+ membership surfaces, so they
// drop out of the footer during soft launch.
type FooterSection = {
  title: string;
  hardLaunchOnly?: boolean;
  links: (FooterLink & { hardLaunchOnly?: boolean })[];
};

const sections: FooterSection[] = [
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
      { label: "Community", to: "/community", hardLaunchOnly: true },
      { label: "Events", to: "/events" },
      { label: "Contact", to: "/contact" },
      { label: "Careers", to: "/careers" },
    ],
  },
  {
    title: "Ark+",
    hardLaunchOnly: true,
    links: [
      { label: "Become a member", to: "/plus" },
      { label: "Gift Ark+", to: "/plus/gift" },
    ],
  },
];

export function Footer() {
  const isSoftLaunch = useIsSoftLaunch();
  const visibleSections = sections
    .filter((s) => !(isSoftLaunch && s.hardLaunchOnly))
    .map((s) => ({
      ...s,
      links: s.links.filter((l) => !(isSoftLaunch && l.hardLaunchOnly)),
    }));

  return (
    <footer className="relative border-t border-rule bg-navy-900">
      <div className="page-section">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <ArkLogo height={48} />
            <p className="mt-6 max-w-lg text-fg-strong">
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Connecting Jewish{" "}
                <span className="display text-cyan">Voices</span>,
              </span>
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Near and Far.
              </span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-6 text-[13px] sm:gap-x-6 sm:grid-cols-4 lg:col-span-7">
            {visibleSections.map((s) => (
              <FooterCol key={s.title} title={s.title} links={s.links} />
            ))}
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-rule-soft pt-6 sm:flex-row sm:items-center sm:justify-between">
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
      <ul className="mt-2 space-y-0.5">
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className="inline-block py-1 text-fg transition hover:text-cyan"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
