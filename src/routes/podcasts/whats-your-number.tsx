import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/podcasts/whats-your-number")({
  component: () => <ShowPage slug="whats-your-number" />,
});
