import { Link } from "@tanstack/react-router";

// The account section's tab bar, sitting under the greeting in the /account
// layout.
//
// Tabs are real routes, not component state, so every one of them is a link a
// member can bookmark, share with support, or land on from an email. The bar
// only lists what the member can actually reach: Podcasts needs the Ark+ axis
// and the Fold needs the Circle axis, so a free reader sees Membership and
// Settings alone rather than two tabs that redirect them away.

type TabPath =
  | "/account"
  | "/account/podcast-feed"
  | "/account/fold"
  | "/account/settings";

type Tab = { to: TabPath; label: string };

export function AccountTabs({
  pathname,
  entitlements,
}: {
  pathname: string;
  entitlements: { arkPlus: boolean; circle: boolean };
}) {
  const tabs: Tab[] = [
    { to: "/account", label: "Membership" },
    ...(entitlements.arkPlus
      ? [{ to: "/account/podcast-feed" as const, label: "Podcasts" }]
      : []),
    ...(entitlements.circle
      ? [{ to: "/account/fold" as const, label: "The Fold" }]
      : []),
    { to: "/account/settings", label: "Settings" },
  ];

  return (
    <nav aria-label="Account sections" className="border-b border-rule">
      <div className="page-gutter">
        {/* Tighter gaps on narrow screens so all four tabs fit a phone without
            scrolling. It stays scrollable rather than wrapping as a fallback:
            a second row of tabs reads as a second nav, and the tab bar is the
            one piece of chrome that has to stay recognisable as one strip. */}
        <ul className="-mb-px flex gap-5 overflow-x-auto sm:gap-8">
          {tabs.map((tab) => {
            const active = isActive(pathname, tab.to);
            return (
              <li key={tab.to} className="shrink-0">
                <Link
                  to={tab.to}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-12 items-center border-b-2 pb-3 pt-2 text-body-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                    active
                      ? "border-cyan font-semibold text-fg-strong"
                      : "border-transparent text-fg-muted hover:border-rule-strong hover:text-fg"
                  }`}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

// /account/billing is the detail page behind "Manage billing", not a tab of its
// own, so it keeps Membership selected rather than leaving the bar with nothing
// marked current.
function isActive(pathname: string, to: TabPath): boolean {
  const path = pathname.replace(/\/+$/, "") || "/account";
  if (to === "/account") return path === "/account" || path === "/account/billing";
  return path === to;
}
