import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ListenerQuestionShow } from "../../data/shows";

// Short links for show notes: /ask/cpp and /ask/cmb open the contact form with
// "Listener questions" and that show already picked. The long names work too.
// An unknown show still lands on the question form, just without a show picked.
const askLinks: Record<string, ListenerQuestionShow> = {
  cpp: "chosen-people-problems",
  "chosen-people-problems": "chosen-people-problems",
  cmb: "inside-call-me-back",
  "call-me-back-ark-plus": "inside-call-me-back",
};

export const Route = createFileRoute("/ask/$show")({
  beforeLoad: ({ params }) => {
    const show = askLinks[params.show.toLowerCase()];
    throw redirect({
      to: "/contact",
      search: show ? { topic: "questions", show } : { topic: "questions" },
      replace: true,
    });
  },
});
