import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect: /shows was renamed to /podcasts. Kept here so old links
// (podcatcher RSS bios, social posts, search-engine results) don't 404.
export const Route = createFileRoute("/shows/")({
  beforeLoad: () => {
    throw redirect({ to: "/podcasts", replace: true });
  },
});
