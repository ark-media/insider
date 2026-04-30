import { createFileRoute } from "@tanstack/react-router";
import { ShowPage } from "../../components/ShowPage";

export const Route = createFileRoute("/shows/ark-news-daily")({
  component: () => <ShowPage slug="ark-news-daily" />,
});
