import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/LegalPage";
import { TERMS } from "../data/legal";

export const Route = createFileRoute("/terms")({
  component: () => <LegalPage doc={TERMS} />,
});
