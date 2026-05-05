import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";
import { SignInModal } from "./SignInModal";
import { useSubscriberAuth } from "../lib/subscriberAuth";

const navLinks: { label: string; to: string; matchPrefix?: string }[] = [
  { label: "Shows", to: "/shows", matchPrefix: "/shows" },
  { label: "Newsletters", to: "/newsletters", matchPrefix: "/newsletters" },
  { label: "Community", to: "/community" },
  { label: "Events", to: "/events" },
  { label: "About", to: "/about" },
  { label: "Ark+", to: "/plus", matchPrefix: "/plus" },
];

const ISRAEL_VOTES_PATH = "/israel-votes";

function isActive(pathname: string, link: (typeof navLinks)[number]) {
  return link.matchPrefix
    ? pathname.startsWith(link.matchPrefix)
    : pathname === link.to;
}

export function PublicMasthead() {
  const [signInOpen, setSignInOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { state, signOut } = useSubscriberAuth();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setAccountOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  return (
    <header className="relative z-20">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 pt-6 pb-4 sm:px-10 sm:pt-8">
        <Link
          to="/"
          aria-label="Ark Media — home"
          className="group flex items-center gap-3 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
        >
          <ArkLogo height={56} />
        </Link>

        <nav
          aria-label="Primary"
          className="flex items-center gap-1 text-[13px] text-white/70 sm:gap-6"
        >
          {navLinks.map((link) => {
            const active = isActive(location.pathname, link);
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={active ? "page" : undefined}
                className={`relative hidden py-1 transition hover:text-white sm:inline-block ${
                  active ? "text-white" : ""
                }`}
              >
                {link.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-1 left-0 right-0 h-px bg-cyan"
                  />
                ) : null}
              </Link>
            );
          })}

          <Link
            to={ISRAEL_VOTES_PATH}
            aria-current={
              location.pathname === ISRAEL_VOTES_PATH ? "page" : undefined
            }
            className={`hidden px-4 py-1.5 font-display text-[12px] font-bold uppercase tracking-[0.18em] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:inline-block ${
              location.pathname === ISRAEL_VOTES_PATH
                ? "bg-cyan text-navy"
                : "bg-white text-navy hover:bg-cyan"
            }`}
          >
            Israel Votes
          </Link>

          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setAccountOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              className="border border-white/30 px-4 py-1.5 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              {state.kind === "member" ? "Account" : "Log in"}
            </button>

            {accountOpen ? (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-64 border border-white/15 bg-navy-900/95 p-4 text-[13px] text-white/85 shadow-xl backdrop-blur"
              >
                {state.kind === "member" ? (
                  <MemberMenu
                    email={state.me.email}
                    onSignOut={async () => {
                      await signOut();
                      setAccountOpen(false);
                    }}
                    onClose={() => setAccountOpen(false)}
                  />
                ) : (
                  <GuestMenu
                    onSignIn={() => {
                      setAccountOpen(false);
                      setSignInOpen(true);
                    }}
                    onClose={() => setAccountOpen(false)}
                  />
                )}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            className="ml-1 inline-flex size-10 items-center justify-center text-white transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:hidden"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="square"
            >
              {mobileOpen ? (
                <path d="M4 4l12 12M16 4L4 16" />
              ) : (
                <>
                  <path d="M3 6h14" />
                  <path d="M3 14h14" />
                </>
              )}
            </svg>
          </button>
        </nav>
      </div>

      {mobileOpen ? (
        <div
          id="mobile-nav"
          className="border-t border-white/10 bg-navy-900/95 backdrop-blur sm:hidden"
        >
          <nav
            aria-label="Primary mobile"
            className="mx-auto flex max-w-[1280px] flex-col px-6 py-4"
          >
            <Link
              to={ISRAEL_VOTES_PATH}
              aria-current={
                location.pathname === ISRAEL_VOTES_PATH ? "page" : undefined
              }
              onClick={() => setMobileOpen(false)}
              className={`mb-3 block px-4 py-3 text-center font-display text-[13px] font-bold uppercase tracking-[0.18em] text-navy transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                location.pathname === ISRAEL_VOTES_PATH
                  ? "bg-cyan"
                  : "bg-white hover:bg-cyan"
              }`}
            >
              Israel Votes
            </Link>
            {navLinks.map((link) => {
              const active = isActive(location.pathname, link);
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center justify-between border-b border-white/8 py-3 text-[14px] transition last:border-b-0 ${
                    active ? "text-cyan" : "text-white/85 hover:text-white"
                  }`}
                >
                  <span>{link.label}</span>
                  <span
                    aria-hidden="true"
                    className={`text-[12px] tracking-[0.22em] ${
                      active ? "text-cyan" : "text-white/30"
                    }`}
                  >
                    →
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}

      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </header>
  );
}

function GuestMenu({
  onSignIn,
  onClose,
}: {
  onSignIn: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Member sign in
      </p>
      <p className="text-[12px] leading-snug text-white/60">
        Already an Ark+ member? Sign in to access your account.
      </p>
      <button
        type="button"
        onClick={onSignIn}
        className="w-full border border-cyan bg-cyan px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Sign in
      </button>
      <Link
        to="/plus"
        onClick={onClose}
        className="block w-full border border-white/25 px-3 py-2 text-center text-[12px] font-semibold uppercase tracking-[0.18em] text-white transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Become a member
      </Link>
    </div>
  );
}

function MemberMenu({
  email,
  onSignOut,
  onClose,
}: {
  email: string;
  onSignOut: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        Signed in
      </p>
      <p className="truncate text-[12px] text-white/80" title={email}>
        {email}
      </p>
      <Link
        to="/account"
        onClick={onClose}
        className="block w-full border border-cyan bg-cyan px-3 py-2 text-center text-[12px] font-semibold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Member dashboard
      </Link>
      <button
        type="button"
        onClick={onSignOut}
        className="w-full border border-white/25 px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-white/80 transition hover:border-white/60 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Sign out
      </button>
    </div>
  );
}
