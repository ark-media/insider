import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AdminGuard } from "./AdminGuard";

type Tab = "home" | "announcements" | "promos" | "discuss-threads";

const TABS: { id: Tab; label: string; to: string }[] = [
  { id: "home", label: "Overview", to: "/admin" },
  { id: "announcements", label: "Announcements", to: "/admin/announcements" },
  { id: "promos", label: "Promo codes", to: "/admin/promos" },
  { id: "discuss-threads", label: "Discuss threads", to: "/admin/discuss-threads" },
];

// Consistent chrome for every back-office page: the admin gate plus a title and
// tab bar. Pages pass their own content as children.
export function AdminShell({
  active,
  title,
  children,
}: {
  active: Tab;
  title: string;
  children: ReactNode;
}) {
  return (
    <AdminGuard>
      <div className="mx-auto max-w-[1100px] px-6 py-12 sm:px-10">
        <p className="eyebrow">Back office</p>
        <h1 className="mt-2 font-display text-[clamp(1.8rem,3vw,2.6rem)] leading-tight text-fg-strong">
          {title}
        </h1>

        <nav aria-label="Back office" className="mt-6 flex flex-wrap gap-2">
          {TABS.map((tab) => {
            const isActive = tab.id === active;
            return (
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex min-h-10 items-center border px-4 font-display text-[12px] font-bold uppercase tracking-button transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
                  isActive
                    ? "border-cyan bg-cyan text-navy"
                    : "border-rule-strong text-fg-strong hover:border-cyan hover:text-cyan"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-10">{children}</div>
      </div>
    </AdminGuard>
  );
}
