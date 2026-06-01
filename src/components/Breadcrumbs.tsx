import { Link } from "@tanstack/react-router";

export type BreadcrumbItem = {
  label: string;
  to?: string;
  params?: Record<string, string>;
};

export function Breadcrumbs({
  items,
  className = "",
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className={`text-[13px] font-semibold uppercase tracking-[0.22em] ${className}`}
    >
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-x-2">
              {i > 0 ? (
                <span aria-hidden="true" className="text-fg-faint">
                  ›
                </span>
              ) : null}
              {isLast || !item.to ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={isLast ? "text-fg-muted" : "text-cyan"}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to as never}
                  params={item.params as never}
                  className="text-cyan transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
