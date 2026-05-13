import type { ReactNode } from "react";

export function PageShell({
  breadcrumbs,
  eyebrow,
  title,
  lede,
  children,
}: {
  breadcrumbs?: ReactNode;
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-10 pb-16 sm:px-10 sm:pt-16">
          {breadcrumbs ? <div className="mb-6">{breadcrumbs}</div> : null}
          {eyebrow ? (
            <p className="inside-tab text-[12px]">{eyebrow}</p>
          ) : null}
          <h1 className="mt-8 max-w-3xl text-fg-strong">
            <span className="display-upright block text-[clamp(2rem,5vw,3.6rem)] leading-[1.05]">
              {title}
            </span>
          </h1>
          {lede ? (
            <p className="mt-6 max-w-2xl text-[15px] leading-[1.6] text-fg">
              {lede}
            </p>
          ) : null}
        </div>
      </section>
      {children}
    </main>
  );
}

export function PlaceholderSection({
  title,
  body,
}: {
  title: string;
  body?: string;
}) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          {title}
        </div>
        <p className="mt-6 max-w-2xl text-[14px] leading-[1.7] text-fg-muted">
          {body ?? "Content for this section is on the way."}
        </p>
      </div>
    </section>
  );
}
