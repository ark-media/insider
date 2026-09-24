import { createFileRoute, redirect } from "@tanstack/react-router";

// Redirect: /shows/$show → /podcasts/$show. Call me Back | Ark+ has no show
// page, so it goes to the membership page instead. Every other slug is
// forwarded to /podcasts/<slug> — including unknown slugs, which then 404 there.
export const Route = createFileRoute("/shows/$show")({
  beforeLoad: ({ params }) => {
    const dest =
      params.show === "call-me-back-plus"
        ? "/plus"
        : `/podcasts/${params.show}`;
    throw redirect({ href: dest, replace: true });
  },
});
