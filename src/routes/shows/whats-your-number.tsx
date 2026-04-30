import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/shows/whats-your-number")({
  component: () => <ShowPage slug="whats-your-number" />,
});
