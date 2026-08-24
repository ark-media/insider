import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/LegalPage";
import { PRIVACY } from "../data/legal";

export const Route = createFileRoute("/privacy")({
  component: () => <LegalPage doc={PRIVACY} />,
});
