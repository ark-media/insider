import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/podcasts/for-heavens-sake")({
  component: () => <ShowPage slug="for-heavens-sake" />,
});
