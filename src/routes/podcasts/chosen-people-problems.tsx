import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/podcasts/chosen-people-problems")({
  component: () => <ShowPage slug="chosen-people-problems" />,
});
