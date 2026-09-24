import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/plus/call-me-back-ark-plus")({
  component: () => <ShowPage slug="inside-call-me-back" />,
});
