import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/plus/call-me-back-plus")({
  component: () => <ShowPage slug="call-me-back-plus" />,
});
