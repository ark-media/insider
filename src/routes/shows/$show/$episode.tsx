import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect: /shows/$show/$episode → /podcasts/$show/$episode.
export const Route = createFileRoute("/shows/$show/$episode")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/podcasts/$show/$episode",
      params: { show: params.show, episode: params.episode },
      replace: true,
    });
  },
});
