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
      <section className="section-hero relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-10 pb-16 sm:px-10 sm:pt-16">
          {breadcrumbs ? <div className="mb-6">{breadcrumbs}</div> : null}
          {eyebrow ? (
            <p className="inside-tab text-xs">{eyebrow}</p>
          ) : null}
          <h1 className="mt-8 max-w-3xl">
            <span className="display-upright block text-h1">{title}</span>
          </h1>
          {lede ? (
            <p className="mt-6 max-w-2xl text-body-lg">{lede}</p>
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
    <section>
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="label text-cyan">{title}</div>
        <p className="mt-6 max-w-2xl text-body-sm">
          {body ?? "Content for this section is on the way."}
        </p>
      </div>
    </section>
  );
}
