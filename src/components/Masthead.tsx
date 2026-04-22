import { useState } from "react";
import { ArkLogo } from "./ArkLogo";
import { SignInModal } from "./SignInModal";

export function Masthead({ authed }: { authed?: boolean }) {
  const [signInOpen, setSignInOpen] = useState(false);
  return (
    <header className="relative z-20">
      {/* Dateline bar */}
      <div className="border-b border-white/8 bg-navy-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-white/55 sm:px-10">
          <span className="flex items-center gap-2">
            <span className="live-dot inline-block size-1.5 rounded-full bg-cyan" />
            New episodes every Friday
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
          {authed === true ? (
            <a
              href="#setup"
              className="hidden rounded-none border border-cyan bg-cyan px-4 py-1.5 font-semibold text-navy transition hover:bg-transparent hover:text-cyan md:inline-block"
            >
              Go to setup
            </a>
          ) : authed === false ? (
            <button
              type="button"
              onClick={() => setSignInOpen(true)}
              className="hidden rounded-none border border-white/30 px-4 py-1.5 font-semibold text-white transition hover:border-cyan hover:bg-cyan hover:text-navy md:inline-block"
            >
              Sign in
            </button>
          ) : null}
        </nav>
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </header>
  );
}
