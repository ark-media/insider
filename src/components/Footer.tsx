import { ArkLogo } from "./ArkLogo";

export function Footer() {
  return (
    <footer className="relative border-t border-white/10 bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-6">
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

          <div className="grid grid-cols-2 gap-8 text-[13px] sm:grid-cols-3 lg:col-span-6 lg:pl-10">
            <FooterCol title="Insider" links={["Pricing", "Gifts", "Sign in", "Manage account"]} />
            <FooterCol title="Show" links={["Episodes", "Guests", "Transcripts", "RSS"]} />
            <FooterCol title="Help" links={["FAQ", "Contact", "Privacy", "Terms"]} />
          </div>
        </div>

        <div className="mt-20 flex flex-col gap-4 border-t border-white/10 pt-8 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/40 sm:flex-row sm:justify-between">
          <span>© {new Date().getFullYear()} Ark Media LLC</span>
          <span>Powered by Supporting Cast</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        {title}
      </div>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l}>
            <a href="#" className="text-white/75 transition hover:text-cyan">
              {l}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
