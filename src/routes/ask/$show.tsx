import { createFileRoute, redirect } from "@tanstack/react-router";
import { isShowSlug, type ShowSlug } from "../../data/shows";

// Short links for show notes: /ask/cpp, /ask/cpp-plus and so on open the
// contact form with "Listener questions" and that show already picked. A
// show's full slug (/ask/chosen-people-problems) works too. Anything else
// still lands on the question form, just without a show picked.
const shortLinks: Record<string, ShowSlug> = {
  cmb: "call-me-back",
  "cmb-plus": "call-me-back-plus",
  fhs: "for-heavens-sake",
  "fhs-plus": "for-heavens-sake-plus",
  and: "ark-news-daily",
  "and-plus": "ark-news-daily-plus",
  cpp: "chosen-people-problems",
  "cpp-plus": "chosen-people-problems-plus",
};

export const Route = createFileRoute("/ask/$show")({
  beforeLoad: ({ params }) => {
    const key = params.show.toLowerCase();
    const show = shortLinks[key] ?? (isShowSlug(key) ? key : undefined);
    throw redirect({
      to: "/contact",
      search: show ? { topic: "questions", show } : { topic: "questions" },
      replace: true,
    });
  },
});
