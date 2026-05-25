import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { StatusPage } from "./components/StatusPage";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Renders for unmatched URLs and any route that throws notFound().
  defaultNotFoundComponent: () => (
    <StatusPage
      eyebrow="404"
      title="We couldn't find that page."
      message="The link may be broken, or the page may have moved. Let's get you back on track."
    />
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
