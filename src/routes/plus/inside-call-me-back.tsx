import { createFileRoute, redirect } from "@tanstack/react-router";

// Redirect: the members' show (now Call Me Back Ark+) used to have its own page
// here. It no longer has one, so old links and bookmarks land on the membership
// page that sells it.
export const Route = createFileRoute("/plus/inside-call-me-back")({
  beforeLoad: () => {
    throw redirect({ href: "/plus", replace: true });
  },
});
