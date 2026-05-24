import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useAuth0 } from "@auth0/auth0-react";
import { ArkLogo } from "./ArkLogo";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { useTheme } from "../lib/theme";
import { shows } from "../data/shows";

// Nav order per Figma IA spec: Podcasts | Community | Newsletters | Israel
// Votes | Ark+ | About | Account. Israel Votes renders as a pill for campaign
// emphasis; Account is its own dropdown.
//
// Items render in array order — reorder here, the nav reflows. Each item's
// variant chooses the renderer (text link / pill / menu). `hideWhen` removes
// the item for the named auth state ('member' or 'guest'). Items with
// `children` open a dropdown; the parent link stays clickable.
type NavVariant = "text" | "pill" | "menu";
type NavChild = {
  label: string;
  to: string;
  description?: string;
  paid?: boolean;
};
type NavItem = {
  label: string;
  to: string;
  variant: NavVariant;
  matchPrefix?: string;
  hideWhen?: "member" | "guest";
  children?: NavChild[];
};

const podcastChildren: NavChild[] = shows.map((show) => ({
  label: show.shortTitle,
  to: show.route,
  description: show.cadence,
  paid: show.paid,
}));

const NAV_ITEMS: NavItem[] = [
  {
    variant: "menu",
    label: "Podcasts",
    to: "/podcasts",
    matchPrefix: "/podcasts",
    children: podcastChildren,
  },
  {
    variant: "menu",
    label: "Community",
    to: "/community",
    matchPrefix: "/community",
    hideWhen: "guest",
    children: [{ label: "Upcoming Events", to: "/events" }],
  },
  { variant: "text", label: "Newsletters", to: "/newsletters", matchPrefix: "/newsletters" },
  {
    variant: "menu",
    label: "Ark+",
    to: "/plus",
    matchPrefix: "/plus",
    hideWhen: "member",
    children: [{ label: "Gift Ark+", to: "/plus/gift" }],
  },
  {
    variant: "menu",
    label: "About",
    to: "/about",
    matchPrefix: "/about",
    children: [
      { label: "Network", to: "/about/network" },
      { label: "Careers", to: "/careers" },
      { label: "Get in touch", to: "/contact" },
    ],
  },
  { variant: "pill", label: "Israel Votes", to: "/israel-votes" },
];

function isActive(pathname: string, item: Pick<NavItem, "to" | "matchPrefix" | "children">) {
  if (item.matchPrefix && pathname.startsWith(item.matchPrefix)) return true;
  if (pathname === item.to) return true;
  if (item.children?.some((c) => pathname === c.to || pathname.startsWith(`${c.to}/`))) {
    return true;
  }
  return false;
}

function visibleNavItems(isMember: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (item.hideWhen === "member") return !isMember;
    if (item.hideWhen === "guest") return isMember;
    return true;
  });
}

