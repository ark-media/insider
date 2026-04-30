import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/shows/call-me-back")({
  component: () => <ShowPage slug="call-me-back" />,
});
