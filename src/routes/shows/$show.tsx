import { createFileRoute, redirect } from "@tanstack/react-router";

// Redirect: /shows/$show → /podcasts/$show. `inside-call-me-back` lives under
// /plus, so it gets its own destination. Every other slug is forwarded to
// /podcasts/<slug> — including unknown slugs, which then 404 there.
export const Route = createFileRoute("/shows/$show")({
  beforeLoad: ({ params }) => {
    const dest =
      params.show === "inside-call-me-back"
        ? "/plus/inside-call-me-back"
        : `/podcasts/${params.show}`;
    throw redirect({ href: dest, replace: true });
  },
});
