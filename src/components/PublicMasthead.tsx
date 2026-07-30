import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "@tanstack/react-router";
import { ArkLogo } from "./ArkLogo";
import { Spinner } from "./Spinner";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { shows } from "../data/shows";

// Nav order per Figma IA spec: Podcasts | Community | Newsletters | Israel
// Votes | Subscribe | About | Account. Israel Votes renders as a pill for
// campaign emphasis; Account is its own dropdown.
//
// Items render in array order — reorder here, the nav reflows. Each item's
// variant chooses the renderer (text link / pill / menu). `hideWhen` removes
// the item for the named tier ('subscriber' = hide from paid; 'nonSubscriber'
// = hide from guests + free users). Items with `children` open a dropdown;
// the parent link stays clickable.
type NavVariant = "text" | "pill" | "menu";
type NavChild = {
  label: string;
  to: string;
  hash?: string;
  description?: string;
  paid?: boolean;
  /** A shortcut to a page that another nav item owns — doesn't light up this parent. */
  crossLink?: boolean;
};
type NavItem = {
  label: string;
  to: string;
  variant: NavVariant;
  matchPrefix?: string;
  hideWhen?: "subscriber" | "nonSubscriber" | "fullMember" | "nonFullMember";
  children?: NavChild[];
};

const podcastChildren: NavChild[] = [
  { label: "All", to: "/podcasts" },
  ...shows.map((show) => ({
    label: show.title,
    to: show.route,
    description: show.cadence,
    paid: show.paid,
  })),
];

const NAV_ITEMS: NavItem[] = [
  {
    variant: "menu",
    label: "Podcasts",
    to: "/podcasts",
    matchPrefix: "/podcasts",
    children: podcastChildren,
  },
  // Visible to everyone — the page itself shows a "Join Ark+" CTA to
  // non-subscribers in place of the members-only Community app links.
  { variant: "text", label: "Community", to: "/community", matchPrefix: "/community" },
  { variant: "text", label: "Newsletters", to: "/newsletters", matchPrefix: "/newsletters" },
  { variant: "text", label: "Book Club", to: "/book-club", matchPrefix: "/book-club" },
  // One landing page to browse membership (/plus); gifting lives in this
  // dropdown rather than as its own tab. On /plus the pricing grid shows only
  // the tier(s) the visitor doesn't already own. Hidden from full-bundle
  // members (they own Ark+ AND Community, so there's nothing left to buy) —
  // the full-member-only "Gift" tab below keeps gifting reachable for them.
  {
    variant: "menu",
    label: "Subscribe",
    to: "/plus",
    hideWhen: "fullMember",
    children: [
      { label: "Membership", to: "/plus" },
      { label: "Gift", to: "/plus/gift" },
    ],
  },
  // Anyone (guest, member, or full member) can buy a gift, but full-bundle
  // members lose the Subscribe menu above — surface Gift as its own tab for
  // them only, so gifting stays in the main nav at every tier.
  {
    variant: "text",
    label: "Gift",
    to: "/plus/gift",
    hideWhen: "nonFullMember",
  },
  {
    variant: "menu",
    label: "About",
    to: "/about",
    matchPrefix: "/about",
    children: [
      { label: "Careers", to: "/careers" },
      { label: "Get in touch", to: "/contact" },
    ],
  },
  // Hidden for now — page still lives at /israel-votes; restore when ready.
  // { variant: "text", label: "Israel Votes", to: "/israel-votes" },
];

// Appended to the nav only for admins (see useSubscriberAuth().isAdmin).
const ADMIN_NAV_ITEM: NavItem = { variant: "text", label: "Admin", to: "/admin" };

// Focus-trap selector for the mobile drawer (mirrors Modal.tsx).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isActive(pathname: string, item: Pick<NavItem, "to" | "matchPrefix" | "children">) {
  if (item.matchPrefix && pathname.startsWith(item.matchPrefix)) return true;
  if (pathname === item.to) return true;
  if (
    item.children?.some(
      (c) =>
        !c.crossLink && (pathname === c.to || pathname.startsWith(`${c.to}/`)),
    )
  ) {
    return true;
  }
  return false;
}

