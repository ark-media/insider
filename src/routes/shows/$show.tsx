import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect: /shows/$show → /podcasts/$show. `inside-call-me-back` moved
// out of /shows entirely and lives under /plus, so it gets its own
// destination. Every other slug is forwarded through to its /podcasts/<slug>
// equivalent — including unknown slugs, which then 404 against the new
// hierarchy rather than the old one.
export const Route = createFileRoute("/shows/$show")({
  beforeLoad: ({ params }) => {
    const dest =
      params.show === "inside-call-me-back"
        ? "/plus/inside-call-me-back"
        : `/podcasts/${params.show}`;
    throw redirect({ href: dest, replace: true });
  },
});
