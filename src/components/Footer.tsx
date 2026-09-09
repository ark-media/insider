import { Link } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";
import { SocialLinks } from "./SocialLinks";

type FooterLink = { label: string; to: string };
type FooterSection = {
  title: string;
  links: FooterLink[];
};

const sections: FooterSection[] = [
  {
    title: "Podcasts",
    links: [
      { label: "Call Me Back", to: "/podcasts/call-me-back" },
      { label: "Ark News Daily", to: "/podcasts/ark-news-daily" },
      { label: "For Heaven's Sake", to: "/podcasts/for-heavens-sake" },
      { label: "Chosen People Problems", to: "/podcasts/chosen-people-problems" },
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
      { label: "The Fold", to: "/fold" },
      { label: "Contact", to: "/contact" },
      { label: "Careers", to: "/careers" },
    ],
  },
  {
    title: "Subscribe",
    links: [
      { label: "Become a member", to: "/plus" },
      { label: "Pricing", to: "/pricing" },
      { label: "Gift", to: "/plus/gift" },
      { label: "FAQ", to: "/faq" },
    ],
  },
];

const legalLinks: FooterLink[] = [
  { label: "Privacy", to: "/privacy" },
  { label: "Terms", to: "/terms" },
];

export function Footer() {
  return (
    <footer className="relative border-t border-rule bg-navy-900">
      <div className="page-section">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <ArkLogo className="h-[26px]" />
            <p className="mt-6 max-w-lg text-fg-strong">
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Connecting Jewish{" "}
                <span className="display-upright text-cyan">Voices</span>,
              </span>
              <span className="display-upright block text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.05]">
                Near and Far.
              </span>
            </p>
            <SocialLinks className="mt-4 -ml-3" />
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-6 text-[13px] sm:gap-x-6 sm:grid-cols-4 lg:col-span-7">
            {sections.map((s) => (
              <FooterCol key={s.title} title={s.title} links={s.links} />
            ))}
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-rule-soft pt-6 sm:flex-row sm:items-center sm:justify-between">
          {/* Legal sits on the copyright line rather than in a column — it's
              reference material, not navigation, and this is where readers look
              for it. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
              © {new Date().getFullYear()} Ark Media LLC
            </span>
            {legalLinks.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="inline-flex min-h-11 items-center text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition hover:text-cyan"
              >
                {l.label}
              </Link>
            ))}
          </div>
          {/* Amazon Associates Operating Agreement §5 — site-wide disclosure
              covering the affiliate buy links on the Book Club page. */}
          <span className="text-[11px] leading-snug text-fg-faint sm:max-w-md sm:text-right">
            As an Amazon Associate, Ark Media earns from qualifying purchases.
          </span>
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
      {/* The footer is the main nav once you've scrolled a long page on a phone,
          so its links carry a 44px target. `py-1` left them at 28px — over the
          WCAG 2.5.8 floor but under every platform's thumb guidance. The rows
          butt together at 44px, so no extra gap is needed. */}
      <ul className="mt-1">
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className="inline-flex min-h-11 items-center text-fg transition hover:text-cyan"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
