import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useAuth0 } from "@auth0/auth0-react";
import { ArkLogo } from "./ArkLogo";
import { useSubscriberAuth } from "../lib/subscriberAuth";

const ALL_NAV_LINKS: { label: string; to: string; matchPrefix?: string }[] = [
  { label: "Shows", to: "/shows", matchPrefix: "/shows" },
  { label: "Newsletters", to: "/newsletters", matchPrefix: "/newsletters" },
  { label: "Community", to: "/community" },
  { label: "Events", to: "/events" },
  { label: "About", to: "/about" },
  { label: "Ark+", to: "/plus", matchPrefix: "/plus" },
];

const ISRAEL_VOTES_PATH = "/israel-votes";

function isActive(pathname: string, link: (typeof ALL_NAV_LINKS)[number]) {
  return link.matchPrefix
    ? pathname.startsWith(link.matchPrefix)
    : pathname === link.to;
}

export function PublicMasthead() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { state, signOut } = useSubscriberAuth();
  const { loginWithRedirect } = useAuth0();
  const isMember = state.kind === "member";
  const navLinks = ALL_NAV_LINKS.filter((link) => {
    if (link.to === "/plus") return !isMember;
    if (link.to === "/community") return isMember;
    return true;
  });
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
          className="group flex items-center gap-3 text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
        >
          <ArkLogo height={56} />
        </Link>

        <nav
          aria-label="Primary"
          className="flex items-center gap-1 text-[13px] text-fg-muted sm:gap-6"
        >
          {navLinks.map((link) => {
            const active = isActive(location.pathname, link);
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={active ? "page" : undefined}
                className={`relative hidden min-h-11 items-center py-2 transition hover:text-fg-strong sm:inline-flex ${
                  active ? "text-fg-strong" : ""
                }`}
              >
                {link.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-1 left-0 right-0 h-px bg-cyan"
                  />
                ) : null}
              </Link>
            );
          })}

          {/* Israel Votes pill — visible at ALL breakpoints (flagship campaign) */}
          <Link
            to={ISRAEL_VOTES_PATH}
            aria-current={
              location.pathname === ISRAEL_VOTES_PATH ? "page" : undefined
            }
            className={`inline-flex min-h-11 items-center px-3 font-display text-[11px] font-bold uppercase tracking-button transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:px-4 sm:text-[12px] ${
              location.pathname === ISRAEL_VOTES_PATH
                ? "bg-cyan text-navy"
                : "bg-fg-strong text-navy hover:bg-cyan"
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
              disabled={state.kind === "loading"}
              className="hidden min-h-11 items-center border border-rule-strong px-4 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60 sm:inline-flex"
            >
              {state.kind === "member" ? (
                "Account"
              ) : state.kind === "loading" ? (
                <span aria-label="Loading account state" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-rule-strong border-t-cyan motion-reduce:animate-none" />
              ) : (
                "Log in"
              )}
            </button>

            {accountOpen ? (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-64 border border-rule bg-navy-900 p-4 text-[13px] text-fg shadow-xl"
              >
                {state.kind === "member" ? (
                  <MemberMenu
                    email={state.me.email}
                    onSignOut={() => {
                      setAccountOpen(false);
                      signOut();
                    }}
                    onClose={() => setAccountOpen(false)}
                  />
                ) : (
                  <GuestMenu
                    onSignIn={() => {
                      setAccountOpen(false);
                      void loginWithRedirect();
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
            className="ml-1 inline-flex min-h-11 min-w-11 items-center justify-center text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:hidden"
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
          className="border-t border-rule bg-navy-900 sm:hidden"
        >
          <nav
            aria-label="Primary mobile"
            className="mx-auto flex max-w-[1280px] flex-col px-6 py-4"
          >
            {/* Account button is hidden in the top bar on mobile (Israel Votes
                takes that slot); surface it as the first item here. */}
            {state.kind === "member" ? (
              <Link
                to="/account"
                onClick={() => setMobileOpen(false)}
                className="mb-3 inline-flex min-h-11 items-center justify-center border border-rule-strong px-4 font-display text-[13px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan"
              >
                Account
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  void loginWithRedirect();
                }}
                className="mb-3 inline-flex min-h-11 items-center justify-center border border-rule-strong px-4 font-display text-[13px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan"
              >
                Log in
              </button>
            )}
            {navLinks.map((link) => {
              const active = isActive(location.pathname, link);
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  className={`flex min-h-11 items-center justify-between border-b border-rule-soft py-3 text-[14px] transition last:border-b-0 ${
                    active ? "text-cyan" : "text-fg hover:text-fg-strong"
                  }`}
                >
                  <span>{link.label}</span>
                  <span
                    aria-hidden="true"
                    className={`text-[12px] tracking-eyebrow ${
                      active ? "text-cyan" : "text-fg-faint"
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
      <p className="eyebrow">Member sign in</p>
      <p className="text-[12px] leading-snug text-fg-muted">
        Already an Ark+ member? Sign in to access your account.
      </p>
      <button
        type="button"
        onClick={onSignIn}
        className="inline-flex min-h-11 w-full items-center justify-center border border-cyan bg-cyan px-3 text-[12px] font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Sign in
      </button>
      <Link
        to="/plus"
        onClick={onClose}
        className="inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-3 text-center text-[12px] font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
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
      <p className="eyebrow">Signed in</p>
      <p className="truncate text-[12px] text-fg" title={email}>
        {email}
      </p>
      <Link
        to="/account"
        onClick={onClose}
        className="inline-flex min-h-11 w-full items-center justify-center border border-cyan bg-cyan px-3 text-center text-[12px] font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Member dashboard
      </Link>
      <button
        type="button"
        onClick={onSignOut}
        className="inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-3 text-[12px] font-semibold uppercase tracking-button text-fg-muted transition hover:border-rule-strong hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Sign out
      </button>
    </div>
  );
}
