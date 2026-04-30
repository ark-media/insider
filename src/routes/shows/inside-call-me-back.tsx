import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/shows/inside-call-me-back")({
  component: () => <ShowPage slug="inside-call-me-back" />,
});