export function PublicMasthead() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { state, signOut } = useSubscriberAuth();
  const { loginWithRedirect } = useAuth0();
  const isMember = state.kind === "member";
  const navItems = visibleNavItems(isMember);
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
    <header className="sticky top-0 z-20 border-b border-rule-soft bg-navy-900">
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
          {navItems.map((item) => {
            switch (item.variant) {
              case "menu":
                return (
                  <NavMenu
                    key={item.to}
                    item={item}
                    pathname={location.pathname}
                  />
                );
              case "pill":
                return (
                  <NavPillLink
                    key={item.to}
                    item={item}
                    pathname={location.pathname}
                  />
                );
              case "text":
                return (
                  <NavTextLink
                    key={item.to}
                    item={item}
                    pathname={location.pathname}
                  />
                );
            }
          })}

          <ThemeToggle />

          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setAccountOpen((v) => !v)}
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
            {navItems
              // Pills already render in the top bar at every breakpoint;
              // skip them in the dropdown so they don't appear twice.
              .filter((item) => item.variant !== "pill")
              .map((item) => {
                const active = isActive(location.pathname, item);
                if (item.variant === "menu") {
                  return (
                    <MobileNavSection
                      key={item.to}
                      item={item}
                      active={active}
                      pathname={location.pathname}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  );
                }
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setMobileOpen(false)}
                    className={`flex min-h-11 items-center justify-between border-b border-rule-soft py-3 text-[14px] transition last:border-b-0 ${
                      active ? "text-cyan" : "text-fg hover:text-fg-strong"
                    }`}
                  >
                    <span>{item.label}</span>
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

function NavMenu({ item, pathname }: { item: NavItem; pathname: string }) {
  const [open, setOpen] = useState(false);
  const [syncedPathname, setSyncedPathname] = useState(pathname);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const menuId = useId();
  const active = isActive(pathname, item);
  const children = item.children ?? [];
  const hasDescriptions = children.some((c) => c.description);

  // Close the dropdown when the route changes — navigating away should
  // dismiss the menu. Done during render rather than in an effect to avoid a
  // cascading re-render.
  if (syncedPathname !== pathname) {
    setSyncedPathname(pathname);
    setOpen(false);
  }

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={containerRef}
      className="relative hidden sm:block"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        cancelClose();
        setOpen(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          scheduleClose();
        }
      }}
    >
      <Link
        to={item.to}
        aria-current={active ? "page" : undefined}
        aria-expanded={open}
        aria-controls={menuId}
        className={`relative inline-flex min-h-11 items-center py-2 transition hover:text-fg-strong ${
          active ? "text-fg-strong" : ""
        }`}
      >
        {item.label}
        {active ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1 left-0 right-0 h-px bg-cyan"
          />
        ) : null}
      </Link>
      {open ? (
        <div
          id={menuId}
          className={`absolute left-0 top-full z-30 mt-1 border border-rule bg-navy-900 p-2 shadow-xl ${
            hasDescriptions ? "w-72" : "w-56"
          }`}
        >
          {children.map((child) => {
            const childActive =
              pathname === child.to || pathname.startsWith(`${child.to}/`);
            return (
              <Link
                key={child.to}
                to={child.to}
                aria-current={childActive ? "page" : undefined}
                className={`flex items-start justify-between gap-3 border-b border-rule-soft px-3 py-3 text-[13px] transition last:border-b-0 hover:bg-navy-800/60 ${
                  childActive ? "text-cyan" : "text-fg hover:text-fg-strong"
                }`}
              >
                <span className="flex-1">
                  <span className="block font-display text-[13px] leading-tight text-fg-strong">
                    {child.label}
                  </span>
                  {child.description ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-fg-muted">
                      {child.description}
                    </span>
                  ) : null}
                </span>
                {child.paid ? (
                  <span className="mt-0.5 border border-cyan/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-button text-cyan">
                    Ark+
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MobileNavSection({
  item,
  active,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  pathname: string;
  onNavigate: () => void;
}) {
  const children = item.children ?? [];
  return (
    <div className="border-b border-rule-soft py-1 last:border-b-0">
      <Link
        to={item.to}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        className={`flex min-h-11 items-center justify-between py-3 text-[14px] transition ${
          active ? "text-cyan" : "text-fg hover:text-fg-strong"
        }`}
      >
        <span>{item.label}</span>
        <span
          aria-hidden="true"
          className={`text-[12px] tracking-eyebrow ${
            active ? "text-cyan" : "text-fg-faint"
          }`}
        >
          →
        </span>
      </Link>
      {children.length > 0 ? (
        <ul className="mb-2 ml-3 border-l border-rule-soft pl-3">
          {children.map((child) => {
            const childActive =
              pathname === child.to || pathname.startsWith(`${child.to}/`);
            return (
              <li key={child.to}>
                <Link
                  to={child.to}
                  aria-current={childActive ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex min-h-10 items-center justify-between py-2 text-[13px] transition ${
                    childActive ? "text-cyan" : "text-fg-muted hover:text-fg-strong"
                  }`}
                >
                  <span>{child.label}</span>
                  {child.paid ? (
                    <span className="border border-cyan/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-button text-cyan">
                      Ark+
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function NavTextLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const active = isActive(pathname, item);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={`relative hidden min-h-11 items-center py-2 transition hover:text-fg-strong sm:inline-flex ${
        active ? "text-fg-strong" : ""
      }`}
    >
      {item.label}
      {active ? (
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-0 right-0 h-px bg-cyan"
        />
      ) : null}
    </Link>
  );
}

// Visible at all breakpoints (campaign emphasis); rendered as a solid pill
// rather than the underline-on-active treatment that text links use.
function NavPillLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const active = isActive(pathname, item);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center px-3 font-display text-[11px] font-bold uppercase tracking-button transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:px-4 sm:text-[12px] ${
        active
          ? "bg-cyan text-navy"
          : "bg-fg-strong text-navy-900 hover:bg-cyan hover:text-navy"
      }`}
    >
      {item.label}
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-pressed={isLight}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      className="inline-flex min-h-11 min-w-11 items-center justify-center text-fg-muted transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      {isLight ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16.5 12.5A6.5 6.5 0 0 1 7.5 3.5a7 7 0 1 0 9 9z" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="10" cy="10" r="3.25" />
          <path d="M10 1.5v2M10 16.5v2M3.5 10h-2M18.5 10h-2M5.05 5.05L3.64 3.64M16.36 16.36l-1.41-1.41M5.05 14.95l-1.41 1.41M16.36 3.64l-1.41 1.41" />
        </svg>
      )}
    </button>
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
        Account settings
      </Link>
      <Link
        to="/setup"
        onClick={onClose}
        className="inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-3 text-center text-[12px] font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Set up your feed
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