// Nav visibility flags. `isSubscriber` = any paid member (Ark+, Circle, or
// Bundle). `isFullMember` = owns both axes (Ark+ AND Community), so there's
// nothing left to subscribe to — the "Subscribe" tab is hidden for them.
function visibleNavItems(flags: {
  isSubscriber: boolean;
  isFullMember: boolean;
}): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (item.hideWhen === "subscriber") return !flags.isSubscriber;
    if (item.hideWhen === "nonSubscriber") return flags.isSubscriber;
    if (item.hideWhen === "fullMember") return !flags.isFullMember;
    if (item.hideWhen === "nonFullMember") return flags.isFullMember;
    return true;
  });
}

export function PublicMasthead() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Hide-on-scroll: the masthead tucks up out of view when the reader scrolls
  // down (reclaiming its ~96px on the phone) and reappears the instant they
  // scroll back up. The visual hide is gated to mobile — see the header's
  // `max-sm:` transform below.
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);
  const { state, signOut, signIn, isAdmin } = useSubscriberAuth();
  // Any paid tier counts as a subscriber for the nav (drives the mobile CTA and
  // the "Set up your feed" account link).
  const isSubscriber = state.kind === "member" && state.me.tier !== "free";
  // Owns both axes (Ark+ AND Community) — nothing left to buy, so the
  // "Subscribe" menu is hidden (a standalone "Gift" tab replaces it for them).
  const isFullMember =
    state.kind === "member" &&
    state.me.entitlements.arkPlus &&
    state.me.entitlements.circle;
  // The subscribe / conversion CTA, surfaced identically in the top bar and the
  // pulldown. Only meaningful for non-subscribers, and only once auth has
  // resolved (so it never flashes).
  const showSubscribe = !isSubscriber && state.kind !== "loading";
  const navItems = isAdmin
    ? [...visibleNavItems({ isSubscriber, isFullMember }), ADMIN_NAV_ITEM]
    : visibleNavItems({ isSubscriber, isFullMember });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  // Publish masthead height so hash links (e.g. /plus#pricing) scroll clear of
  // the sticky header — paired with --ann-height from AnnouncementBanner.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = headerRef.current;
    if (!el) return;
    const apply = () =>
      root.style.setProperty("--masthead-height", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--masthead-height");
    };
  }, []);

  // Reveal on scroll-up, hide on scroll-down. Any open menu forces the masthead
  // visible — hiding it would yank the open panel (which lives inside <header>)
  // off-screen. rAF-throttled; a small threshold ignores scroll jitter.
  useEffect(() => {
    // While a menu is open the masthead is force-shown at render (see
    // `effectiveHidden`), so there's nothing to track — skip the scroll
    // listener entirely.
    if (mobileOpen || accountOpen) return;
    let ticking = false;
    const threshold = 8;
    const update = () => {
      ticking = false;
      const y = Math.max(0, window.scrollY);
      const delta = y - lastScrollY.current;
      if (Math.abs(delta) < threshold) return;
      // Never hide near the top of the page; only when scrolling down past the
      // masthead's own height.
      const revealZone = headerRef.current?.offsetHeight ?? 96;
      setHidden(y > revealZone && delta > 0);
      lastScrollY.current = y;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    lastScrollY.current = Math.max(0, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [mobileOpen, accountOpen]);

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

  // Mobile drawer: lock background scroll, trap focus inside the panel, close on
  // Escape, and restore focus to the menu button on close (mirrors Modal.tsx).
  useEffect(() => {
    if (!mobileOpen) return;
    const menuButton = menuButtonRef.current;
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        const focusable =
          drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);

    // Focus the first control in the drawer once it's on screen.
    requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevBodyOverflow;
      menuButton?.focus();
    };
  }, [mobileOpen]);

  // An open menu lives inside <header>, so the masthead must stay visible while
  // one is open — otherwise hiding it would yank the panel off-screen. Derive
  // that here rather than forcing state from an effect.
  const effectiveHidden = hidden && !mobileOpen && !accountOpen;

  return (
    <header
      ref={headerRef}
      className={`sticky top-[var(--ann-height,0px)] z-20 border-b border-rule-soft bg-navy-900 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none ${
        effectiveHidden ? "max-sm:-translate-y-full" : "translate-y-0"
      }`}
    >
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

          <div ref={dropdownRef} className="relative">
            {state.kind === "loading" ? (
              <button
                type="button"
                disabled
                aria-label="Loading account state"
                className="hidden min-h-11 items-center border border-rule-strong px-4 opacity-60 sm:inline-flex"
              >
                <Spinner className="inline-block h-3 w-3" />
              </button>
            ) : state.kind === "member" ? (
              <>
                <button
                  type="button"
                  onClick={() => setAccountOpen((v) => !v)}
                  aria-expanded={accountOpen}
                  className="hidden min-h-11 items-center border border-rule-strong px-4 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:inline-flex"
                >
                  Account
                </button>
                {accountOpen ? (
                  <div className="absolute right-0 mt-2 w-64 border border-rule bg-navy-900 p-4 text-[13px] text-fg shadow-xl">
                    <MemberMenu
                      email={state.me.email}
                      isAdmin={isAdmin}
                      isSubscriber={isSubscriber}
                      onSignOut={() => {
                        setAccountOpen(false);
                        signOut();
                      }}
                      onClose={() => setAccountOpen(false)}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="hidden items-center gap-2 sm:flex">
                {/* <button
                  type="button"
                  onClick={() => signIn(undefined, { signup: true })}
                  className="inline-flex min-h-11 items-center border border-cyan bg-cyan px-4 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Sign up
                </button> */}
                <button
                  type="button"
                  onClick={() => signIn()}
                  className="inline-flex min-h-11 items-center border border-rule-strong px-4 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Sign in
                </button>
              </div>
            )}
          </div>

          {/* Persistent subscribe CTA in the collapsed top bar so non-subscribers
              can convert in one tap without opening the (long) pulldown. Hidden
              for paid members and while auth resolves. */}
          {showSubscribe ? (
            <Link
              to="/plus"
              hash="pricing"
              className="inline-flex min-h-11 items-center whitespace-nowrap border border-cyan bg-cyan px-3 font-display text-[11px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:hidden"
            >
              Join Ark+
            </Link>
          ) : null}

          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileOpen(true)}
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
              <path d="M3 6h14" />
              <path d="M3 14h14" />
            </svg>
          </button>
        </nav>
      </div>

      {createPortal(
        <div className="sm:hidden">
          {/* Scrim — dims the page and closes the drawer on tap. */}
          <div
            aria-hidden="true"
            onClick={() => setMobileOpen(false)}
            className={`fixed inset-0 z-[55] bg-navy-900/80 backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none ${
              mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          />
          {/* Right-side drawer. Portaled to <body> so the header's transform
              can't trap its fixed positioning; `inert` when closed keeps its
              links out of the tab order and the a11y tree. */}
          <div
            ref={drawerRef}
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            inert={!mobileOpen}
            className={`fixed inset-y-0 right-0 z-[60] flex w-[min(88vw,360px)] flex-col border-l border-rule bg-navy-900 shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
              mobileOpen ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between border-b border-rule px-6 py-4">
              <span className="eyebrow text-fg-muted">Menu</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="inline-flex min-h-11 min-w-11 items-center justify-center text-fg-strong transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
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
                  <path d="M4 4l12 12M16 4L4 16" />
                </svg>
              </button>
            </div>
          <nav
            aria-label="Primary mobile"
            className="flex flex-1 flex-col overflow-y-auto px-6 py-4"
          >
            {/* Subscribe is the primary action in the pulldown — full-width and
                first, above account/auth, so it's unmissable once the menu is
                open. Sign up/in below are styled as secondary so they don't
                compete. */}
            {showSubscribe ? (
              <Link
                to="/plus"
                hash="pricing"
                onClick={() => setMobileOpen(false)}
                className="mb-3 inline-flex min-h-12 items-center justify-center border border-cyan bg-cyan px-4 font-display text-[14px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Join Ark+
              </Link>
            ) : null}
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
              <div className="mb-3 grid grid-cols-2 gap-2">
                {/* Subscribe is the primary CTA above the fold of this menu, so
                    sign up and sign in render as secondary here. */}
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    signIn(undefined, { signup: true });
                  }}
                  className="inline-flex min-h-11 items-center justify-center border border-rule-strong px-4 font-display text-[13px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan"
                >
                  Sign up
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    signIn();
                  }}
                  className="inline-flex min-h-11 items-center justify-center border border-rule-strong px-4 font-display text-[13px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan"
                >
                  Sign in
                </button>
              </div>
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
                      drawerOpen={mobileOpen}
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
        </div>,
        document.body,
      )}

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
                key={child.hash ? `${child.to}#${child.hash}` : child.to}
                to={child.to}
                hash={child.hash}
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
  drawerOpen,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  pathname: string;
  drawerOpen: boolean;
  onNavigate: () => void;
}) {
  // Submenus start collapsed — the chevron button discloses them; the label
  // itself still navigates to the section's landing page. State resets on
  // every drawer toggle (render-time sync, mirroring NavMenu) so reopening
  // the drawer never restores a stale expansion.
  const [open, setOpen] = useState(false);
  const [syncedDrawerOpen, setSyncedDrawerOpen] = useState(drawerOpen);
  const listId = useId();
  if (syncedDrawerOpen !== drawerOpen) {
    setSyncedDrawerOpen(drawerOpen);
    setOpen(false);
  }
  const children = item.children ?? [];
  return (
    <div className="border-b border-rule-soft py-1 last:border-b-0">
      <div className="flex items-center justify-between">
        <Link
          to={item.to}
          aria-current={active ? "page" : undefined}
          onClick={onNavigate}
          className={`flex min-h-11 flex-1 items-center py-3 text-[14px] transition ${
            active ? "text-cyan" : "text-fg hover:text-fg-strong"
          }`}
        >
          {item.label}
        </Link>
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={listId}
            aria-label={`${open ? "Hide" : "Show"} ${item.label} links`}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
              active ? "text-cyan" : "text-fg-faint"
            }`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="square"
              className={`transition-transform duration-200 motion-reduce:transition-none ${
                open ? "rotate-180" : ""
              }`}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        ) : null}
      </div>
      {open && children.length > 0 ? (
        <ul id={listId} className="mb-2 ml-3 border-l border-rule-soft pl-3">
          {children.map((child) => {
            const childActive =
              pathname === child.to || pathname.startsWith(`${child.to}/`);
            return (
              <li key={child.hash ? `${child.to}#${child.hash}` : child.to}>
                <Link
                  to={child.to}
                  hash={child.hash}
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

function MemberMenu({
  email,
  isAdmin,
  isSubscriber,
  onSignOut,
  onClose,
}: {
  email: string;
  isAdmin: boolean;
  isSubscriber: boolean;
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
      {isSubscriber ? (
        <Link
          to="/setup"
          onClick={onClose}
          className="inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-3 text-center text-[12px] font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Set up your feed
        </Link>
      ) : null}
      {isAdmin ? (
        <Link
          to="/admin"
          onClick={onClose}
          className="inline-flex min-h-11 w-full items-center justify-center border border-rule-strong px-3 text-center text-[12px] font-semibold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Admin
        </Link>
      ) : null}
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
