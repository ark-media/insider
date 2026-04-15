import { ArkLogo } from "./ArkLogo";

export function Masthead() {
  return (
    <header className="relative z-20">
      {/* Dateline bar */}
      <div className="border-b border-white/8 bg-navy-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-white/55 sm:px-10">
          <span className="hidden sm:inline">Vol. I · No. 214</span>
          <span className="flex items-center gap-2">
            <span className="live-dot inline-block size-1.5 rounded-full bg-cyan" />
            New episodes Wed &amp; Fri
          </span>
          <span className="hidden text-cyan sm:inline">Subscriber Edition</span>
        </div>
      </div>

      {/* Main nav */}
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 pt-6 pb-4 sm:px-10 sm:pt-8">
        <a href="/" className="group flex items-center gap-3 text-white">
          <ArkLogo height={60} />
          <span className="ml-2 hidden h-4 w-px bg-white/25 sm:inline-block" />
          <span className="ml-2 hidden text-[11px] font-medium uppercase tracking-[0.22em] text-cyan sm:inline">
            The Insider
          </span>
        </a>

        <nav className="flex items-center gap-6 text-[13px] text-white/70">
          <a href="#pricing" className="transition hover:text-white">Pricing</a>
          <a href="#benefits" className="hidden transition hover:text-white sm:inline">Benefits</a>
          <a href="#faq" className="hidden transition hover:text-white sm:inline">FAQ</a>
          <a href="#gifts" className="hidden transition hover:text-white md:inline">Gifts</a>
          <a
            href="#login"
            className="hidden rounded-none border border-white/30 px-4 py-1.5 font-semibold text-white transition hover:border-cyan hover:bg-cyan hover:text-navy md:inline-block"
          >
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}
