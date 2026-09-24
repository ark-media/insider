import { createFileRoute, redirect } from "@tanstack/react-router";

// Redirect: the show's page before it was renamed Call Me Back Ark+. Kept so
// old links and bookmarks still land on the show.
export const Route = createFileRoute("/plus/inside-call-me-back")({
  beforeLoad: () => {
    throw redirect({ href: "/plus/call-me-back-ark-plus", replace: true });
  },
});
