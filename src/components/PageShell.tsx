import type { ReactNode } from "react";

export function PageShell({
  breadcrumbs,
  title,
  lede,
  children,
}: {
  breadcrumbs?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-8 pb-10 sm:pt-12">
          {breadcrumbs ? <div className="mb-6">{breadcrumbs}</div> : null}
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
      <div className="page-section">
        <div className="label text-cyan">{title}</div>
        <p className="mt-6 max-w-2xl text-body-sm">
          {body ?? "Content for this section is on the way."}
        </p>
      </div>
    </section>
  );
}
