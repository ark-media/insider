import type { ReactNode } from "react";

export function PageShell({
  breadcrumbs,
  brand,
  title,
  titleSrOnly = false,
  lede,
  aside,
  heroClassName,
  children,
}: {
  breadcrumbs?: ReactNode;
  /**
   * A product lockup shown above the h1 — for pages that belong to a sub-brand
   * with its own logo (the Fold). Unlike {@link titleSrOnly} this keeps the
   * headline: the logo says *which product*, the h1 still says what the page is.
   */
  brand?: ReactNode;
  title: ReactNode;
  /**
   * Keep the h1 in the document (SEO + screen readers) but drop it from the
   * visual layout. For pages whose title only restates the masthead logo, where
   * showing it twice reads as repetition.
   */
  titleSrOnly?: boolean;
  lede?: ReactNode;
  // Optional content pinned to the right of the hero on desktop (e.g. app
  // download badges). Stacks below the title/lede on narrow screens.
  aside?: ReactNode;
  /**
   * Extra classes for the hero <section> — the hook for a page's brand
   * backdrop (`fold-bg grain-overlay overflow-hidden`), mirroring how
   * ShowPage applies showAtmosphere(). Omit it and the hero stays transparent
   * over the page background.
   */
  heroClassName?: string;
  children?: ReactNode;
}) {
  return (
    <main className="relative">
      <section className={`section-hero relative ${heroClassName ?? ""}`}>
        <div className="page-gutter relative pt-8 pb-10 sm:pt-12">
          {breadcrumbs ? <div className="mb-6">{breadcrumbs}</div> : null}
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
            <div className="min-w-0">
              {brand ? <div className="mt-8">{brand}</div> : null}
              {titleSrOnly ? (
                <h1 className="sr-only">{title}</h1>
              ) : (
                <h1 className={`max-w-3xl ${brand ? "mt-6" : "mt-8"}`}>
                  <span className="display-upright block text-h1">{title}</span>
                </h1>
              )}
              {lede ? (
                <p
                  className={`max-w-2xl text-body-lg ${
                    titleSrOnly ? "mt-8" : "mt-6"
                  }`}
                >
                  {lede}
                </p>
              ) : null}
            </div>
            {aside ? <div className="shrink-0">{aside}</div> : null}
          </div>
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
