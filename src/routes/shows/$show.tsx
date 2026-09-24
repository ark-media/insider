import { createFileRoute, redirect } from "@tanstack/react-router";

// Redirect: /shows/$show → /podcasts/$show. Call Me Back Ark+ lives under
// /plus, so it (and its old slug, inside-call-me-back) gets its own
// destination. Every other slug is forwarded to /podcasts/<slug> — including
// unknown slugs, which then 404 there.
export const Route = createFileRoute("/shows/$show")({
  beforeLoad: ({ params }) => {
    const dest =
      params.show === "call-me-back-plus" ||
      params.show === "inside-call-me-back"
        ? "/plus/call-me-back-plus"
        : `/podcasts/${params.show}`;
    throw redirect({ href: dest, replace: true });
  },
});
