import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect: /newsletters/ark-daily/$post → /newsletters/$post
export const Route = createFileRoute("/newsletters/$slug/$post")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/newsletters/$post",
      params: { post: params.post },
      replace: true,
    });
  },
});
