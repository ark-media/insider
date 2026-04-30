import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PlaceholderSection } from "../components/PageShell";

export const Route = createFileRoute("/israel-votes")({
  component: IsraelVotesPage,
});

function IsraelVotesPage() {
  return (
    <PageShell
      eyebrow="Israel Votes"
      title="Tracking the next Israeli election."
      lede="Polls, parties, and the politics behind the headlines — explained the way Call Me Back listeners expect."
    >
      <PlaceholderSection
        title="The state of the race"
        body="A running summary of polling and coalition math."
      />
      <PlaceholderSection
        title="Parties &amp; players"
        body="Background on the parties, leaders, and constituencies."
      />
      <PlaceholderSection
        title="Recent coverage"
        body="Episodes, newsletters, and dispatches from the Ark Media network."
      />
    </PageShell>
  );
}
