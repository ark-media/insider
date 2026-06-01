import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// A full-page status state (404, not authorized, …). It renders inside the root
// layout's <Outlet />, so it relies on the surrounding masthead/footer for
// chrome and only owns the centered message column.
export function StatusPage({
  eyebrow,
  title,
  message,
  actions,
}: {
  eyebrow: string;
  title: string;
  message: ReactNode;
  // Defaults to a single "Back to homepage" link when omitted.
  actions?: ReactNode;
}) {
  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-16 sm:px-10 sm:pt-16">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="mt-8 max-w-3xl font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.1] text-fg-strong">
            {title}
          </h1>
          <p className="mt-6 max-w-2xl text-body-lg">
            {message}
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            {actions ? actions : <HomeButton />}
          </div>
        </div>
      </section>
    </main>
  );
}

// Outlined link back to the homepage, matching the site's secondary button.
export function HomeButton() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      <span aria-hidden="true">←</span>
      Back to homepage
    </Link>
  );
}
